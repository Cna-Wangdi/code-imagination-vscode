# Changelog

## Unreleased

## 0.2.1 — Marketplace presentation update

- Add a clear quick start and grouped React, Angular, and TypeScript capabilities.
- Add a code-and-graph preview image to the Marketplace overview.
- Add support and diagnostic-reporting guidance.
- Declare free pricing and a dark Marketplace banner.

## 0.2.0 — Public preview

- Recognize Angular `@Component` methods and both inline and external template events.
- Model signal inputs and state, `.set()`, `.update()`, `computed()`, and `effect()` dependencies.
- Show component outputs through `EventEmitter` and the `output()` API.
- Visualize injected-service calls, RxJS pipelines, subscriptions, and next/error callbacks.
- Refresh external-template graphs from saved and unsaved HTML changes with cross-file navigation.
- Add constructor injection, lifecycle hooks, view queries, reactive forms, and two-way bindings.
- Show Router navigation, expandable `HttpClient` requests, common RxJS operators, and Angular template conditions and loops.
- Focus and expand ordinary JavaScript and TypeScript class methods with owner-aware `this.method()` resolution.
- Add source-location-aware HTML parsing for Angular events, inputs, two-way bindings, projection, and hydration attributes.
- Model host bindings/listeners, directives, custom pipes, custom component events, async-pipe consumption, route guards/resolvers, and inherited methods.
- Add NgRx selectors/reducers/effects/store operations, `linkedSignal`, `resource`, `rxResource`, provider metadata, and client render/hydration hooks.
- Show typed `HttpClient` responses and `HttpErrorResponse` flow, with a generated large-component performance regression test.
- Split reusable TypeScript AST, Angular metadata, and Angular template parsing helpers into focused analyzer modules.
- Add a VS Code Extension Host integration test for activation, focused Angular analysis, and cross-file HTML highlighting.
- Keep live cursor analysis syntax-only for responsive large-project updates, while resolving imported calls and project-wide usages on demand.
- Render function calls nested inside branch and loop conditions, and model both paths of ternary expressions.

## 0.1.1 — Private test

- Keep the last function focused when the cursor moves outside a function.
- Animate only edges connected to the highlighted node.
- Model true/false branches, early returns, handled `.catch()` fallbacks, and rethrown errors more accurately.
- Collapse called helper functions by default with an on-demand expansion control.
- Reduce duplicate generic success/error nodes in asynchronous flows.
- Preserve source-order call sequencing and show where branch paths rejoin.
- Summarize `fetch` method and URL, with expandable headers, body fields, and abort signal.
- Describe rejected promises as handled, rethrown, or propagated to the caller instead of assuming they are unhandled.
- Add entire-file visualization and a fit-graph viewport control.
- Add an on-demand **Show usages** view with cross-file call sites and click-to-highlight navigation.

## 0.1.0 — Preview

- Live function-focused mental-model diagrams for JavaScript and TypeScript.
- React `useState` and `useReducer` visualization.
- Named and inline JSX event detection.
- Async success and error paths.
- Cross-file function navigation and source highlighting.
- Live cursor-to-node highlighting with configurable follow-focus.
- Dependency-aware automatic graph layout.
- Incremental TypeScript project caching and analysis diagnostics.
