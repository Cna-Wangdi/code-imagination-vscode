import ts from 'typescript';
import type { VisualEdge, VisualModel, VisualNode } from './model';

interface StateBinding {
  value: string;
  setter: string;
  nodeId: string;
  setterNodeId: string;
  mode: 'state' | 'reducer';
  reducerName?: string;
}

interface FunctionInfo {
  node: ts.FunctionLikeDeclaration;
  name: string;
  id: string;
}

interface EventBinding {
  attribute: ts.JsxAttribute;
  functionId: string;
}

interface FlowEndpoint {
  id: string;
  label?: string;
}

interface FlowContext {
  catchTargetId?: string;
}

export interface AnalyzeOptions {
  preferredFunction?: {
    name: string;
    start: number;
  };
  expandedNodeIds?: readonly string[];
  expandedUsages?: readonly { targetId: string; sourceId: string }[];
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
  const nodes: VisualNode[] = [];
  const edges: VisualEdge[] = [];
  const states = new Map<string, StateBinding>();
  const calledSetters = new Set<string>();

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
      if (target) eventBindings.push({ attribute: node, functionId: target.id });
    }
    ts.forEachChild(node, collectEventBindings);
  }
  collectEventBindings(source);

  const eventAtCursor = eventBindings
    .filter(({ attribute }) => containsOffset(attribute, source, cursorOffset))
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
          ? `${isAsync ? 'Async f' : 'F'}unction in this file`
          : `${isAsync ? 'Async f' : 'F'}unction ${activeAtCursor ? 'under cursor' : 'kept in focus'}`
        : `${isAsync ? 'Async h' : 'H'}elper function${expanded ? ' · expanded' : ' · collapsed'}`,
      location: location(fn.node),
      expandable: !isRoot,
      expanded: !isRoot ? expanded : undefined,
      expandId: !isRoot ? fn.id : undefined,
      usageTargetId: fn.id,
      usagesExpanded: expandedUsages.has(fn.id)
    });

    for (const binding of eventBindings.filter((candidate) => candidate.functionId === fn.id)) {
      const attributeName = binding.attribute.name.getText(source);
      const eventId = `event:${binding.attribute.pos}`;
      addNode({
        id: eventId,
        kind: 'event',
        label: `${capitalize(getJsxElementName(binding.attribute))} ${attributeName.slice(2).toLowerCase() || 'event'}`,
        detail: `${attributeName} triggers ${fn.name}()`,
        location: location(binding.attribute)
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
      const conditionFlow = analyzeExpression(statement.expression, incoming, context, owner, true);
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
      const conditionFlow = analyzeExpression(expression, incoming, context, owner, true);
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
    owner: FunctionInfo,
    suppressCallNodes = false
  ): FlowEndpoint[] {
    let flow = [...incoming];

    const visit = (node: ts.Node): void => {
      if (node !== boundary && ts.isFunctionLike(node)) return;
      if (ts.isAwaitExpression(node)) {
        flow = analyzeAwait(node, flow, context, owner);
        return;
      }
      if (ts.isCallExpression(node)) {
        visit(node.expression);
        for (const argument of node.arguments) visit(argument);
        if (!suppressCallNodes) {
          const action = processCall(node, flow, owner);
          if (action.length) flow = action;
        }
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

  function processCall(
    node: ts.CallExpression,
    incoming: readonly FlowEndpoint[],
    owner: FunctionInfo
  ): FlowEndpoint[] {
    const callee = node.expression.getText(source);
    const state = states.get(callee);
    if (state) {
      calledSetters.add(state.setterNodeId);
      connect(incoming, state.setterNodeId, state.mode === 'reducer' ? 'dispatches' : 'calls');
      const setterNode = nodes.find((item) => item.id === state.setterNodeId);
      if (setterNode) {
        setterNode.detail = state.mode === 'reducer'
          ? `Action: ${node.arguments[0]?.getText(source) ?? 'unknown'}`
          : `${state.value} becomes ${node.arguments[0]?.getText(source) ?? 'a new value'}`;
        setterNode.location = location(node);
      }
      return [{ id: state.setterNodeId }];
    }

    const localTarget = functions.find((candidate) => candidate.name === callee);
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
    return [];
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
    const renderId = 'render:react';
    addNode({ id: renderId, kind: 'render', label: 'UI re-renders', detail: 'React displays the updated state' });
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
            || (!checker && getCallName(candidate.expression) === name)) {
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

function unwrapAwaitedCall(expression: ts.Expression): ts.CallExpression | undefined {
  if (!ts.isCallExpression(expression)) return undefined;
  if (ts.isPropertyAccessExpression(expression.expression)
    && expression.expression.name.text === 'catch'
    && ts.isCallExpression(expression.expression.expression)) {
    return expression.expression.expression;
  }
  return expression;
}

function sameCallable(declaration: ts.Node, target: ts.Node): boolean {
  const canonical = canonicalCallable(declaration);
  const canonicalTarget = canonicalCallable(target);
  return normalizePath(canonical.getSourceFile().fileName) === normalizePath(canonicalTarget.getSourceFile().fileName)
    && canonical.getStart(canonical.getSourceFile()) === canonicalTarget.getStart(canonicalTarget.getSourceFile());
}

function canonicalCallable(node: ts.Node): ts.Node {
  if (ts.isVariableDeclaration(node)
    && node.initializer
    && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
    return node.initializer;
  }
  return node;
}

function findCallableAt(source: ts.SourceFile, offset: number): ts.Node | undefined {
  let result: ts.Node | undefined;
  const visit = (node: ts.Node): void => {
    if (offset < node.getStart(source) || offset >= node.getEnd()) return;
    if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isVariableDeclaration(node)
      || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) result = node;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return result;
}

function resolveCalledDeclaration(call: ts.CallExpression, checker?: ts.TypeChecker): ts.Declaration | undefined {
  if (!checker) return undefined;
  let symbol = checker.getSymbolAtLocation(call.expression);
  if (!symbol && ts.isPropertyAccessExpression(call.expression)) symbol = checker.getSymbolAtLocation(call.expression.name);
  if (!symbol) return undefined;
  if (symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  return (symbol.getDeclarations() ?? []).find((declaration) =>
    ts.isFunctionDeclaration(declaration)
    || ts.isMethodDeclaration(declaration)
    || ts.isVariableDeclaration(declaration)
    || ts.isFunctionExpression(declaration)
    || ts.isArrowFunction(declaration)
  );
}

function getCallName(expression: ts.LeftHandSideExpression): string {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return expression.getText();
}

function getAwaitLabel(expression: ts.Expression, source: ts.SourceFile): string {
  const text = expression.getText(source);
  return text.length > 42 ? `${text.slice(0, 39)}…` : text;
}

function containsOffset(node: ts.Node, source: ts.SourceFile, offset: number): boolean {
  return offset >= node.getStart(source) && offset < node.getEnd();
}

function hasUnclosedBlock(fragment: string): boolean {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, fragment);
  let depth = 0;
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (token === ts.SyntaxKind.OpenBraceToken) depth += 1;
    if (token === ts.SyntaxKind.CloseBraceToken) depth -= 1;
  }
  return depth > 0;
}

function nodeLength(node: ts.Node, source: ts.SourceFile): number {
  return node.getEnd() - node.getStart(source);
}

function locationLength(node: VisualNode): number {
  return node.location ? node.location.end - node.location.start : Number.MAX_SAFE_INTEGER;
}

function hasAsyncModifier(node: ts.FunctionLikeDeclaration): boolean {
  return Boolean(node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword));
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').toLowerCase();
}

function baseName(value: string): string {
  return value.replace(/\\/g, '/').split('/').pop() ?? value;
}

function getJsxElementName(attribute: ts.JsxAttribute): string {
  const element = attribute.parent.parent;
  if (ts.isJsxOpeningElement(element) || ts.isJsxSelfClosingElement(element)) {
    return element.tagName.getText(attribute.getSourceFile());
  }
  return 'UI';
}

function capitalize(value: string): string {
  return value ? value[0].toUpperCase() + value.slice(1) : value;
}
