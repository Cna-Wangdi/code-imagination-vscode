import ts from 'typescript';
import type { VisualEdge, VisualModel, VisualNode } from './model';
import {
  baseName,
  capitalize,
  containingClass,
  containsOffset,
  findCallableAt,
  getAwaitLabel,
  getCallName,
  getJsxElementName,
  hasAsyncModifier,
  hasUnclosedBlock,
  locationLength,
  nodeLength,
  normalizePath,
  resolveCalledDeclaration,
  sameCallable,
  unresolvedCallMatches,
  unwrapAwaitedCall
} from './analyzer/ast';
import {
  decoratorArgument,
  getAngularInlineTemplate,
  getAngularProviders,
  getAngularTemplateUrl,
  hasDecorator,
  isAngularComponent,
  isAngularLifecycleHook,
  referencesAngularProperty
} from './analyzer/angular';
import { parseAngularTemplateElements, textLocation } from './analyzer/angularTemplate';
import { importResolutionPrefix } from './analysisMode';

interface StateBinding {
  value: string;
  setter: string;
  nodeId: string;
  setterNodeId: string;
  mode: 'state' | 'reducer' | 'signal-set' | 'signal-update' | 'form';
  reducerName?: string;
}

interface FunctionInfo {
  node: ts.FunctionLikeDeclaration;
  name: string;
  id: string;
  classNode?: ts.ClassDeclaration;
}

interface EventBinding {
  location: VisualNode['location'];
  functionId: string;
  label: string;
  detail: string;
}

interface FlowEndpoint {
  id: string;
  label?: string;
}

interface FlowContext {
  catchTargetId?: string;
}

interface OutputBinding {
  name: string;
  nodeId: string;
  implementation: 'EventEmitter' | 'output';
}

interface InjectionBinding {
  property: string;
  service: string;
  nodeId: string;
}

interface ResourceBinding {
  name: string;
  nodeId: string;
  type: 'resource' | 'rxResource';
}

export interface AnalyzeOptions {
  preferredFunction?: {
    name: string;
    start: number;
  };
  expandedNodeIds?: readonly string[];
  expandedUsages?: readonly { targetId: string; sourceId: string }[];
  externalTemplates?: readonly { fileName: string; text: string }[];
  entireFile?: boolean;
}

export function analyzeCode(
  text: string,
  fileName: string,
  languageId: string,
  cursorOffset: number,
  program?: ts.Program,
  options: AnalyzeOptions = {}
): VisualModel {
  const scriptKind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX
    : fileName.endsWith('.jsx') ? ts.ScriptKind.JSX
    : fileName.endsWith('.js') ? ts.ScriptKind.JS
    : ts.ScriptKind.TS;
  const source = program
    ? program.getSourceFiles().find((candidate) => normalizePath(candidate.fileName) === normalizePath(fileName))
    : ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, scriptKind);
  if (!source) {
    return { fileName, languageId, nodes: [], edges: [], message: 'The active file could not be analyzed.' };
  }

  const checker = program?.getTypeChecker();
  const importedBindings = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause) continue;
    if (statement.importClause.name) importedBindings.add(statement.importClause.name.text);
    const bindings = statement.importClause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) importedBindings.add(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) importedBindings.add(element.name.text);
    }
  }
  const nodes: VisualNode[] = [];
  const edges: VisualEdge[] = [];
  const states = new Map<string, StateBinding>();
  const calledSetters = new Set<string>();
  const outputs = new Map<string, OutputBinding>();
  const injections = new Map<string, InjectionBinding>();
  const resources = new Map<string, ResourceBinding>();
  const angularReactiveSources: Array<{ name: string; nodeId: string }> = [];
  const reactiveAngularNodes: Array<{ node: ts.PropertyDeclaration; nodeId: string; type: 'computed' | 'effect' }> = [];

  const angularComponents = new Set<ts.ClassDeclaration>();
  const angularClasses = new Set<ts.ClassDeclaration>();
  function collectAngularComponents(node: ts.Node): void {
    if (ts.isClassDeclaration(node)) {
      if (isAngularComponent(node)) angularComponents.add(node);
      if (isAngularComponent(node) || hasDecorator(node, 'Directive') || hasDecorator(node, 'Pipe') || hasDecorator(node, 'Injectable')) angularClasses.add(node);
    }
    ts.forEachChild(node, collectAngularComponents);
  }
  collectAngularComponents(source);

  const location = (node: ts.Node) => {
    const nodeSource = node.getSourceFile();
    const start = node.getStart(nodeSource);
    return {
      fileName: nodeSource.fileName,
      start,
      end: node.getEnd(),
      line: nodeSource.getLineAndCharacterOfPosition(start).line
    };
  };
  const addNode = (node: VisualNode) => {
    const index = nodes.findIndex((existing) => existing.id === node.id);
    if (index === -1) nodes.push(node);
    else nodes[index] = { ...nodes[index], ...node };
  };
  const addEdge = (edge: VisualEdge) => {
    if (!edges.some((existing) => existing.id === edge.id)) edges.push(edge);
  };
  const connect = (incoming: readonly FlowEndpoint[], target: string, label?: string) => {
    for (const endpoint of incoming) {
      if (endpoint.id === target) continue;
      const edgeLabel = endpoint.label ?? label;
      addEdge({
        id: `${endpoint.id}->${target}:${edgeLabel ?? 'flow'}`,
        source: endpoint.id,
        target,
        label: edgeLabel
      });
    }
  };

  function collectState(node: ts.Node): void {
    if (ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.initializer
      && ts.isCallExpression(node.initializer)
      && ['createSelector', 'createReducer'].includes(getCallName(node.initializer.expression))) {
      const factory = getCallName(node.initializer.expression);
      addNode({
        id: `state:ngrx:${factory}:${node.name.text}:${node.pos}`,
        kind: factory === 'createSelector' ? 'state' : 'config',
        label: node.name.text,
        detail: factory === 'createSelector' ? 'NgRx memoized selector' : 'NgRx reducer',
        location: location(node)
      });
    }
    if (ts.isCallExpression(node)) {
      const callName = getCallName(node.expression);
      if (['afterNextRender', 'afterRenderEffect'].includes(callName) && containingClass(node) && angularClasses.has(containingClass(node)!)) {
        addNode({
          id: `event:render-hook:${callName}:${node.pos}`,
          kind: 'event',
          label: `${callName}()` ,
          detail: callName === 'afterNextRender' ? 'Runs after the next client render' : 'Runs a reactive post-render effect',
          location: location(node)
        });
      }
      if (callName === 'provideClientHydration') {
        addNode({ id: `config:hydration:${node.pos}`, kind: 'config', label: 'Client hydration', detail: 'Enables Angular client hydration', location: location(node) });
      }
    }
    if (ts.isParameter(node)
      && ts.isIdentifier(node.name)
      && ts.isConstructorDeclaration(node.parent)
      && ts.isClassDeclaration(node.parent.parent)
      && angularClasses.has(node.parent.parent)
      && node.type
      && node.modifiers?.some((modifier) => [ts.SyntaxKind.PrivateKeyword, ts.SyntaxKind.PublicKeyword, ts.SyntaxKind.ProtectedKeyword, ts.SyntaxKind.ReadonlyKeyword].includes(modifier.kind))) {
      const property = node.name.text;
      const service = node.type.getText(source);
      const nodeId = `config:constructor-inject:${property}:${node.pos}`;
      const binding: InjectionBinding = { property, service, nodeId };
      injections.set(`this.${property}`, binding);
      injections.set(property, binding);
      addNode({ id: nodeId, kind: 'config', label: `${property}: ${service}`, detail: 'Constructor-injected Angular service', location: location(node) });
    }
    if (ts.isPropertyDeclaration(node)
      && ts.isIdentifier(node.name)
      && ts.isClassDeclaration(node.parent)
      && angularClasses.has(node.parent)) {
      const name = node.name.text;
      const initializerCall = node.initializer && ts.isCallExpression(node.initializer) ? node.initializer : undefined;
      const initializerName = initializerCall ? getCallName(initializerCall.expression) : undefined;
      const initializerFactory = initializerCall && ts.isPropertyAccessExpression(initializerCall.expression)
        && ts.isIdentifier(initializerCall.expression.expression)
        ? initializerCall.expression.expression.text
        : initializerName;
      if (hasDecorator(node, 'ViewChild') || hasDecorator(node, 'ViewChildren')) {
        addNode({
          id: `config:view-query:${name}:${node.pos}`,
          kind: 'config',
          label: name,
          detail: hasDecorator(node, 'ViewChildren') ? 'Angular ViewChildren query' : 'Angular ViewChild query',
          location: location(node)
        });
      }
      if (hasDecorator(node, 'HostBinding')) {
        const hostProperty = decoratorArgument(node, 'HostBinding') ?? name;
        addNode({
          id: `config:host-binding:${name}:${node.pos}`,
          kind: 'config',
          label: `@HostBinding ${hostProperty}`,
          detail: `Binds ${name} to the host element`,
          location: location(node)
        });
      }
      if (hasDecorator(node, 'Input') || initializerFactory === 'input') {
        const inputNodeId = `state:input:${name}:${node.pos}`;
        addNode({
          id: inputNodeId,
          kind: 'state',
          label: name,
          detail: initializerFactory === 'input' ? 'Angular signal input' : 'Angular component input',
          location: location(node)
        });
        angularReactiveSources.push({ name, nodeId: inputNodeId });
      }
      const eventEmitter = node.initializer && ts.isNewExpression(node.initializer)
        && getCallName(node.initializer.expression) === 'EventEmitter';
      if (hasDecorator(node, 'Output') || initializerFactory === 'output' || eventEmitter) {
        const nodeId = `event:output:${name}:${node.pos}`;
        const binding: OutputBinding = { name, nodeId, implementation: eventEmitter ? 'EventEmitter' : 'output' };
        outputs.set(`this.${name}.emit`, binding);
        outputs.set(`${name}.emit`, binding);
        addNode({ id: nodeId, kind: 'event', label: `${name} output`, detail: `Angular ${binding.implementation}`, location: location(node) });
      }
      if (initializerName === 'inject' && initializerCall) {
        const service = initializerCall.arguments[0]?.getText(source) ?? 'service';
        const nodeId = `config:inject:${name}:${node.pos}`;
        const binding: InjectionBinding = { property: name, service, nodeId };
        injections.set(`this.${name}`, binding);
        injections.set(name, binding);
        addNode({ id: nodeId, kind: 'config', label: `${name}: ${service}`, detail: 'Injected Angular service', location: location(node) });
      }
      if (initializerName === 'computed' || initializerName === 'effect' || initializerName === 'createEffect') {
        const reactiveType = initializerName === 'computed' ? 'computed' : 'effect';
        const nodeId = `${initializerName}:${name}:${node.pos}`;
        addNode({
          id: nodeId,
          kind: initializerName === 'computed' ? 'state' : initializerName === 'createEffect' ? 'async' : 'call',
          label: initializerName === 'computed' ? name : `${name} effect`,
          detail: initializerName === 'computed'
            ? 'Computed Angular signal'
            : initializerName === 'createEffect'
              ? 'NgRx effect reacts to actions'
              : 'Angular effect reacts to signal changes',
          location: location(node)
        });
        reactiveAngularNodes.push({ node, nodeId, type: reactiveType });
      }
      if ((initializerName === 'resource' || initializerName === 'rxResource') && initializerCall) {
        const nodeId = `async:${initializerName}:${name}:${node.pos}`;
        const binding: ResourceBinding = { name, nodeId, type: initializerName };
        resources.set(`this.${name}.reload`, binding);
        resources.set(`${name}.reload`, binding);
        addNode({
          id: nodeId,
          kind: 'async',
          label: name,
          detail: initializerName === 'rxResource' ? 'Angular RxJS-backed resource' : 'Angular async resource',
          location: location(node)
        });
      }
      const formType = node.initializer && ts.isNewExpression(node.initializer)
        ? getCallName(node.initializer.expression)
        : initializerCall && ts.isPropertyAccessExpression(initializerCall.expression)
          && initializerCall.expression.name.text === 'group'
          ? 'FormGroup'
          : undefined;
      if (formType && ['FormControl', 'FormGroup', 'FormArray'].includes(formType)) {
        const stateId = `state:form:${name}:${node.pos}`;
        addNode({ id: stateId, kind: 'state', label: name, detail: `Angular reactive ${formType}`, location: location(node) });
        for (const operation of ['setValue', 'patchValue', 'reset'] as const) {
          const setterNodeId = `setter:form:${name}.${operation}:${node.pos}`;
          const binding: StateBinding = { value: name, setter: `this.${name}.${operation}`, nodeId: stateId, setterNodeId, mode: 'form' };
          states.set(`this.${name}.${operation}`, binding);
          states.set(`${name}.${operation}`, binding);
          addNode({ id: setterNodeId, kind: 'setter', label: `${name}.${operation}(…)`, detail: `Updates reactive form ${name}`, location: location(node) });
          addEdge({ id: `${setterNodeId}->${stateId}`, source: setterNodeId, target: stateId, label: 'updates' });
        }
      }
    }
    if (ts.isPropertyDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.initializer
      && ts.isCallExpression(node.initializer)
      && ['signal', 'linkedSignal'].includes(getCallName(node.initializer.expression))
      && ts.isClassDeclaration(node.parent)
      && angularClasses.has(node.parent)) {
      const value = node.name.text;
      const stateId = `state:signal:${value}:${node.pos}`;
      addNode({
        id: stateId,
        kind: 'state',
        label: value,
        detail: getCallName(node.initializer.expression) === 'linkedSignal'
          ? 'Angular linked signal derives and remains writable'
          : `Angular signal initial value: ${node.initializer.arguments[0]?.getText(source) ?? 'undefined'}`,
        location: location(node)
      });
      angularReactiveSources.push({ name: value, nodeId: stateId });
      for (const operation of ['set', 'update'] as const) {
        const setterNodeId = `setter:signal:${value}.${operation}:${node.pos}`;
        const binding: StateBinding = {
          value,
          setter: `this.${value}.${operation}`,
          nodeId: stateId,
          setterNodeId,
          mode: operation === 'set' ? 'signal-set' : 'signal-update'
        };
        states.set(`this.${value}.${operation}`, binding);
        states.set(`${value}.${operation}`, binding);
        addNode({
          id: setterNodeId,
          kind: 'setter',
          label: `${value}.${operation}(…)`,
          detail: operation === 'set' ? `Sets ${value}` : `Updates ${value} from its current value`,
          location: location(node)
        });
        addEdge({ id: `${setterNodeId}->${stateId}`, source: setterNodeId, target: stateId, label: 'updates' });
      }
    }
    if (ts.isVariableDeclaration(node)
      && ts.isArrayBindingPattern(node.name)
      && node.name.elements.length >= 2
      && node.initializer
      && ts.isCallExpression(node.initializer)) {
      const hookName = getCallName(node.initializer.expression);
      if (hookName !== 'useState' && hookName !== 'useReducer') {
        ts.forEachChild(node, collectState);
        return;
      }
      const valueElement = node.name.elements[0];
      const setterElement = node.name.elements[1];
      if (ts.isOmittedExpression(valueElement) || ts.isOmittedExpression(setterElement)) return;
      const value = valueElement.name.getText(source);
      const setter = setterElement.name.getText(source);
      const mode = hookName === 'useReducer' ? 'reducer' : 'state';
      const reducerName = mode === 'reducer' ? node.initializer.arguments[0]?.getText(source) : undefined;
      const initialIndex = mode === 'reducer' ? 1 : 0;
      const stateId = `state:${value}:${node.pos}`;
      const setterId = `setter:${setter}:${node.pos}`;
      states.set(setter, { value, setter, nodeId: stateId, setterNodeId: setterId, mode, reducerName });
      addNode({
        id: stateId,
        kind: 'state',
        label: value,
        detail: `${mode === 'reducer' ? 'Reducer state' : 'Initial value'}: ${node.initializer.arguments[initialIndex]?.getText(source) ?? 'undefined'}`,
        location: location(node)
      });
      addNode({
        id: setterId,
        kind: 'setter',
        label: `${setter}(…)`,
        detail: mode === 'reducer' ? `Dispatches to ${reducerName ?? 'reducer'}` : `Updates ${value}`,
        location: location(node)
      });
      addEdge({
        id: `${setterId}->${stateId}`,
        source: setterId,
        target: stateId,
        label: mode === 'reducer' ? 'reduces' : 'updates'
      });
    }
    ts.forEachChild(node, collectState);
  }
  collectState(source);

  for (const component of angularComponents) {
    for (const provider of getAngularProviders(component)) {
      const providerText = provider.getText(source).replace(/\s+/g, ' ').trim();
      addNode({
        id: `config:provider:${provider.getStart(source)}`,
        kind: 'config',
        label: providerText.length > 45 ? `${providerText.slice(0, 44)}…` : providerText,
        detail: 'Angular component provider',
        location: location(provider)
      });
    }
  }

  for (const reactive of reactiveAngularNodes) {
    for (const state of angularReactiveSources) {
      if (referencesAngularProperty(reactive.node.initializer, state.name)) {
        addEdge({
          id: `${state.nodeId}->${reactive.nodeId}:${reactive.type}`,
          source: state.nodeId,
          target: reactive.nodeId,
          label: reactive.type === 'computed' ? 'derives' : 'triggers'
        });
      }
    }
  }

  const functions: FunctionInfo[] = [];
  function collectFunctions(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node) && node.name) {
      functions.push({ node, name: node.name.text, id: `function:${node.name.text}:${node.pos}` });
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
      && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
      functions.push({ node: node.initializer, name: node.name.text, id: `function:${node.name.text}:${node.pos}` });
    } else if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node))
      && ts.isJsxExpression(node.parent)
      && ts.isJsxAttribute(node.parent.parent)) {
      const attributeName = node.parent.parent.name.getText(source);
      functions.push({ node, name: `${attributeName} handler`, id: `function:inline:${node.pos}` });
    } else if (ts.isMethodDeclaration(node)
      && node.body
      && ts.isIdentifier(node.name)
      && ts.isClassDeclaration(node.parent)) {
      functions.push({
        node,
        name: node.name.text,
        id: `function:method:${node.name.text}:${node.pos}`,
        classNode: node.parent
      });
    }
    ts.forEachChild(node, collectFunctions);
  }
  collectFunctions(source);

  const eventBindings: EventBinding[] = [];
  function collectEventBindings(node: ts.Node): void {
    if (ts.isJsxAttribute(node)
      && node.name.getText(source).startsWith('on')
      && node.initializer
      && ts.isJsxExpression(node.initializer)
      && node.initializer.expression) {
      const expression = node.initializer.expression;
      const target = ts.isIdentifier(expression)
        ? functions.find((candidate) => candidate.name === expression.text)
        : (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression))
          ? functions.find((candidate) => candidate.node === expression)
          : undefined;
      if (target) {
        const attributeName = node.name.getText(source);
        eventBindings.push({
          location: location(node),
          functionId: target.id,
          label: `${capitalize(getJsxElementName(node))} ${attributeName.slice(2).toLowerCase() || 'event'}`,
          detail: `${attributeName} triggers ${target.name}()`
        });
      }
    }
    ts.forEachChild(node, collectEventBindings);
  }
  collectEventBindings(source);

  for (const fn of functions) {
    if (!ts.isMethodDeclaration(fn.node) || !fn.classNode || !angularClasses.has(fn.classNode)) continue;
    const hostEvent = decoratorArgument(fn.node, 'HostListener');
    if (hostEvent) {
      eventBindings.push({
        location: location(fn.node),
        functionId: fn.id,
        label: `Host ${hostEvent}`,
        detail: `@HostListener invokes ${fn.name}()`
      });
    }
  }

  for (const component of angularComponents) {
    const template = getAngularInlineTemplate(component);
    if (!template) continue;
    for (const element of parseAngularTemplateElements(template.text)) {
      for (const attribute of element.attributes) {
        const eventName = attribute.name.match(/^\(([\w.-]+)\)$/)?.[1];
        const methodName = attribute.value.match(/^\s*([A-Za-z_$][\w$]*)\s*\(/)?.[1];
        if (!eventName || !methodName) continue;
        const target = functions.find((candidate) => candidate.name === methodName && candidate.node.parent === component);
        if (!target) continue;
        eventBindings.push({
          location: textLocation(source.fileName, text, template.node.getStart(source) + 1 + attribute.start, template.node.getStart(source) + 1 + attribute.end),
          functionId: target.id,
          label: `${capitalize(element.name)} ${eventName}`,
          detail: `(${eventName}) evaluates ${attribute.value.trim()}`
        });
      }
    }
    renderAngularTemplateArtifacts(template.text, source.fileName, template.node.getStart(source) + 1);
  }

  for (const template of options.externalTemplates ?? []) {
    const component = [...angularComponents].find((candidate) => {
      const templateUrl = getAngularTemplateUrl(candidate);
      return templateUrl && baseName(templateUrl) === baseName(template.fileName);
    });
    for (const element of parseAngularTemplateElements(template.text)) {
      for (const attribute of element.attributes) {
        const eventName = attribute.name.match(/^\(([\w.-]+)\)$/)?.[1];
        const methodName = attribute.value.match(/^\s*([A-Za-z_$][\w$]*)\s*\(/)?.[1];
        if (!eventName || !methodName) continue;
        const target = functions.find((candidate) => candidate.name === methodName
          && (!component || candidate.node.parent === component));
        if (!target) continue;
        eventBindings.push({
          location: textLocation(template.fileName, template.text, attribute.start, attribute.end),
          functionId: target.id,
          label: `${capitalize(element.name)} ${eventName}`,
          detail: `(${eventName}) evaluates ${attribute.value.trim()}`
        });
      }
    }
    renderAngularTemplateArtifacts(template.text, template.fileName, 0);
  }

  function renderAngularTemplateArtifacts(templateText: string, templateFile: string, baseOffset: number): void {
    const renderId = 'render:angular';
    const parsedElements = parseAngularTemplateElements(templateText);
    for (const element of parsedElements) {
      for (const attribute of element.attributes) {
        const binding = attribute.name.match(/^\[\(([^)]+)\)\]$/)?.[1];
        const property = attribute.value.trim();
        if (!binding || !/^[A-Za-z_$][\w$]*$/.test(property)) continue;
        const start = baseOffset + attribute.start;
        const bindingLocation = textLocation(templateFile, baseOffset ? text : templateText, start, baseOffset + attribute.end);
        let stateNode = nodes.find((candidate) => candidate.kind === 'state' && candidate.label === property);
        if (!stateNode) {
          stateNode = { id: `state:template:${property}:${start}`, kind: 'state', label: property, detail: 'Angular template-bound property', location: bindingLocation };
          addNode(stateNode);
        }
        const eventId = `event:two-way:${normalizePath(templateFile)}:${start}`;
        addNode({ id: eventId, kind: 'event', label: `${capitalize(element.name)} ${binding}`, detail: `Two-way binding updates ${property}`, location: bindingLocation });
        addEdge({ id: `${eventId}->${stateNode.id}:updates`, source: eventId, target: stateNode.id, label: 'updates' });
        addNode({ id: renderId, kind: 'render', label: 'Template updates', detail: 'Angular change detection displays bound values' });
        addEdge({ id: `${stateNode.id}->${renderId}:triggers`, source: stateNode.id, target: renderId, label: 'triggers' });
      }
    }

    const structures: Array<{ pattern: RegExp; type: 'condition' | 'loop' }> = [
      { pattern: /\*ngIf\s*=\s*["']([^"']+)["']/g, type: 'condition' },
      { pattern: /@if\s*\(([^)]+)\)/g, type: 'condition' },
      { pattern: /\*ngFor\s*=\s*["']([^"']+)["']/g, type: 'loop' },
      { pattern: /@for\s*\(([^)]+)\)/g, type: 'loop' }
    ];
    for (const structure of structures) {
      for (const match of templateText.matchAll(structure.pattern)) {
        if (match.index === undefined) continue;
        const expression = match[1].trim();
        const start = baseOffset + match.index;
        const structureId = `condition:template:${structure.type}:${normalizePath(templateFile)}:${start}`;
        addNode({
          id: structureId,
          kind: 'condition',
          label: expression,
          detail: structure.type === 'condition' ? 'Angular template condition' : 'Angular template loop',
          location: textLocation(templateFile, baseOffset ? text : templateText, start, start + match[0].length)
        });
        for (const state of nodes.filter((candidate) => candidate.kind === 'state' && expression.includes(candidate.label))) {
          addEdge({ id: `${state.id}->${structureId}:${structure.type}`, source: state.id, target: structureId, label: structure.type === 'condition' ? 'checks' : 'iterates' });
        }
      }
    }

    for (const element of parsedElements) {
      for (const attribute of element.attributes) {
        const inputName = attribute.name.match(/^\[([A-Za-z_][\w.-]*)\]$/)?.[1];
        if (!inputName) continue;
        const expression = attribute.value;
        const start = baseOffset + attribute.start;
        const inputId = `config:template-input:${normalizePath(templateFile)}:${start}`;
        addNode({
          id: inputId,
          kind: 'config',
          label: `[${inputName}]`,
          detail: `Receives ${expression}`,
          location: textLocation(templateFile, baseOffset ? text : templateText, start, baseOffset + attribute.end)
        });
        for (const state of nodes.filter((candidate) => candidate.kind === 'state' && expression.includes(candidate.label))) {
          addEdge({ id: `${state.id}->${inputId}:binds`, source: state.id, target: inputId, label: 'binds' });
        }
      }
    }

    const asyncPattern = /([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\(\))*)\s*\|\s*async/g;
    for (const match of templateText.matchAll(asyncPattern)) {
      if (match.index === undefined) continue;
      const start = baseOffset + match.index;
      const asyncId = `async:template:${normalizePath(templateFile)}:${start}`;
      addNode({
        id: asyncId,
        kind: 'async',
        label: `${match[1]} | async`,
        detail: 'Angular template subscribes and renders emitted values',
        location: textLocation(templateFile, baseOffset ? text : templateText, start, start + match[0].length)
      });
      addNode({ id: renderId, kind: 'render', label: 'Template updates', detail: 'Angular change detection displays async values' });
      addEdge({ id: `${asyncId}->${renderId}:emits`, source: asyncId, target: renderId, label: 'emits' });
    }

    for (const element of parsedElements.filter((candidate) => candidate.name === 'ng-content')) {
      const start = baseOffset + element.start;
      const selector = element.attributes.find((attribute) => attribute.name === 'select')?.value;
      addNode({
        id: `render:projection:${normalizePath(templateFile)}:${start}`,
        kind: 'render',
        label: 'Projected content',
        detail: selector ? `Projects content matching ${selector}` : 'Projects parent-provided content',
        location: textLocation(templateFile, baseOffset ? text : templateText, start, baseOffset + element.end)
      });
    }

    const pipePattern = /\|\s*([A-Za-z_$][\w$]*)/g;
    for (const match of templateText.matchAll(pipePattern)) {
      if (match.index === undefined || match[1] === 'async') continue;
      const start = baseOffset + match.index;
      addNode({
        id: `call:template-pipe:${match[1]}:${normalizePath(templateFile)}:${start}`,
        kind: 'call',
        label: `${match[1]} pipe`,
        detail: 'Transforms a value in the Angular template',
        location: textLocation(templateFile, baseOffset ? text : templateText, start, start + match[0].length)
      });
    }

    for (const element of parsedElements) {
      for (const attribute of element.attributes.filter((candidate) => candidate.name.toLowerCase() === 'ngskiphydration')) {
        const start = baseOffset + attribute.start;
        addNode({
          id: `config:skip-hydration:${normalizePath(templateFile)}:${start}`,
          kind: 'config',
          label: 'Skip hydration',
          detail: 'Angular leaves this host subtree unhydrated',
          location: textLocation(templateFile, baseOffset ? text : templateText, start, baseOffset + attribute.end)
        });
      }
    }
  }

  const eventAtCursor = eventBindings
    .filter(({ location: bindingLocation }) => bindingLocation
      && normalizePath(bindingLocation.fileName) === normalizePath(fileName)
      && cursorOffset >= bindingLocation.start
      && cursorOffset < bindingLocation.end)
    .map((binding) => functions.find((candidate) => candidate.id === binding.functionId))
    .find((candidate): candidate is FunctionInfo => Boolean(candidate));
  const functionAtCursor = functions
    .filter(({ node }) => containsOffset(node, source, cursorOffset))
    .sort((a, b) => nodeLength(a.node, source) - nodeLength(b.node, source))[0];
  const incompleteFunctionAtCursor = !functionAtCursor
    ? functions
      .filter(({ node }) => node.getStart(source) <= cursorOffset && hasUnclosedBlock(text.slice(node.getStart(source), cursorOffset)))
      .sort((a, b) => b.node.getStart(source) - a.node.getStart(source))[0]
    : undefined;
  const activeAtCursor = eventAtCursor ?? functionAtCursor ?? incompleteFunctionAtCursor;
  const preferred = !activeAtCursor && options.preferredFunction
    ? functions
      .filter((candidate) => candidate.name === options.preferredFunction?.name)
      .sort((a, b) => Math.abs(a.node.getStart(source) - options.preferredFunction!.start)
        - Math.abs(b.node.getStart(source) - options.preferredFunction!.start))[0]
    : undefined;
  const focused = activeAtCursor ?? preferred;

  if (!focused && !options.entireFile) {
    return {
      fileName: baseName(fileName),
      languageId,
      nodes: [],
      edges: [],
      message: functions.length
        ? 'Place the cursor inside a function to focus its mental model.'
        : 'Write a function to see its mental model.'
    };
  }

  const expandedNodeIds = new Set(options.expandedNodeIds ?? []);
  const expandedUsages = new Map((options.expandedUsages ?? []).map((item) => [item.targetId, item.sourceId]));
  const renderedFunctions = new Set<string>();

  const uniqueEndpoints = (endpoints: readonly FlowEndpoint[]): FlowEndpoint[] => {
    const seen = new Set<string>();
    return endpoints.filter((endpoint) => {
      const key = `${endpoint.id}:${endpoint.label ?? ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

  const shortText = (node: ts.Node | undefined, limit = 48): string => {
    const text = node?.getText(node.getSourceFile()).replace(/\s+/g, ' ').trim() ?? '';
    return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
  };

  const containsAwait = (boundary: ts.Node): boolean => {
    let found = false;
    const visit = (node: ts.Node): void => {
      if (found || (node !== boundary && ts.isFunctionLike(node))) return;
      if (ts.isAwaitExpression(node)) {
        found = true;
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(boundary);
    return found;
  };

  const containsThrow = (boundary: ts.Node | undefined): boolean => {
    if (!boundary) return false;
    let found = false;
    const visit = (node: ts.Node): void => {
      if (found || (node !== boundary && ts.isFunctionLike(node))) return;
      if (ts.isThrowStatement(node)) {
        found = true;
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(boundary);
    return found;
  };

  function renderFunction(fn: FunctionInfo, isRoot = false): void {
    const expanded = isRoot || expandedNodeIds.has(fn.id);
    const isAsync = hasAsyncModifier(fn.node);
    addNode({
      id: fn.id,
      kind: 'function',
      label: `${fn.name}()`,
      detail: isRoot
        ? options.entireFile
          ? `${isAsync ? 'Async ' : ''}${fn.classNode ? 'method' : 'function'} in this file`
          : `${isAsync ? 'Async ' : ''}${fn.classNode ? 'method' : 'function'} ${activeAtCursor ? 'under cursor' : 'kept in focus'}`
        : `${isAsync ? 'Async ' : ''}${fn.classNode ? 'helper method' : 'helper function'}${expanded ? ' · expanded' : ' · collapsed'}`,
      location: location(fn.node),
      expandable: !isRoot,
      expanded: !isRoot ? expanded : undefined,
      expandId: !isRoot ? fn.id : undefined,
      usageTargetId: fn.id,
      usagesExpanded: expandedUsages.has(fn.id)
    });

    if (isAngularLifecycleHook(fn.name) && ts.isMethodDeclaration(fn.node)) {
      const lifecycleId = `event:lifecycle:${fn.name}:${fn.node.pos}`;
      addNode({ id: lifecycleId, kind: 'event', label: fn.name, detail: 'Angular lifecycle invokes this hook', location: location(fn.node.name) });
      addEdge({ id: `${lifecycleId}->${fn.id}:triggers`, source: lifecycleId, target: fn.id, label: 'triggers' });
    }
    if (ts.isMethodDeclaration(fn.node) && ['canActivate', 'canMatch', 'canDeactivate', 'resolve'].includes(fn.name)) {
      const routerId = `event:router-hook:${fn.name}:${fn.node.pos}`;
      const resolver = fn.name === 'resolve';
      addNode({
        id: routerId,
        kind: 'event',
        label: resolver ? 'Route resolver' : `Route guard ${fn.name}`,
        detail: `Angular Router invokes ${fn.name}()`,
        location: location(fn.node.name)
      });
      addEdge({ id: `${routerId}->${fn.id}:triggers`, source: routerId, target: fn.id, label: 'triggers' });
    }
    if (ts.isMethodDeclaration(fn.node)
      && fn.name === 'transform'
      && fn.classNode
      && hasDecorator(fn.classNode, 'Pipe')) {
      const pipeId = `event:pipe:${fn.node.pos}`;
      addNode({ id: pipeId, kind: 'event', label: 'Pipe transform', detail: 'Angular template invokes this pipe', location: location(fn.node.name) });
      addEdge({ id: `${pipeId}->${fn.id}:transforms`, source: pipeId, target: fn.id, label: 'transforms' });
    }

    for (const binding of eventBindings.filter((candidate) => candidate.functionId === fn.id)) {
      const eventId = `event:${normalizePath(binding.location?.fileName ?? fileName)}:${binding.location?.start ?? 0}:${fn.id}`;
      addNode({
        id: eventId,
        kind: 'event',
        label: binding.label,
        detail: binding.detail,
        location: binding.location
      });
      addEdge({ id: `${eventId}->${fn.id}:triggers`, source: eventId, target: fn.id, label: 'triggers' });
    }

    if (!expanded || renderedFunctions.has(fn.id)) return;
    renderedFunctions.add(fn.id);

    const body = fn.node.body;
    if (!body) return;
    if (ts.isBlock(body)) analyzeStatements(body.statements, [{ id: fn.id }], {}, fn);
    else analyzeExpression(body, [{ id: fn.id }], {}, fn);
  }

  function analyzeStatements(
    statements: readonly ts.Statement[],
    incoming: readonly FlowEndpoint[],
    context: FlowContext,
    owner: FunctionInfo
  ): FlowEndpoint[] {
    let flow = [...incoming];
    for (const statement of statements) {
      if (!flow.length) break;
      flow = mergeFlow(flow, statement);
      flow = analyzeStatement(statement, flow, context, owner);
    }
    return uniqueEndpoints(flow);
  }

  function mergeFlow(incoming: readonly FlowEndpoint[], at: ts.Node): FlowEndpoint[] {
    const endpoints = uniqueEndpoints(incoming);
    if (endpoints.length < 2) return endpoints;
    const mergeId = `merge:${at.pos}`;
    addNode({ id: mergeId, kind: 'merge', label: 'Continue', detail: 'Control-flow paths join here', location: location(at) });
    connect(endpoints, mergeId);
    return [{ id: mergeId }];
  }

  function analyzeBranch(
    statement: ts.Statement,
    incoming: readonly FlowEndpoint[],
    context: FlowContext,
    owner: FunctionInfo
  ): FlowEndpoint[] {
    return ts.isBlock(statement)
      ? analyzeStatements(statement.statements, incoming, context, owner)
      : analyzeStatement(statement, incoming, context, owner);
  }

  function analyzeStatement(
    statement: ts.Statement,
    incoming: readonly FlowEndpoint[],
    context: FlowContext,
    owner: FunctionInfo
  ): FlowEndpoint[] {
    if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) return [...incoming];

    if (ts.isBlock(statement)) return analyzeStatements(statement.statements, incoming, context, owner);

    if (ts.isIfStatement(statement)) {
      const conditionFlow = analyzeExpression(statement.expression, incoming, context, owner);
      const conditionId = `condition:${statement.expression.pos}`;
      addNode({
        id: conditionId,
        kind: 'condition',
        label: shortText(statement.expression),
        detail: 'Condition',
        location: location(statement.expression)
      });
      connect(conditionFlow, conditionId, 'checks');
      const thenFlow = analyzeBranch(statement.thenStatement, [{ id: conditionId, label: 'true' }], context, owner);
      const elseFlow = statement.elseStatement
        ? analyzeBranch(statement.elseStatement, [{ id: conditionId, label: 'false' }], context, owner)
        : [{ id: conditionId, label: 'false' }];
      return uniqueEndpoints([...thenFlow, ...elseFlow]);
    }

    if (ts.isReturnStatement(statement)) {
      const returnFlow = statement.expression
        ? analyzeExpression(statement.expression, incoming, context, owner)
        : [...incoming];
      const returnId = `return:${statement.pos}`;
      const value = shortText(statement.expression, 38);
      addNode({
        id: returnId,
        kind: 'return',
        label: value ? `return ${value}` : 'return',
        detail: 'Function exits here',
        location: location(statement)
      });
      connect(returnFlow, returnId, 'returns');
      return [];
    }

    if (ts.isThrowStatement(statement)) {
      const throwFlow = analyzeExpression(statement.expression, incoming, context, owner);
      if (context.catchTargetId) {
        connect(throwFlow, context.catchTargetId, 'throws');
        return [];
      }
      const errorId = `throw:${statement.pos}`;
      addNode({
        id: errorId,
        kind: 'error',
        label: shortText(statement.expression, 38) || 'Error',
        detail: 'Error propagates to caller',
        location: location(statement)
      });
      connect(throwFlow, errorId, 'throws');
      return [];
    }

    if (ts.isTryStatement(statement)) {
      const catchId = statement.catchClause ? `catch:${statement.catchClause.pos}` : undefined;
      if (catchId && statement.catchClause) {
        addNode({
          id: catchId,
          kind: 'catch',
          label: 'Catch',
          detail: 'Handles an error from the try block',
          location: location(statement.catchClause)
        });
        if (!containsAwait(statement.tryBlock)) connect(incoming, catchId, 'on error');
      }
      const tryFlow = analyzeStatements(
        statement.tryBlock.statements,
        incoming,
        { ...context, catchTargetId: catchId ?? context.catchTargetId },
        owner
      );
      const catchFlow = statement.catchClause && catchId
        ? analyzeStatements(statement.catchClause.block.statements, [{ id: catchId }], context, owner)
        : [];
      let combined = uniqueEndpoints([...tryFlow, ...catchFlow]);
      if (statement.finallyBlock) {
        combined = analyzeStatements(statement.finallyBlock.statements, combined, context, owner);
      }
      return combined;
    }

    if (ts.isWhileStatement(statement) || ts.isDoStatement(statement) || ts.isForStatement(statement)) {
      const expression = ts.isForStatement(statement) ? statement.condition : statement.expression;
      if (!expression) return analyzeBranch(statement.statement, incoming, context, owner);
      const conditionFlow = analyzeExpression(expression, incoming, context, owner);
      const conditionId = `condition:${expression.pos}`;
      addNode({ id: conditionId, kind: 'condition', label: shortText(expression), detail: 'Loop condition', location: location(expression) });
      connect(conditionFlow, conditionId, 'checks');
      const bodyFlow = analyzeBranch(statement.statement, [{ id: conditionId, label: 'true' }], context, owner);
      connect(bodyFlow, conditionId, 'repeats');
      return [{ id: conditionId, label: 'false' }];
    }

    return analyzeExpression(statement, incoming, context, owner);
  }

  function analyzeExpression(
    boundary: ts.Node,
    incoming: readonly FlowEndpoint[],
    context: FlowContext,
    owner: FunctionInfo
  ): FlowEndpoint[] {
    let flow = [...incoming];

    const visit = (node: ts.Node): void => {
      if (node !== boundary && ts.isFunctionLike(node)) return;
      if (ts.isConditionalExpression(node)) {
        const conditionFlow = analyzeExpression(node.condition, flow, context, owner);
        const conditionId = `condition:${node.condition.pos}`;
        addNode({
          id: conditionId,
          kind: 'condition',
          label: shortText(node.condition),
          detail: 'Conditional expression',
          location: location(node.condition)
        });
        connect(conditionFlow, conditionId, 'checks');
        const trueFlow = analyzeExpression(node.whenTrue, [{ id: conditionId, label: 'true' }], context, owner);
        const falseFlow = analyzeExpression(node.whenFalse, [{ id: conditionId, label: 'false' }], context, owner);
        flow = uniqueEndpoints([...trueFlow, ...falseFlow]);
        return;
      }
      if (ts.isAwaitExpression(node)) {
        flow = analyzeAwait(node, flow, context, owner);
        return;
      }
      if (ts.isCallExpression(node)) {
        visit(node.expression);
        for (const argument of node.arguments) visit(argument);
        const action = processCall(node, flow, owner);
        if (action.length) flow = action;
        return;
      }
      ts.forEachChild(node, visit);
    };

    visit(boundary);
    return uniqueEndpoints(flow);
  }

  function analyzeAwait(
    node: ts.AwaitExpression,
    incoming: readonly FlowEndpoint[],
    context: FlowContext,
    owner: FunctionInfo
  ): FlowEndpoint[] {
    let awaitIncoming = [...incoming];
    const awaitedCall = unwrapAwaitedCall(node.expression);
    if (awaitedCall) {
      awaitIncoming = analyzeCallInputs(awaitedCall, awaitIncoming, context, owner);
    }
    if (awaitedCall && ts.isIdentifier(awaitedCall.expression) && awaitedCall.expression.text === 'fetch') {
      awaitIncoming = renderRequest(awaitedCall, awaitIncoming);
    } else if (awaitedCall) {
      const callFlow = processCall(awaitedCall, awaitIncoming, owner);
      if (callFlow.length) awaitIncoming = callFlow;
    }
    const asyncId = `async:${node.pos}`;
    const callLabel = getAwaitLabel(node.expression, node.getSourceFile());
    addNode({
      id: asyncId,
      kind: 'async',
      label: callLabel,
      detail: 'Awaited asynchronous operation',
      location: location(node)
    });
    connect(awaitIncoming, asyncId, 'awaits');

    const catchCall = ts.isCallExpression(node.expression)
      && ts.isPropertyAccessExpression(node.expression.expression)
      && node.expression.expression.name.text === 'catch'
      ? node.expression
      : undefined;
    if (catchCall) {
      const handler = catchCall.arguments[0];
      if (containsThrow(handler)) {
        if (context.catchTargetId) {
          addEdge({
            id: `${asyncId}->${context.catchTargetId}:rethrows`,
            source: asyncId,
            target: context.catchTargetId,
            label: 'rethrows'
          });
          return [{ id: asyncId, label: 'resolves' }];
        }
        const errorId = `error:rethrow:${node.pos}`;
        addNode({
          id: errorId,
          kind: 'error',
          label: 'Error',
          detail: 'Caught and rethrown; rejection propagates to caller',
          location: handler ? location(handler) : location(node)
        });
        addEdge({ id: `${asyncId}->${errorId}:rethrows`, source: asyncId, target: errorId, label: 'rethrows' });
        return [{ id: asyncId, label: 'resolves' }];
      }
      const fallbackId = `fallback:${node.pos}`;
      addNode({
        id: fallbackId,
        kind: 'success',
        label: 'Fallback',
        detail: 'Rejection handled by .catch()',
        location: handler ? location(handler) : location(node)
      });
      addEdge({ id: `${asyncId}->${fallbackId}:caught`, source: asyncId, target: fallbackId, label: 'caught' });
      return [{ id: asyncId, label: 'resolves' }, { id: fallbackId, label: 'continues' }];
    }

    if (context.catchTargetId) {
      addEdge({
        id: `${asyncId}->${context.catchTargetId}:rejects`,
        source: asyncId,
        target: context.catchTargetId,
        label: 'rejects'
      });
    } else {
      const errorId = `error:await:${node.pos}`;
      addNode({
        id: errorId,
        kind: 'error',
        label: 'Error',
        detail: 'Rejection propagates to caller',
        location: location(node)
      });
      addEdge({ id: `${asyncId}->${errorId}:rejects`, source: asyncId, target: errorId, label: 'rejects' });
    }
    return [{ id: asyncId, label: 'resolves' }];
  }

  function analyzeCallInputs(
    call: ts.CallExpression,
    incoming: readonly FlowEndpoint[],
    context: FlowContext,
    owner: FunctionInfo
  ): FlowEndpoint[] {
    let flow = analyzeExpression(call.expression, incoming, context, owner);
    for (const argument of call.arguments) {
      flow = analyzeExpression(argument, flow, context, owner);
    }
    return flow;
  }

  function renderRequest(call: ts.CallExpression, incoming: readonly FlowEndpoint[]): FlowEndpoint[] {
    const requestId = `request:${call.pos}`;
    const optionsArg = call.arguments[1];
    const methodNode = getObjectProperty(optionsArg, 'method');
    const method = !methodNode ? 'GET' : ts.isStringLiteralLike(methodNode) ? methodNode.text.toUpperCase() : 'Dynamic';
    const expanded = expandedNodeIds.has(requestId);
    let flow = [...incoming];

    if (expanded) {
      const entries: Array<[string, ts.Node | undefined, string]> = [
        ['URL', call.arguments[0], shortText(call.arguments[0], 70)]
      ];
      if (optionsArg && ts.isObjectLiteralExpression(optionsArg)) {
        for (const property of optionsArg.properties) {
          if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) continue;
          const propertyName = property.name.getText(source).replace(/["']/g, '');
          if (!['method', 'headers', 'body', 'signal'].includes(propertyName)) continue;
          const value = ts.isShorthandPropertyAssignment(property) ? property.name : property.initializer;
          const label = capitalize(propertyName);
          entries.push([label, value, propertyName === 'body' ? summarizeBody(value) : shortText(value, 70)]);
        }
      }
      if (!methodNode) entries.splice(1, 0, ['Method', undefined, 'GET (default)']);
      for (const [name, valueNode, detail] of entries) {
        if (!valueNode && name !== 'Method') continue;
        const configId = `config:${name.toLowerCase()}:${call.pos}`;
        addNode({ id: configId, kind: 'config', label: name, detail, location: location(valueNode ?? call) });
        connect(flow, configId, 'sets');
        flow = [{ id: configId }];
      }
    }

    addNode({
      id: requestId,
      kind: 'request',
      label: `${method} request`,
      detail: shortText(call.arguments[0], 70) || 'Request URL',
      location: location(call),
      expandable: true,
      expanded,
      expandId: requestId
    });
    connect(flow, requestId, expanded ? 'builds' : 'builds request');
    return [{ id: requestId }];
  }

  function getObjectProperty(node: ts.Expression | undefined, name: string): ts.Expression | undefined {
    if (!node || !ts.isObjectLiteralExpression(node)) return undefined;
    const property = node.properties.find((candidate): candidate is ts.PropertyAssignment | ts.ShorthandPropertyAssignment =>
      (ts.isPropertyAssignment(candidate) || ts.isShorthandPropertyAssignment(candidate))
      && candidate.name.getText(source).replace(/["']/g, '') === name
    );
    if (!property) return undefined;
    return ts.isShorthandPropertyAssignment(property) ? property.name : property.initializer;
  }

  function summarizeBody(node: ts.Expression | undefined): string {
    if (node && ts.isCallExpression(node) && getCallName(node.expression) === 'stringify') {
      const value = node.arguments[0];
      if (value && ts.isObjectLiteralExpression(value)) {
        const fields = value.properties.map((property) => property.name?.getText(source)).filter(Boolean);
        if (fields.length) return `JSON fields: ${fields.join(', ')}`;
      }
    }
    return shortText(node, 70);
  }

  function resolveLocalFunction(call: ts.CallExpression, owner: FunctionInfo, name: string): FunctionInfo | undefined {
    if (ts.isIdentifier(call.expression)) {
      return functions.find((candidate) => candidate.name === name && !candidate.classNode);
    }
    if (ts.isPropertyAccessExpression(call.expression)
      && call.expression.expression.kind === ts.SyntaxKind.ThisKeyword
      && owner.classNode) {
      const sameClass = functions.find((candidate) => candidate.name === name && candidate.classNode === owner.classNode);
      if (sameClass) return sameClass;
    }
    const declaration = resolveCalledDeclaration(call, checker);
    return declaration ? functions.find((candidate) => sameCallable(declaration, candidate.node)) : undefined;
  }

  function isImportedCall(expression: ts.LeftHandSideExpression): boolean {
    let current: ts.Expression = expression;
    while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
      current = current.expression;
    }
    return ts.isIdentifier(current) && importedBindings.has(current.text);
  }

  function processCall(
    node: ts.CallExpression,
    incoming: readonly FlowEndpoint[],
    owner: FunctionInfo
  ): FlowEndpoint[] {
    const callee = node.expression.getText(source);
    const calleeName = getCallName(node.expression);
    const resource = resources.get(callee);
    if (resource) {
      const resourceNode = nodes.find((candidate) => candidate.id === resource.nodeId);
      if (resourceNode) {
        resourceNode.detail = `Reloads ${resource.type} ${resource.name}`;
        resourceNode.location = location(node);
      }
      connect(incoming, resource.nodeId, 'reloads');
      return [{ id: resource.nodeId }];
    }
    const output = outputs.get(callee);
    if (output) {
      const outputNode = nodes.find((item) => item.id === output.nodeId);
      if (outputNode) {
        outputNode.detail = `Emits ${node.arguments[0]?.getText(source) ?? 'an event'} via ${output.implementation}`;
        outputNode.location = location(node);
      }
      connect(incoming, output.nodeId, 'emits');
      return [{ id: output.nodeId }];
    }

    if (ts.isPropertyAccessExpression(node.expression)) {
      const receiver = node.expression.expression.getText(source);
      const injection = injections.get(receiver);
      if (injection) {
        const methodName = node.expression.name.text;
        if (injection.service.includes('Store') && (methodName === 'dispatch' || methodName === 'select')) {
          const storeId = `ngrx:store:${methodName}:${node.pos}`;
          addNode({
            id: storeId,
            kind: methodName === 'dispatch' ? 'event' : 'state',
            label: methodName === 'dispatch' ? 'Store dispatch' : 'Store select',
            detail: methodName === 'dispatch'
              ? `Dispatches ${shortText(node.arguments[0], 60) || 'an NgRx action'}`
              : `Selects ${shortText(node.arguments[0], 60) || 'NgRx state'}`,
            location: location(node)
          });
          connect(incoming, storeId, methodName === 'dispatch' ? 'dispatches' : 'selects');
          addEdge({ id: `${injection.nodeId}->${storeId}:provides`, source: injection.nodeId, target: storeId, label: 'provides' });
          return [{ id: storeId }];
        }
        if (injection.service.includes('HttpClient') && ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'].includes(methodName)) {
          return renderAngularHttpRequest(node, incoming, injection, methodName);
        }
        const callId = `call:service:${node.pos}`;
        const isRouter = injection.service.includes('Router') && (methodName === 'navigate' || methodName === 'navigateByUrl');
        addNode({
          id: callId,
          kind: 'call',
          label: `${injection.service}.${methodName}()`,
          detail: isRouter
            ? `Navigates to ${shortText(node.arguments[0], 55) || 'a route'}`
            : `Calls injected ${injection.service}`,
          location: location(node)
        });
        connect(incoming, callId, 'calls');
        addEdge({ id: `${injection.nodeId}->${callId}:provides`, source: injection.nodeId, target: callId, label: 'provides' });
        return [{ id: callId }];
      }
    }

    const rxjsOperators = new Set(['map', 'filter', 'tap', 'switchMap', 'mergeMap', 'concatMap', 'exhaustMap', 'catchError', 'finalize', 'takeUntil']);
    if (angularClasses.size && rxjsOperators.has(calleeName)) {
      const operatorId = `call:rxjs:${calleeName}:${node.pos}`;
      addNode({
        id: operatorId,
        kind: calleeName === 'catchError' ? 'catch' : calleeName.endsWith('Map') ? 'async' : 'call',
        label: `${calleeName}()`,
        detail: calleeName === 'catchError'
          ? 'Handles an RxJS pipeline error'
          : calleeName.endsWith('Map')
            ? 'Projects values into an inner Observable'
            : 'RxJS pipeline operator',
        location: location(node)
      });
      connect(incoming, operatorId, 'operator');
      renderRxjsOperatorCallbacks(node, operatorId, owner, calleeName);
      return [{ id: operatorId }];
    }

    if (angularClasses.size && (calleeName === 'pipe' || calleeName === 'subscribe')) {
      const observableId = `async:observable:${calleeName}:${node.pos}`;
      addNode({
        id: observableId,
        kind: 'async',
        label: calleeName === 'pipe' ? 'Observable pipeline' : 'subscribe()',
        detail: calleeName === 'pipe' ? 'Transforms an RxJS Observable' : 'Receives Observable values over time',
        location: location(node)
      });
      connect(incoming, observableId, calleeName === 'pipe' ? 'pipes' : 'subscribes');
      if (calleeName === 'subscribe') renderObservableCallbacks(node, observableId, owner);
      return [{ id: observableId }];
    }

    const state = states.get(callee);
    if (state) {
      calledSetters.add(state.setterNodeId);
      connect(incoming, state.setterNodeId, state.mode === 'reducer' ? 'dispatches' : 'calls');
      const setterNode = nodes.find((item) => item.id === state.setterNodeId);
      if (setterNode) {
        const argument = node.arguments[0]?.getText(source) ?? 'a new value';
        setterNode.detail = state.mode === 'reducer'
          ? `Action: ${argument}`
          : state.mode === 'signal-update'
            ? `${state.value} updates using ${argument}`
            : state.mode === 'form'
              ? `${state.value} form receives ${argument}`
              : `${state.value} becomes ${argument}`;
        setterNode.location = location(node);
      }
      return [{ id: state.setterNodeId }];
    }

    const localTarget = resolveLocalFunction(node, owner, calleeName);
    if (localTarget && localTarget.id !== owner.id) {
      const expanded = expandedNodeIds.has(localTarget.id);
      const callId = `call:${node.pos}`;
      addNode({
        id: callId,
        kind: 'call',
        label: `${localTarget.name}()`,
        detail: `Calls ${hasAsyncModifier(localTarget.node) ? 'async ' : ''}helper${expanded ? ' · details expanded' : ''}`,
        location: location(node),
        expandable: true,
        expanded,
        expandId: localTarget.id,
        usageTargetId: localTarget.id,
        usagesExpanded: expandedUsages.has(localTarget.id)
      });
      connect(incoming, callId, 'calls');
      if (expanded) {
        renderFunction(localTarget);
        addEdge({ id: `${callId}->${localTarget.id}:details`, source: callId, target: localTarget.id, label: 'details' });
      }
      return [{ id: callId }];
    }

    const declaration = resolveCalledDeclaration(node, checker);
    if (declaration && normalizePath(declaration.getSourceFile().fileName) !== normalizePath(fileName)) {
      const targetSource = declaration.getSourceFile();
      if (!targetSource.isDeclarationFile) {
        const targetId = `function:${normalizePath(targetSource.fileName)}:${declaration.getStart(targetSource)}`;
        addNode({
          id: targetId,
          kind: 'function',
          label: `${callee}()`,
          detail: `Defined in ${baseName(targetSource.fileName)}`,
          location: location(declaration),
          usageTargetId: targetId,
          usagesExpanded: expandedUsages.has(targetId)
        });
        connect(incoming, targetId, 'calls');
        return [{ id: targetId }];
      }
    }
    if (isImportedCall(node.expression)) {
      const callId = `call:imported:${node.pos}`;
      const expandId = `${importResolutionPrefix}${node.pos}`;
      const expanded = expandedNodeIds.has(expandId);
      addNode({
        id: callId,
        kind: 'call',
        label: `${callee}()`,
        detail: expanded
          ? 'The imported source could not be resolved.'
          : 'Imported call · resolve source on demand',
        location: location(node),
        expandable: true,
        expanded,
        expandId
      });
      connect(incoming, callId, 'calls');
      return [{ id: callId }];
    }
    return [];
  }

  function renderAngularHttpRequest(
    call: ts.CallExpression,
    incoming: readonly FlowEndpoint[],
    injection: InjectionBinding,
    methodName: string
  ): FlowEndpoint[] {
    const requestId = `request:http-client:${call.pos}`;
    const expanded = expandedNodeIds.has(requestId);
    const hasBody = ['post', 'put', 'patch'].includes(methodName);
    let flow = [...incoming];
    if (expanded) {
      const entries: Array<[string, ts.Expression | undefined]> = [
        ['URL', call.arguments[0]],
        ...(hasBody ? [['Body', call.arguments[1]] as [string, ts.Expression | undefined]] : []),
        ['Options', call.arguments[hasBody ? 2 : 1]]
      ];
      for (const [label, value] of entries) {
        if (!value) continue;
        const configId = `config:http-client:${label.toLowerCase()}:${call.pos}`;
        addNode({ id: configId, kind: 'config', label, detail: shortText(value, 70), location: location(value) });
        connect(flow, configId, 'sets');
        flow = [{ id: configId }];
      }
    }
    const responseType = call.typeArguments?.[0]?.getText(source);
    addNode({
      id: requestId,
      kind: 'request',
      label: `${methodName.toUpperCase()} request`,
      detail: `${shortText(call.arguments[0], 70) || 'Request URL'}${responseType ? ` · response ${responseType}` : ''}`,
      location: location(call),
      expandable: true,
      expanded,
      expandId: requestId
    });
    connect(flow, requestId, 'sends');
    addEdge({ id: `${injection.nodeId}->${requestId}:provides`, source: injection.nodeId, target: requestId, label: 'provides' });
    const errorId = `error:http-client:${call.pos}`;
    addNode({ id: errorId, kind: 'error', label: 'HttpErrorResponse', detail: 'Error notification enters the RxJS pipeline', location: location(call) });
    addEdge({ id: `${requestId}->${errorId}:errors`, source: requestId, target: errorId, label: 'errors' });
    return [{ id: requestId }];
  }

  function renderObservableCallbacks(call: ts.CallExpression, observableId: string, owner: FunctionInfo): void {
    const callbacks: Array<{ callback: ts.ArrowFunction | ts.FunctionExpression; label: string }> = [];
    const first = call.arguments[0];
    if (first && (ts.isArrowFunction(first) || ts.isFunctionExpression(first))) callbacks.push({ callback: first, label: 'next' });
    if (first && ts.isObjectLiteralExpression(first)) {
      for (const property of first.properties) {
        if (!ts.isPropertyAssignment(property)) continue;
        const callback = property.initializer;
        if (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) continue;
        callbacks.push({ callback, label: property.name.getText(source).replace(/["']/g, '') });
      }
    }
    const error = call.arguments[1];
    if (error && (ts.isArrowFunction(error) || ts.isFunctionExpression(error))) callbacks.push({ callback: error, label: 'error' });

    for (const { callback, label } of callbacks) {
      const callbackId = `observable:${label}:${callback.pos}`;
      addNode({
        id: callbackId,
        kind: label === 'error' ? 'error' : 'success',
        label: `Observable ${label}`,
        detail: label === 'error' ? 'Handles an Observable error notification' : `Handles an Observable ${label} notification`,
        location: location(callback)
      });
      connect([{ id: observableId, label }], callbackId);
      const incoming = [{ id: callbackId }];
      if (ts.isBlock(callback.body)) analyzeStatements(callback.body.statements, incoming, {}, owner);
      else analyzeExpression(callback.body, incoming, {}, owner);
    }
  }

  function renderRxjsOperatorCallbacks(
    call: ts.CallExpression,
    operatorId: string,
    owner: FunctionInfo,
    operatorName: string
  ): void {
    for (const argument of call.arguments) {
      if (!ts.isArrowFunction(argument) && !ts.isFunctionExpression(argument)) continue;
      const callbackId = `rxjs:callback:${operatorName}:${argument.pos}`;
      const edgeLabel = operatorName === 'catchError' ? 'handles error'
        : operatorName === 'tap' ? 'side effect'
          : operatorName.endsWith('Map') ? 'projects' : 'applies';
      addNode({
        id: callbackId,
        kind: operatorName === 'catchError' ? 'catch' : 'call',
        label: `${operatorName} callback`,
        detail: operatorName === 'catchError' ? 'Builds a recovery Observable' : 'Runs for each matching Observable value',
        location: location(argument)
      });
      addEdge({ id: `${operatorId}->${callbackId}:${edgeLabel}`, source: operatorId, target: callbackId, label: edgeLabel });
      const incoming = [{ id: callbackId }];
      if (ts.isBlock(argument.body)) analyzeStatements(argument.body.statements, incoming, {}, owner);
      else analyzeExpression(argument.body, incoming, {}, owner);
    }
  }

  if (options.entireFile) {
    for (const fn of functions) renderFunction(fn, true);
  } else if (focused) {
    renderFunction(focused, true);
  }

  for (const [targetId, sourceId] of expandedUsages) {
    const target = functions.find((candidate) => candidate.id === targetId);
    if (target) renderUsages(target.node, target.name, sourceId, targetId);
    else {
      const targetNode = nodes.find((candidate) => candidate.id === targetId);
      if (targetNode?.location && program) {
        const targetSource = program.getSourceFiles().find((candidate) => normalizePath(candidate.fileName) === normalizePath(targetNode.location!.fileName));
        const declaration = targetSource && findCallableAt(targetSource, targetNode.location.start);
        if (declaration) renderUsages(declaration, targetNode.label.replace(/\(\)$/, ''), sourceId, targetId);
      }
    }
  }

  if (calledSetters.size) {
    const hasAngularUpdate = [...states.values()].some((state) => calledSetters.has(state.setterNodeId)
      && (state.mode === 'signal-set' || state.mode === 'signal-update' || state.mode === 'form'));
    const renderId = hasAngularUpdate ? 'render:angular' : 'render:react';
    addNode({
      id: renderId,
      kind: 'render',
      label: hasAngularUpdate ? 'Template updates' : 'UI re-renders',
      detail: hasAngularUpdate ? 'Angular change detection displays updated state' : 'React displays the updated state'
    });

    for (const state of states.values()) {
      if (calledSetters.has(state.setterNodeId)) {
        addEdge({ id: `${state.nodeId}->${renderId}`, source: state.nodeId, target: renderId, label: 'triggers' });
      }
    }
  }

  const activeNodeId = nodes
    .filter((node) => node.location
      && normalizePath(node.location.fileName) === normalizePath(fileName)
      && cursorOffset >= node.location.start
      && cursorOffset <= node.location.end)
    .sort((a, b) => locationLength(a) - locationLength(b))[0]?.id;

  return {
    fileName: baseName(fileName),
    languageId,
    activeFunction: options.entireFile ? undefined : focused?.name,
    rootFunctionId: options.entireFile ? undefined : focused?.id,
    activeNodeId,
    entireFile: options.entireFile,
    nodes,
    edges,
    message: nodes.length ? undefined : 'Write a React function with state to see its mental model.'
  };

  function renderUsages(target: ts.Node, name: string, sourceId: string, targetId: string): void {
    const sourceFiles = (program?.getSourceFiles() ?? [source])
      .filter((candidate): candidate is ts.SourceFile => Boolean(candidate));
    let count = 0;
    for (const candidateSource of sourceFiles) {
      if (candidateSource.isDeclarationFile) continue;
      const visit = (candidate: ts.Node): void => {
        if (ts.isCallExpression(candidate)) {
          const declaration = resolveCalledDeclaration(candidate, checker);
          if ((declaration && sameCallable(declaration, target))
            || (!checker && unresolvedCallMatches(candidate, target, name))) {
            const usageId = `usage:${targetId}:${normalizePath(candidateSource.fileName)}:${candidate.pos}`;
            const usageLocation = location(candidate);
            addNode({
              id: usageId,
              kind: 'usage',
              label: `${baseName(candidateSource.fileName)}:${usageLocation.line + 1}`,
              detail: shortText(candidate, 70) || `${name}() call`,
              location: usageLocation
            });
            addEdge({ id: `${sourceId}->${usageId}:used-by`, source: sourceId, target: usageId, label: 'used by' });
            count += 1;
          }
        }
        ts.forEachChild(candidate, visit);
      };
      visit(candidateSource);
    }
    if (!count) {
      const emptyId = `usage:none:${targetId}`;
      addNode({ id: emptyId, kind: 'usage', label: 'No usages found', detail: 'No project call sites were resolved.' });
      addEdge({ id: `${sourceId}->${emptyId}:used-by`, source: sourceId, target: emptyId, label: 'used by' });
    }
  }
}
