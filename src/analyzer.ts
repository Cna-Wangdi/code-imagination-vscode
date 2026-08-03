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

interface BranchNodes {
  successId: string;
  errorId: string;
  awaitEnd: number;
}

export function analyzeCode(
  text: string,
  fileName: string,
  languageId: string,
  cursorOffset: number,
  program?: ts.Program
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
    if (!nodes.some((existing) => existing.id === node.id)) nodes.push(node);
  };
  const addEdge = (edge: VisualEdge) => {
    if (!edges.some((existing) => existing.id === edge.id)) edges.push(edge);
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
        label: mode === 'reducer' ? 'reduces' : 'updates',
        animated: true
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
  const active = eventAtCursor ?? functionAtCursor;
  const chosen = active ? [active] : functions.slice(0, 8);

  for (const fn of chosen) {
    const isAsync = hasAsyncModifier(fn.node);
    addNode({
      id: fn.id,
      kind: 'function',
      label: `${fn.name}()`,
      detail: active?.id === fn.id ? `${isAsync ? 'Async f' : 'F'}unction under cursor` : `${isAsync ? 'Async f' : 'F'}unction`,
      location: location(fn.node)
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
      addEdge({ id: `${eventId}->${fn.id}`, source: eventId, target: fn.id, label: 'triggers', animated: true });
    }

    const branchNodes = new Map<string, BranchNodes>();

    function ensureAsyncFlow(node: ts.AwaitExpression, conditionId?: string): void {
      const asyncId = `async:${node.pos}`;
      const callLabel = getAwaitLabel(node.expression, node.getSourceFile());
      const containingTry = findContainingTry(node, fn.node);
      const branchKey = containingTry ? `try:${containingTry.pos}` : `await:${node.pos}`;
      addNode({ id: asyncId, kind: 'async', label: callLabel, detail: 'Awaited asynchronous operation', location: location(node) });
      addEdge({ id: `${conditionId ?? fn.id}->${asyncId}`, source: conditionId ?? fn.id, target: asyncId, label: 'awaits', animated: true });

      let branch = branchNodes.get(branchKey);
      if (!branch) {
        branch = {
          successId: `success:${branchKey}`,
          errorId: `error:${branchKey}`,
          awaitEnd: node.getEnd()
        };
        branchNodes.set(branchKey, branch);
        addNode({ id: branch.successId, kind: 'success', label: 'Success', detail: 'Promise resolved', location: location(node) });
        addNode({
          id: branch.errorId,
          kind: 'error',
          label: 'Error',
          detail: containingTry?.catchClause ? 'Handled by catch' : 'Unhandled rejection path',
          location: containingTry?.catchClause ? location(containingTry.catchClause) : location(node)
        });
      }
      addEdge({ id: `${asyncId}->${branch.successId}`, source: asyncId, target: branch.successId, label: 'resolves', animated: true });
      addEdge({ id: `${asyncId}->${branch.errorId}`, source: asyncId, target: branch.errorId, label: 'rejects' });
    }

    function branchSourceFor(node: ts.Node): string | undefined {
      const containingTry = findContainingTry(node, fn.node);
      if (!containingTry) return undefined;
      const branch = branchNodes.get(`try:${containingTry.pos}`);
      if (!branch) return undefined;
      if (containingTry.catchClause && containsNode(containingTry.catchClause, node)) return branch.errorId;
      if (containsNode(containingTry.tryBlock, node) && node.getStart(source) >= branch.awaitEnd) return branch.successId;
      return undefined;
    }

    function inspect(node: ts.Node, previousCondition?: string): void {
      // Nested functions own their execution scope and get analyzed separately.
      if (node !== fn.node && ts.isFunctionLike(node)) return;

      let conditionId = previousCondition;
      if (ts.isIfStatement(node)) {
        conditionId = `condition:${node.expression.pos}`;
        addNode({ id: conditionId, kind: 'condition', label: node.expression.getText(source), detail: 'Condition', location: location(node.expression) });
        addEdge({ id: `${fn.id}->${conditionId}`, source: fn.id, target: conditionId, label: 'checks' });
      }
      if (ts.isAwaitExpression(node)) ensureAsyncFlow(node, conditionId);

      if (ts.isCallExpression(node)) {
        const callee = node.expression.getText(source);
        const state = states.get(callee);
        if (state) {
          calledSetters.add(state.setterNodeId);
          const executionSource = branchSourceFor(node) ?? conditionId ?? fn.id;
          addEdge({ id: `${executionSource}->${state.setterNodeId}:${node.pos}`, source: executionSource, target: state.setterNodeId, label: state.mode === 'reducer' ? 'dispatches' : 'calls', animated: true });
          const setterNode = nodes.find((item) => item.id === state.setterNodeId);
          if (setterNode) {
            setterNode.detail = state.mode === 'reducer'
              ? `Action: ${node.arguments[0]?.getText(source) ?? 'unknown'}`
              : `${state.value} becomes ${node.arguments[0]?.getText(source) ?? 'a new value'}`;
            setterNode.location = location(node);
          }
        } else {
          const localTarget = functions.find((candidate) => candidate.name === callee);
          if (localTarget && localTarget.id !== fn.id) {
            addNode({ id: localTarget.id, kind: 'function', label: `${localTarget.name}()`, detail: 'Called function', location: location(localTarget.node) });
            addEdge({ id: `${fn.id}->${localTarget.id}:${node.pos}`, source: fn.id, target: localTarget.id, label: 'calls' });
          } else {
            const declaration = resolveCalledDeclaration(node, checker);
            if (declaration && normalizePath(declaration.getSourceFile().fileName) !== normalizePath(fileName)) {
              const targetSource = declaration.getSourceFile();
              if (!targetSource.isDeclarationFile) {
                const targetId = `function:${normalizePath(targetSource.fileName)}:${declaration.getStart(targetSource)}`;
                addNode({ id: targetId, kind: 'function', label: `${callee}()`, detail: `Defined in ${baseName(targetSource.fileName)}`, location: location(declaration) });
                addEdge({ id: `${fn.id}->${targetId}:${node.pos}`, source: fn.id, target: targetId, label: 'calls' });
              }
            }
          }
        }
      }
      ts.forEachChild(node, (child) => inspect(child, conditionId));
    }
    inspect(fn.node);
  }

  if (calledSetters.size) {
    const renderId = 'render:react';
    addNode({ id: renderId, kind: 'render', label: 'UI re-renders', detail: 'React displays the updated state' });
    for (const state of states.values()) {
      if (calledSetters.has(state.setterNodeId)) {
        addEdge({ id: `${state.nodeId}->${renderId}`, source: state.nodeId, target: renderId, label: 'triggers', animated: true });
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
    activeFunction: active?.name,
    activeNodeId,
    nodes,
    edges,
    message: nodes.length ? undefined : 'Write a React function with state to see its mental model.'
  };
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

function findContainingTry(node: ts.Node, boundary: ts.Node): ts.TryStatement | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current && current !== boundary) {
    if (ts.isTryStatement(current)) return current;
    current = current.parent;
  }
  return undefined;
}

function containsNode(container: ts.Node, node: ts.Node): boolean {
  return node.pos >= container.pos && node.end <= container.end;
}

function containsOffset(node: ts.Node, source: ts.SourceFile, offset: number): boolean {
  return offset >= node.getStart(source) && offset <= node.getEnd();
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
