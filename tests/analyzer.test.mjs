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

test('models awaited operations with success and error paths', () => {
  const { model } = analyzeFixture('AsyncProfile.tsx', "await fetch('/api/profile')");
  const success = model.nodes.find((node) => node.kind === 'success');
  const error = model.nodes.find((node) => node.kind === 'error');
  assert.ok(model.nodes.some((node) => node.kind === 'async' && node.label.includes('fetch')));
  assert.ok(success);
  assert.ok(error);
  assert.ok(model.edges.some((edge) => edge.source === success.id && edge.target.startsWith('setter:setProfile')));
  assert.ok(model.edges.some((edge) => edge.source === error.id && edge.target.startsWith('setter:setError')));
  assert.ok(model.activeNodeId?.startsWith('async:'));
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
