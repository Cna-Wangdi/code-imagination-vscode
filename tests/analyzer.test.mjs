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

test('renders every function when entire-file mode is requested', () => {
  const text = `function one() { return 1; }\nfunction two() { return 2; }`;
  const model = analyzeCode(text, 'overview.ts', 'typescript', 0, undefined, { entireFile: true });
  assert.equal(model.entireFile, true);
  assert.equal(model.activeFunction, undefined);
  assert.ok(model.nodes.some((node) => node.label === 'one()'));
  assert.ok(model.nodes.some((node) => node.label === 'two()'));
  assert.equal(model.nodes.filter((node) => node.kind === 'return').length, 2);
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
  assert.ok(!model.nodes.some((node) => node.detail?.includes('propagates to caller')));
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
  assert.ok(model.nodes.some((node) => node.kind === 'error' && node.detail === 'Caught and rethrown; rejection propagates to caller'));
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
    expandedNodeIds: [helper.expandId]
  });
  assert.equal(expanded.nodes.find((node) => node.id === helper.id)?.expanded, true);
  assert.ok(expanded.nodes.some((node) => node.kind === 'condition'));
});

test('preserves call-site execution order', () => {
  const text = `
    function first() { return 1; }
    function second(value) { return value + 1; }
    function run() {
      const value = first();
      return second(value);
    }
  `;
  const model = analyzeCode(text, 'order.ts', 'typescript', text.indexOf('const value'));
  const first = model.nodes.find((node) => node.kind === 'call' && node.label === 'first()');
  const second = model.nodes.find((node) => node.kind === 'call' && node.label === 'second()');
  assert.ok(first && second);
  assert.ok(model.edges.some((edge) => edge.source === first.id && edge.target === second.id));
});

test('joins branch paths before the next statement', () => {
  const text = `
    function first() {}
    function second() {}
    function finish() {}
    function run(flag) {
      if (flag) first(); else second();
      finish();
    }
  `;
  const model = analyzeCode(text, 'merge.ts', 'typescript', text.indexOf('if (flag)'));
  const merge = model.nodes.find((node) => node.kind === 'merge');
  const finish = model.nodes.find((node) => node.kind === 'call' && node.label === 'finish()');
  assert.ok(merge && finish);
  assert.equal(model.edges.filter((edge) => edge.target === merge.id).length, 2);
  assert.ok(model.edges.some((edge) => edge.source === merge.id && edge.target === finish.id));
});

test('summarizes and expands fetch request configuration', () => {
  const text = `
    async function send(snapshot, signal) {
      return await fetch(\`/api/insights\`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ snapshot, signal }),
        signal
      });
    }
  `;
  const cursor = text.indexOf('await fetch');
  const collapsed = analyzeCode(text, 'request.ts', 'typescript', cursor);
  const request = collapsed.nodes.find((node) => node.kind === 'request');
  assert.equal(request?.label, 'POST request');
  assert.equal(request?.expanded, false);
  assert.equal(collapsed.nodes.filter((node) => node.kind === 'config').length, 0);

  const expanded = analyzeCode(text, 'request.ts', 'typescript', cursor, undefined, {
    expandedNodeIds: [request.expandId]
  });
  assert.deepEqual(
    expanded.nodes.filter((node) => node.kind === 'config').map((node) => node.label),
    ['URL', 'Method', 'Headers', 'Body', 'Signal']
  );
  assert.match(expanded.nodes.find((node) => node.label === 'Body')?.detail ?? '', /JSON fields: snapshot, signal/);
});

test('preserves calls nested inside awaited call arguments', () => {
  const text = `
    function prepare() { return 'ready'; }
    async function save(value) { return value; }
    async function run() {
      return await save(prepare());
    }
  `;
  const model = analyzeCode(text, 'await-order.ts', 'typescript', text.indexOf('await save'));
  const prepare = model.nodes.find((node) => node.kind === 'call' && node.label === 'prepare()');
  const save = model.nodes.find((node) => node.kind === 'call' && node.label === 'save()');
  const awaited = model.nodes.find((node) => node.kind === 'async');
  assert.ok(prepare && save && awaited);
  assert.ok(model.edges.some((edge) => edge.source === prepare.id && edge.target === save.id));
  assert.ok(model.edges.some((edge) => edge.source === save.id && edge.target === awaited.id));
});

test('does not claim a dynamic request method is GET', () => {
  const text = `
    async function send(url, request) {
      return await fetch(url, { method: request.method });
    }
  `;
  const model = analyzeCode(text, 'dynamic-method.ts', 'typescript', text.indexOf('await fetch'));
  const request = model.nodes.find((node) => node.kind === 'request');
  assert.equal(request?.label, 'Dynamic request');
  assert.notEqual(request?.label, 'GET request');
});

test('keeps expanded request properties in source order', () => {
  const text = `
    async function send(url, signal) {
      return await fetch(url, {
        signal,
        body: JSON.stringify({ ok: true }),
        headers: { Accept: 'application/json' },
        method: 'POST'
      });
    }
  `;
  const cursor = text.indexOf('await fetch');
  const collapsed = analyzeCode(text, 'request-order.ts', 'typescript', cursor);
  const request = collapsed.nodes.find((node) => node.kind === 'request');
  const expanded = analyzeCode(text, 'request-order.ts', 'typescript', cursor, undefined, {
    expandedNodeIds: [request.expandId]
  });
  assert.deepEqual(
    expanded.nodes.filter((node) => node.kind === 'config').map((node) => node.label),
    ['URL', 'Signal', 'Body', 'Headers', 'Method']
  );
});

test('discovers function usages only when requested', () => {
  const text = `
    function format(value) { return String(value); }
    function first() { return format(1); }
    function second() { return format(2); }
  `;
  const cursor = text.indexOf('function format');
  const collapsed = analyzeCode(text, 'usages.ts', 'typescript', cursor);
  const target = collapsed.nodes.find((node) => node.id === collapsed.rootFunctionId);
  assert.ok(target?.usageTargetId);
  assert.equal(target.usagesExpanded, false);
  assert.equal(collapsed.nodes.filter((node) => node.kind === 'usage').length, 0);

  const expanded = analyzeCode(text, 'usages.ts', 'typescript', cursor, undefined, {
    expandedUsages: [{ targetId: target.usageTargetId, sourceId: target.id }]
  });
  const usages = expanded.nodes.filter((node) => node.kind === 'usage');
  assert.equal(usages.length, 2);
  assert.ok(usages.every((node) => node.label.startsWith('usages.ts:')));
  assert.equal(expanded.edges.filter((edge) => edge.source === target.id && edge.label === 'used by').length, 2);
});

test('shows an explicit empty result when a function has no usages', () => {
  const text = `function unused() { return true; }`;
  const cursor = text.indexOf('function unused');
  const collapsed = analyzeCode(text, 'unused.ts', 'typescript', cursor);
  const target = collapsed.nodes.find((node) => node.id === collapsed.rootFunctionId);
  const expanded = analyzeCode(text, 'unused.ts', 'typescript', cursor, undefined, {
    expandedUsages: [{ targetId: target.usageTargetId, sourceId: target.id }]
  });
  assert.ok(expanded.nodes.some((node) => node.kind === 'usage' && node.label === 'No usages found'));
});

test('discovers imported usages across project files', () => {
  const targetFile = path.resolve('examples', 'counterMath.ts');
  const callerFile = path.resolve('examples', 'Counter.tsx');
  const program = ts.createProgram([targetFile, callerFile], {
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    jsx: ts.JsxEmit.ReactJSX,
    skipLibCheck: true
  });
  const source = program.getSourceFile(targetFile);
  assert.ok(source);
  const text = source.getFullText();
  const cursor = text.indexOf('function nextCount');
  const collapsed = analyzeCode(text, targetFile, 'typescript', cursor, program);
  const target = collapsed.nodes.find((node) => node.id === collapsed.rootFunctionId);
  const expanded = analyzeCode(text, targetFile, 'typescript', cursor, program, {
    expandedUsages: [{ targetId: target.usageTargetId, sourceId: target.id }]
  });
  assert.ok(expanded.nodes.some((node) => node.kind === 'usage'
    && node.location?.fileName.endsWith('Counter.tsx')
    && node.detail?.includes('nextCount(count)')));
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
