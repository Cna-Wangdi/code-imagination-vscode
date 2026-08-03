import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const { analyzeCode } = require('../.test-dist/analyzer.cjs');

function analyzeFixture(name, cursorText) {
  const fileName = path.resolve('examples', name);
  const program = ts.createProgram([fileName], {
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    jsx: ts.JsxEmit.ReactJSX,
    skipLibCheck: true
  });
  const source = program.getSourceFile(fileName);
  assert.ok(source, `Expected ${name} in TypeScript program`);
  const text = source.getFullText();
  const cursorOffset = text.indexOf(cursorText);
  assert.notEqual(cursorOffset, -1, `Expected cursor text ${cursorText}`);
  return { text, model: analyzeCode(text, fileName, 'typescriptreact', cursorOffset, program) };
}

test('maps a named JSX event through state and a cross-file call', () => {
  const { model } = analyzeFixture('Counter.tsx', 'setCount(nextCount');
  assert.equal(model.activeFunction, 'increment');
  assert.ok(model.nodes.some((node) => node.kind === 'event' && node.label === 'Button click'));
  assert.ok(model.nodes.some((node) => node.label === 'nextCount()' && node.location?.fileName.endsWith('counterMath.ts')));
  assert.ok(model.edges.some((edge) => edge.label === 'triggers'));
});

test('analyzes an inline JSX event handler', () => {
  const { model } = analyzeFixture('InlineCounter.tsx', 'setCount(count + 1)');
  assert.equal(model.activeFunction, 'onClick handler');
  assert.ok(model.nodes.some((node) => node.kind === 'event' && node.label === 'Button click'));
  assert.ok(model.nodes.some((node) => node.kind === 'render'));
  assert.ok(model.activeNodeId?.startsWith('setter:setCount'));
});

test('models useReducer state and dispatch actions', () => {
  const { model } = analyzeFixture('ReducerCounter.tsx', "dispatch({ type: 'increment' })");
  const dispatch = model.nodes.find((node) => node.label === 'dispatch(…)');
  assert.ok(dispatch);
  assert.match(dispatch.detail ?? '', /Action:/);
  assert.ok(model.edges.some((edge) => edge.source === dispatch.id && edge.label === 'reduces'));
  assert.ok(model.edges.some((edge) => edge.target === dispatch.id && edge.label === 'dispatches'));
});

test('models awaited operations through one handled catch path', () => {
  const { model } = analyzeFixture('AsyncProfile.tsx', "await fetch('/api/profile')");
  const asyncNodes = model.nodes.filter((node) => node.kind === 'async');
  const catchNode = model.nodes.find((node) => node.kind === 'catch');
  assert.ok(asyncNodes.some((node) => node.label.includes('fetch')));
  assert.equal(asyncNodes.length, 2);
  assert.ok(catchNode);
  assert.ok(model.edges.some((edge) => edge.target === catchNode.id && edge.label === 'rejects'));
  assert.ok(model.edges.some((edge) => edge.source === catchNode.id && edge.target.startsWith('setter:setError')));
  assert.ok(model.edges.some((edge) => edge.target.startsWith('setter:setProfile') && edge.label === 'resolves'));
  assert.ok(model.activeNodeId?.startsWith('async:'));
});

test('keeps a preferred function focused when the cursor moves outside functions', () => {
  const text = `
    function alpha(value) {
      if (!value) return 'fallback';
      return value;
    }

    function beta() {
      return 'beta';
    }
  `;
  const focused = analyzeCode(text, 'focus.ts', 'typescript', text.indexOf('return value'));
  const root = focused.nodes.find((node) => node.id === focused.rootFunctionId);
  assert.equal(focused.activeFunction, 'alpha');
  assert.ok(root?.location);

  const retained = analyzeCode(text, 'focus.ts', 'typescript', 0, undefined, {
    preferredFunction: { name: 'alpha', start: root.location.start }
  });
  assert.equal(retained.activeFunction, 'alpha');
  assert.ok(retained.nodes.some((node) => node.label === 'alpha()'));
  assert.ok(!retained.nodes.some((node) => node.label === 'beta()'));
  assert.equal(retained.activeNodeId, undefined);
});

test('does not expand a whole file when no function has focus', () => {
  const text = `function one() { return 1; }\nfunction two() { return 2; }`;
  const model = analyzeCode(text, 'overview.ts', 'typescript', text.indexOf('\n'));
  assert.equal(model.nodes.length, 0);
  assert.match(model.message ?? '', /cursor inside a function/i);
});

test('treats a catch fallback as handled instead of unhandled', () => {
  const text = `
    async function read(response) {
      const value = await response.text().catch(() => '');
      return value;
    }
  `;
  const model = analyzeCode(text, 'handled.ts', 'typescript', text.indexOf('await response'));
  assert.ok(model.nodes.some((node) => node.kind === 'success' && node.label === 'Fallback'));
  assert.ok(!model.nodes.some((node) => node.detail === 'Unhandled rejection path'));
  assert.ok(model.edges.some((edge) => edge.label === 'caught'));
});

test('distinguishes a catch handler that rethrows', () => {
  const text = `
    async function read(response) {
      return await response.json().catch(() => {
        throw new Error('invalid JSON');
      });
    }
  `;
  const model = analyzeCode(text, 'rethrow.ts', 'typescript', text.indexOf('await response'));
  assert.ok(model.nodes.some((node) => node.kind === 'error' && node.detail === 'Caught and rethrown by .catch()'));
  assert.ok(!model.nodes.some((node) => node.detail === 'Unhandled rejection path'));
  assert.ok(model.edges.some((edge) => edge.label === 'rethrows'));
});

test('connects true and false branches to their early returns', () => {
  const text = `
    function choose(value) {
      if (!value) return 'fallback';
      return 'ok';
    }
  `;
  const model = analyzeCode(text, 'branches.ts', 'typescript', text.indexOf('if (!value)'));
  const condition = model.nodes.find((node) => node.kind === 'condition');
  const returns = model.nodes.filter((node) => node.kind === 'return');
  assert.ok(condition);
  assert.equal(returns.length, 2);
  assert.ok(model.edges.some((edge) => edge.source === condition.id && edge.label === 'true'));
  assert.ok(model.edges.some((edge) => edge.source === condition.id && edge.label === 'false'));
});

test('keeps helper functions collapsed until explicitly expanded', () => {
  const text = `
    function helper(value) {
      if (!value) return 'fallback';
      return value;
    }
    function run(value) {
      return helper(value);
    }
  `;
  const cursor = text.indexOf('return helper');
  const collapsed = analyzeCode(text, 'helpers.ts', 'typescript', cursor);
  const helper = collapsed.nodes.find((node) => node.label === 'helper()');
  assert.ok(helper?.expandable);
  assert.equal(helper.expanded, false);
  assert.ok(!collapsed.nodes.some((node) => node.kind === 'condition'));

  const expanded = analyzeCode(text, 'helpers.ts', 'typescript', cursor, undefined, {
    expandedFunctionIds: [helper.expandId]
  });
  assert.equal(expanded.nodes.find((node) => node.id === helper.id)?.expanded, true);
  assert.ok(expanded.nodes.some((node) => node.kind === 'condition'));
});

test('remains useful while code is syntactically incomplete', () => {
  const text = `
    function Draft() {
      const [count, setCount] = useState(0);
      if (count < ) {
        setCount(count +
  `;
  let model;
  assert.doesNotThrow(() => {
    model = analyzeCode(text, 'Draft.tsx', 'typescriptreact', text.length);
  });
  assert.ok(model.nodes.some((node) => node.label === 'Draft()'));
  assert.ok(model.nodes.some((node) => node.label === 'count'));
});
