import ts from 'typescript';
import { getCallName } from './ast';

export function isAngularComponent(node: ts.ClassDeclaration): boolean {
  const decorators = ts.canHaveDecorators(node) ? ts.getDecorators(node) : undefined;
  return Boolean(decorators?.some((decorator) => {
    const expression = decorator.expression;
    return ts.isCallExpression(expression) && getCallName(expression.expression) === 'Component';
  }));
}

export function hasDecorator(node: ts.Node, name: string): boolean {
  const decorators = ts.canHaveDecorators(node) ? ts.getDecorators(node) : undefined;
  return Boolean(decorators?.some((decorator) => {
    const expression = decorator.expression;
    return ts.isCallExpression(expression)
      ? getCallName(expression.expression) === name
      : ts.isIdentifier(expression) && expression.text === name;
  }));
}

export function decoratorArgument(node: ts.Node, name: string): string | undefined {
  const decorators = ts.canHaveDecorators(node) ? ts.getDecorators(node) : undefined;
  const call = decorators
    ?.map((decorator) => decorator.expression)
    .find((expression): expression is ts.CallExpression =>
      ts.isCallExpression(expression) && getCallName(expression.expression) === name
    );
  const argument = call?.arguments[0];
  return argument && ts.isStringLiteralLike(argument) ? argument.text : undefined;
}

export function isAngularLifecycleHook(name: string): boolean {
  return new Set([
    'ngOnChanges', 'ngOnInit', 'ngDoCheck', 'ngAfterContentInit', 'ngAfterContentChecked',
    'ngAfterViewInit', 'ngAfterViewChecked', 'ngOnDestroy'
  ]).has(name);
}

export function referencesAngularProperty(node: ts.Node | undefined, property: string): boolean {
  if (!node) return false;
  let found = false;
  const visit = (candidate: ts.Node): void => {
    if (found) return;
    if ((ts.isPropertyAccessExpression(candidate)
      && candidate.name.text === property
      && candidate.expression.kind === ts.SyntaxKind.ThisKeyword)
      || (ts.isIdentifier(candidate) && candidate.text === property)) {
      found = true;
      return;
    }
    ts.forEachChild(candidate, visit);
  };
  visit(node);
  return found;
}

export function getAngularInlineTemplate(node: ts.ClassDeclaration): { text: string; node: ts.StringLiteralLike } | undefined {
  const metadata = getComponentMetadata(node);
  if (!metadata) return undefined;
  const template = metadata.properties.find((property): property is ts.PropertyAssignment =>
    ts.isPropertyAssignment(property) && propertyName(property) === 'template'
  );
  if (!template || !ts.isStringLiteralLike(template.initializer)) return undefined;
  return { text: template.initializer.text, node: template.initializer };
}

export function getAngularTemplateUrl(node: ts.ClassDeclaration): string | undefined {
  const metadata = getComponentMetadata(node);
  if (!metadata) return undefined;
  const templateUrl = metadata.properties.find((property): property is ts.PropertyAssignment =>
    ts.isPropertyAssignment(property) && propertyName(property) === 'templateUrl'
  );
  return templateUrl && ts.isStringLiteralLike(templateUrl.initializer) ? templateUrl.initializer.text : undefined;
}

export function getAngularProviders(node: ts.ClassDeclaration): ts.Expression[] {
  const metadata = getComponentMetadata(node);
  if (!metadata) return [];
  const providers = metadata.properties.find((property): property is ts.PropertyAssignment =>
    ts.isPropertyAssignment(property) && propertyName(property) === 'providers'
  );
  return providers && ts.isArrayLiteralExpression(providers.initializer) ? [...providers.initializer.elements] : [];
}

function getComponentMetadata(node: ts.ClassDeclaration): ts.ObjectLiteralExpression | undefined {
  const decorators = ts.canHaveDecorators(node) ? ts.getDecorators(node) : undefined;
  const component = decorators
    ?.map((decorator) => decorator.expression)
    .find((expression): expression is ts.CallExpression =>
      ts.isCallExpression(expression) && getCallName(expression.expression) === 'Component'
    );
  const metadata = component?.arguments[0];
  return metadata && ts.isObjectLiteralExpression(metadata) ? metadata : undefined;
}

function propertyName(property: ts.PropertyAssignment): string {
  return property.name.getText(property.getSourceFile()).replace(/["']/g, '');
}
