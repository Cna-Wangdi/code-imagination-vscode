import ts from 'typescript';
import type { VisualNode } from '../model';

export function unwrapAwaitedCall(expression: ts.Expression): ts.CallExpression | undefined {
  if (!ts.isCallExpression(expression)) return undefined;
  if (ts.isPropertyAccessExpression(expression.expression)
    && expression.expression.name.text === 'catch'
    && ts.isCallExpression(expression.expression.expression)) {
    return expression.expression.expression;
  }
  return expression;
}

export function sameCallable(declaration: ts.Node, target: ts.Node): boolean {
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

export function findCallableAt(source: ts.SourceFile, offset: number): ts.Node | undefined {
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

export function resolveCalledDeclaration(call: ts.CallExpression, checker?: ts.TypeChecker): ts.Declaration | undefined {
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

export function getCallName(expression: ts.LeftHandSideExpression): string {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return expression.getText();
}

export function unresolvedCallMatches(call: ts.CallExpression, target: ts.Node, name: string): boolean {
  if (getCallName(call.expression) !== name) return false;
  const targetClass = containingClass(target);
  if (!targetClass) return ts.isIdentifier(call.expression);
  if (!ts.isPropertyAccessExpression(call.expression)
    || call.expression.expression.kind !== ts.SyntaxKind.ThisKeyword) return false;
  return containingClass(call) === targetClass;
}

export function containingClass(node: ts.Node): ts.ClassDeclaration | undefined {
  let current: ts.Node | undefined = node;
  while (current) {
    if (ts.isClassDeclaration(current)) return current;
    current = current.parent;
  }
  return undefined;
}

export function getAwaitLabel(expression: ts.Expression, source: ts.SourceFile): string {
  const text = expression.getText(source);
  return text.length > 42 ? `${text.slice(0, 39)}…` : text;
}

export function containsOffset(node: ts.Node, source: ts.SourceFile, offset: number): boolean {
  return offset >= node.getStart(source) && offset < node.getEnd();
}

export function hasUnclosedBlock(fragment: string): boolean {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, fragment);
  let depth = 0;
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (token === ts.SyntaxKind.OpenBraceToken) depth += 1;
    if (token === ts.SyntaxKind.CloseBraceToken) depth -= 1;
  }
  return depth > 0;
}

export function nodeLength(node: ts.Node, source: ts.SourceFile): number {
  return node.getEnd() - node.getStart(source);
}

export function locationLength(node: VisualNode): number {
  return node.location ? node.location.end - node.location.start : Number.MAX_SAFE_INTEGER;
}

export function hasAsyncModifier(node: ts.FunctionLikeDeclaration): boolean {
  return Boolean(node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword));
}

export function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').toLowerCase();
}

export function baseName(value: string): string {
  return value.replace(/\\/g, '/').split('/').pop() ?? value;
}

export function getJsxElementName(attribute: ts.JsxAttribute): string {
  const element = attribute.parent.parent;
  if (ts.isJsxOpeningElement(element) || ts.isJsxSelfClosingElement(element)) {
    return element.tagName.getText(attribute.getSourceFile());
  }
  return 'UI';
}

export function capitalize(value: string): string {
  return value ? value[0].toUpperCase() + value.slice(1) : value;
}
