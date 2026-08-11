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

test('renders imported calls before conditions that depend on them', () => {
  const text = `
    import { valueExists } from './values';
    function validate(value) {
      if (valueExists(value)) return false;
      return true;
    }
  `;
  const model = analyzeCode(text, 'condition-call.ts', 'typescript', text.indexOf('valueExists(value)'));
  const call = model.nodes.find((node) => node.label === 'valueExists()');
  const condition = model.nodes.find((node) => node.kind === 'condition' && node.label.includes('valueExists'));
  assert.ok(call?.expandable);
  assert.ok(condition);
  assert.ok(model.edges.some((edge) => edge.source === call.id && edge.target === condition.id && edge.label === 'checks'));
});

test('models calls and both paths in conditional expressions', () => {
  const text = `
    import { canSave, save, skip } from './actions';
    function submit(value) {
      return canSave(value) ? save(value) : skip(value);
    }
  `;
  const model = analyzeCode(text, 'conditional-expression.ts', 'typescript', text.indexOf('canSave(value)'));
  const conditionCall = model.nodes.find((node) => node.label === 'canSave()');
  const condition = model.nodes.find((node) => node.kind === 'condition' && node.detail === 'Conditional expression');
  const save = model.nodes.find((node) => node.label === 'save()');
  const skip = model.nodes.find((node) => node.label === 'skip()');
  assert.ok(conditionCall && condition && save && skip);
  assert.ok(model.edges.some((edge) => edge.source === conditionCall.id && edge.target === condition.id && edge.label === 'checks'));
  assert.ok(model.edges.some((edge) => edge.source === condition.id && edge.target === save.id && edge.label === 'true'));
  assert.ok(model.edges.some((edge) => edge.source === condition.id && edge.target === skip.id && edge.label === 'false'));
});

test('keeps imported calls visible without eagerly loading their project', () => {
  const text = `
    import { calculate } from './calculator';
    function run() {
      return calculate(42);
    }
  `;
  const model = analyzeCode(text, 'fast.ts', 'typescript', text.indexOf('calculate(42)'));
  const importedCall = model.nodes.find((node) => node.label === 'calculate()');
  assert.ok(importedCall);
  assert.equal(importedCall.expandable, true);
  assert.match(importedCall.detail ?? '', /resolve source on demand/);
  assert.ok(importedCall.expandId?.startsWith('resolve-call:'));
});

test('models an Angular inline-template event and signal update', () => {
  const text = `
    @Component({
      selector: 'app-counter',
      template: \`<button (click)="increment()">{{ count() }}</button>\`
    })
    export class CounterComponent {
      count = signal(0);
      increment() {
        if (this.count() < 10) this.count.update(current => current + 1);
      }
    }
  `;
  const model = analyzeCode(text, 'counter.component.ts', 'typescript', text.indexOf('this.count.update'));
  assert.equal(model.activeFunction, 'increment');
  assert.ok(model.nodes.some((node) => node.kind === 'event' && node.label === 'Button click'));
  assert.ok(model.nodes.some((node) => node.kind === 'state'
    && node.label === 'count'
    && node.detail?.includes('Angular signal initial value: 0')));
  const update = model.nodes.find((node) => node.kind === 'setter' && node.label === 'count.update(…)');
  assert.ok(update?.detail?.includes('current => current + 1'));
  assert.ok(model.nodes.some((node) => node.kind === 'render'
    && node.label === 'Template updates'
    && node.detail?.includes('Angular change detection')));
  assert.ok(model.edges.some((edge) => edge.target === update.id && edge.label === 'true'));
});

test('models Angular signal set separately from update', () => {
  const text = `
    @Component({ template: \`<button (click)="reset()">Reset</button>\` })
    class CounterComponent {
      count = signal(10);
      reset() { this.count.set(0); }
    }
  `;
  const model = analyzeCode(text, 'counter.component.ts', 'typescript', text.indexOf('this.count.set'));
  assert.equal(model.activeFunction, 'reset');
  assert.ok(model.nodes.some((node) => node.kind === 'setter'
    && node.label === 'count.set(…)'
    && node.detail === 'count becomes 0'));
  assert.ok(model.nodes.some((node) => node.kind === 'event' && node.detail === '(click) evaluates reset()'));
});

test('focuses methods in ordinary TypeScript classes without adding Angular behavior', () => {
  const text = `class Service { run() { return true; } }`;
  const model = analyzeCode(text, 'service.ts', 'typescript', text.indexOf('return true'));
  assert.equal(model.activeFunction, 'run');
  assert.ok(model.nodes.some((node) => node.kind === 'function' && node.label === 'run()' && node.detail?.includes('method under cursor')));
  assert.ok(model.nodes.some((node) => node.kind === 'return'));
  assert.ok(!model.nodes.some((node) => node.kind === 'render'));
});

test('resolves this-method calls within the owning class', () => {
  const text = `
    class FirstService {
      save() { return 'first'; }
    }
    class SecondService {
      save() { return 'second'; }
      run() { return this.save(); }
    }
  `;
  const model = analyzeCode(text, 'services.ts', 'typescript', text.indexOf('return this.save'));
  const call = model.nodes.find((node) => node.kind === 'call' && node.label === 'save()');
  assert.ok(call?.location?.start > text.indexOf('run()'));
  const expanded = analyzeCode(text, 'services.ts', 'typescript', text.indexOf('return this.save'), undefined, {
    expandedNodeIds: [call.expandId]
  });
  const expandedMethod = expanded.nodes.find((node) => node.kind === 'function'
    && node.label === 'save()'
    && node.location?.start > text.indexOf('SecondService'));
  assert.ok(expandedMethod);
  assert.ok(!expanded.nodes.some((node) => node.kind === 'function'
    && node.label === 'save()'
    && node.location?.start < text.indexOf('SecondService')));
});

test('connects an external Angular template event to its component method', () => {
  const text = `
    @Component({ templateUrl: './counter.component.html' })
    class CounterComponent {
      count = signal(0);
      increment() { this.count.update(value => value + 1); }
    }
  `;
  const templateText = `<h1>{{ count() }}</h1>\n<button (click)="increment()">Increment</button>`;
  const templateFile = path.resolve('counter.component.html');
  const model = analyzeCode(text, path.resolve('counter.component.ts'), 'typescript', text.indexOf('this.count.update'), undefined, {
    externalTemplates: [{ fileName: templateFile, text: templateText }]
  });
  const event = model.nodes.find((node) => node.kind === 'event' && node.label === 'Button click');
  assert.ok(event?.location?.fileName.endsWith('counter.component.html'));
  assert.equal(event.location.line, 1);
  assert.ok(model.edges.some((edge) => edge.source === event.id && edge.label === 'triggers'));
});

test('matches external events to the component that owns the template URL', () => {
  const text = `
    @Component({ templateUrl: './first.html' })
    class FirstComponent { save() { return 'first'; } }
    @Component({ templateUrl: './second.html' })
    class SecondComponent { save() { return 'second'; } }
  `;
  const model = analyzeCode(text, path.resolve('components.ts'), 'typescript', text.indexOf("return 'second'"), undefined, {
    externalTemplates: [{ fileName: path.resolve('second.html'), text: `<button (click)="save()">Save</button>` }]
  });
  const event = model.nodes.find((node) => node.kind === 'event');
  const second = model.nodes.find((node) => node.label === 'save()' && node.location?.start > text.indexOf('SecondComponent'));
  assert.ok(event && second);
  assert.ok(model.edges.some((edge) => edge.source === event.id && edge.target === second.id));
});

test('models Angular inputs, outputs, computed signals, effects, services, and Observables', () => {
  const text = `
    @Component({ template: \`<button (click)="save()">Save</button>\` })
    class DashboardComponent {
      @Input() title = 'Dashboard';
      requiredName = input.required<string>();
      @Output() saved = new EventEmitter<number>();
      modernSaved = output<number>();
      api = inject(DashboardService);
      count = signal(1);
      doubled = computed(() => this.count() * 2);
      logChanges = effect(() => console.log(this.count()));

      save() {
        this.api.save(this.count()).pipe(map(value => value)).subscribe({
          next: value => this.saved.emit(value),
          error: error => console.error(error)
        });
      }
    }
  `;
  const model = analyzeCode(text, 'dashboard.component.ts', 'typescript', text.indexOf('this.api.save'));
  assert.ok(model.nodes.some((node) => node.kind === 'state' && node.label === 'title' && node.detail === 'Angular component input'));
  assert.ok(model.nodes.some((node) => node.kind === 'state' && node.label === 'requiredName' && node.detail === 'Angular signal input'));
  assert.ok(model.nodes.some((node) => node.kind === 'state' && node.label === 'doubled' && node.detail === 'Computed Angular signal'));
  assert.ok(model.nodes.some((node) => node.kind === 'call' && node.label === 'logChanges effect'));
  assert.ok(model.edges.some((edge) => edge.label === 'derives'));
  assert.ok(model.edges.some((edge) => edge.label === 'triggers'
    && model.nodes.find((node) => node.id === edge.target)?.label === 'logChanges effect'));
  assert.ok(model.nodes.some((node) => node.kind === 'config' && node.label === 'api: DashboardService'));
  assert.ok(model.nodes.some((node) => node.kind === 'call' && node.label === 'DashboardService.save()'));
  assert.ok(model.nodes.some((node) => node.kind === 'async' && node.label === 'Observable pipeline'));
  const subscription = model.nodes.find((node) => node.kind === 'async' && node.label === 'subscribe()');
  const next = model.nodes.find((node) => node.kind === 'success' && node.label === 'Observable next');
  const observableError = model.nodes.find((node) => node.kind === 'error' && node.label === 'Observable error');
  const output = model.nodes.find((node) => node.kind === 'event' && node.label === 'saved output');
  assert.ok(subscription && next && observableError && output);
  assert.ok(model.edges.some((edge) => edge.source === subscription.id && edge.target === next.id && edge.label === 'next'));
  assert.ok(model.edges.some((edge) => edge.source === subscription.id && edge.target === observableError.id && edge.label === 'error'));
  assert.ok(model.edges.some((edge) => edge.source === next.id && edge.target === output.id && edge.label === 'emits'));
  assert.ok(output.detail?.includes('EventEmitter'));
  assert.ok(model.nodes.some((node) => node.kind === 'event' && node.label === 'modernSaved output'));
});

test('models Angular lifecycle, ViewChild, reactive forms, two-way binding, and template control flow', () => {
  const text = `
    @Component({ template: \`
      <input [(ngModel)]="name">
      @if (visible) { <p>Visible</p> }
      @for (item of items; track item) { <span>{{ item }}</span> }
    \` })
    class EditorComponent {
      @ViewChild('field') field;
      visible = signal(true);
      items = signal([]);
      form = new FormGroup({ name: new FormControl('') });
      ngOnInit() { this.form.patchValue({ name: 'ready' }); }
    }
  `;
  const model = analyzeCode(text, 'editor.component.ts', 'typescript', text.indexOf('this.form.patchValue'));
  assert.equal(model.activeFunction, 'ngOnInit');
  assert.ok(model.nodes.some((node) => node.kind === 'event' && node.label === 'ngOnInit'));
  assert.ok(model.nodes.some((node) => node.kind === 'config' && node.detail === 'Angular ViewChild query'));
  assert.ok(model.nodes.some((node) => node.kind === 'state' && node.label === 'form' && node.detail === 'Angular reactive FormGroup'));
  assert.ok(model.nodes.some((node) => node.kind === 'setter' && node.label === 'form.patchValue(…)'));
  assert.ok(model.nodes.some((node) => node.kind === 'event' && node.detail === 'Two-way binding updates name'));
  assert.ok(model.nodes.some((node) => node.kind === 'condition' && node.detail === 'Angular template condition'));
  assert.ok(model.nodes.some((node) => node.kind === 'condition' && node.detail === 'Angular template loop'));
  assert.ok(model.nodes.some((node) => node.kind === 'render' && node.label === 'Template updates'));
});

test('models constructor injection, router navigation, HttpClient details, and richer RxJS operators', () => {
  const text = `
    @Component({ template: \`<button (click)="load()">Load</button>\` })
    class DataComponent {
      constructor(private router: Router, private http: HttpClient) {}
      go() { this.router.navigate(['/home']); }
      load() {
        this.http.post<Item[]>('/api/items', { active: true }, { headers: authHeaders })
          .pipe(tap(value => value), switchMap(() => this.http.get('/api/next')), catchError(error => fallback(error)))
          .subscribe(value => console.log(value));
      }
    }
  `;
  const routerModel = analyzeCode(text, 'data.component.ts', 'typescript', text.indexOf('this.router.navigate'));
  assert.ok(routerModel.nodes.some((node) => node.kind === 'config'
    && node.label === 'router: Router'
    && node.detail === 'Constructor-injected Angular service'));
  assert.ok(routerModel.nodes.some((node) => node.kind === 'call'
    && node.label === 'Router.navigate()'
    && node.detail?.includes("['/home']")));

  const cursor = text.indexOf('this.http.post');
  const collapsed = analyzeCode(text, 'data.component.ts', 'typescript', cursor);
  const request = collapsed.nodes.find((node) => node.kind === 'request');
  assert.equal(request?.label, 'POST request');
  assert.ok(request?.detail?.includes('/api/items'));
  assert.ok(request?.detail?.includes('response Item[]'));
  assert.ok(collapsed.nodes.some((node) => node.kind === 'error' && node.label === 'HttpErrorResponse'));
  assert.ok(collapsed.nodes.some((node) => node.kind === 'call' && node.label === 'tap()'));
  assert.ok(collapsed.nodes.some((node) => node.kind === 'async' && node.label === 'switchMap()'));
  assert.ok(collapsed.nodes.some((node) => node.kind === 'catch' && node.label === 'catchError()'));
  assert.ok(collapsed.nodes.some((node) => node.kind === 'request' && node.label === 'GET request' && node.detail?.includes('/api/next')));

  const expanded = analyzeCode(text, 'data.component.ts', 'typescript', cursor, undefined, {
    expandedNodeIds: [request.expandId]
  });
  assert.deepEqual(
    expanded.nodes.filter((node) => node.kind === 'config' && node.id.includes('http-client')).map((node) => node.label),
    ['URL', 'Body', 'Options']
  );
});

test('models custom component bindings, event arguments, async pipes, projection, and hydration intent', () => {
  const text = `
    @Component({ template: \`
      <child-panel [value]="count()" (saved)="handleSaved($event)"></child-panel>
      <section ngSkipHydration>{{ users$ | async | json }}</section>
      <ng-content select="[actions]"></ng-content>
    \` })
    class HostComponent {
      count = signal(0);
      handleSaved(value) { this.count.set(value); }
    }
  `;
  const model = analyzeCode(text, 'host.component.ts', 'typescript', text.indexOf('this.count.set'));
  assert.ok(model.nodes.some((node) => node.kind === 'event'
    && node.label === 'Child-panel saved'
    && node.detail?.includes('handleSaved($event)')));
  assert.ok(model.nodes.some((node) => node.kind === 'config' && node.label === '[value]'));
  assert.ok(model.nodes.some((node) => node.kind === 'async' && node.label === 'users$ | async'));
  assert.ok(model.nodes.some((node) => node.kind === 'call' && node.label === 'json pipe'));
  assert.ok(model.nodes.some((node) => node.kind === 'render' && node.label === 'Projected content'));
  assert.ok(model.nodes.some((node) => node.kind === 'config' && node.label === 'Skip hydration'));
});

test('models host APIs, pipes, guards, and resolvers', () => {
  const text = `
    @Directive({ selector: '[keyboard]' })
    class KeyboardDirective {
      @HostBinding('class.active') active = false;
      @HostListener('keydown.enter') onEnter() { this.active = true; }
    }
    @Pipe({ name: 'label' })
    class LabelPipe { transform(value) { return String(value); } }
    class AuthGuard { canActivate() { return true; } }
    class UserResolver { resolve() { return {}; } }
  `;
  const model = analyzeCode(text, 'angular-artifacts.ts', 'typescript', 0, undefined, { entireFile: true });
  assert.ok(model.nodes.some((node) => node.kind === 'config' && node.label === '@HostBinding class.active'));
  assert.ok(model.nodes.some((node) => node.kind === 'event' && node.label === 'Host keydown.enter'));
  assert.ok(model.nodes.some((node) => node.kind === 'event' && node.label === 'Pipe transform'));
  assert.ok(model.nodes.some((node) => node.kind === 'event' && node.label === 'Route guard canActivate'));
  assert.ok(model.nodes.some((node) => node.kind === 'event' && node.label === 'Route resolver'));
});

test('models NgRx, modern Angular resources, providers, and render hooks', () => {
  const text = `
    const selectCount = createSelector(selectFeature, state => state.count);
    const reducer = createReducer(initialState, on(increment, state => state));
    provideClientHydration();
    @Component({ template: \`<button (click)="reload()">Reload</button>\`, providers: [API_TOKEN, { provide: MODE, useValue: 'test' }] })
    class ResourceComponent {
      count = linkedSignal(() => 1);
      data = resource({ loader: () => fetch('/api') });
      users = rxResource({ stream: () => users$ });
      constructor() { afterNextRender(() => console.log('rendered')); }
      reload() { this.data.reload(); }
    }
    @Injectable()
    class FeatureEffects {
      store = inject(Store<AppState>);
      load$ = createEffect(() => actions$);
      update() { this.store.dispatch(increment()); return this.store.select(selectCount); }
    }
  `;
  const model = analyzeCode(text, 'state.ts', 'typescript', text.indexOf('this.store.dispatch'), undefined, { entireFile: true });
  assert.ok(model.nodes.some((node) => node.kind === 'state' && node.label === 'selectCount' && node.detail === 'NgRx memoized selector'));
  assert.ok(model.nodes.some((node) => node.kind === 'config' && node.label === 'reducer' && node.detail === 'NgRx reducer'));
  assert.ok(model.nodes.some((node) => node.kind === 'async' && node.label === 'load$ effect'));
  assert.ok(model.nodes.some((node) => node.kind === 'event' && node.label === 'Store dispatch'));
  assert.ok(model.nodes.some((node) => node.kind === 'state' && node.label === 'Store select'));
  assert.ok(model.nodes.some((node) => node.kind === 'state' && node.label === 'count' && node.detail?.includes('linked signal')));
  assert.ok(model.nodes.some((node) => node.kind === 'async' && node.label === 'data'));
  assert.ok(model.nodes.some((node) => node.kind === 'async' && node.label === 'users'));
  assert.ok(model.nodes.some((node) => node.kind === 'event' && node.label === 'afterNextRender()'));
  assert.ok(model.nodes.some((node) => node.kind === 'config' && node.label === 'Client hydration'));
  assert.equal(model.nodes.filter((node) => node.kind === 'config' && node.detail === 'Angular component provider').length, 2);
});

test('resolves inherited this-method calls with a TypeScript program', () => {
  const fileName = path.resolve('examples', 'ClassInheritance.ts');
  const program = ts.createProgram([fileName], {
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    skipLibCheck: true
  });
  const source = program.getSourceFile(fileName);
  assert.ok(source);
  const text = source.getFullText();
  const model = analyzeCode(text, fileName, 'typescript', text.indexOf('this.normalize'), program);
  const call = model.nodes.find((node) => node.kind === 'call' && node.label === 'normalize()');
  assert.ok(call?.expandId);
  const expanded = analyzeCode(text, fileName, 'typescript', text.indexOf('this.normalize'), program, {
    expandedNodeIds: [call.expandId]
  });
  assert.ok(expanded.nodes.some((node) => node.kind === 'function' && node.label === 'normalize()'));
});

test('keeps large Angular files within a practical analysis budget', () => {
  const methods = Array.from({ length: 300 }, (_, index) => `method${index}() { if (${index} % 2) return ${index}; return ${index + 1}; }`).join('\n');
  const text = `@Component({ template: \`<button (click)="method299()">Run</button>\` }) class LargeComponent { ${methods} }`;
  const started = performance.now();
  const model = analyzeCode(text, 'large.component.ts', 'typescript', text.indexOf('method299() {'));
  const duration = performance.now() - started;
  assert.equal(model.activeFunction, 'method299');
  assert.ok(duration < 2000, `Expected analysis under 2000ms, received ${Math.round(duration)}ms`);
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
