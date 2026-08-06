# Changelog

## Unreleased

- Keep the last function focused when the cursor moves outside a function.
- Animate only edges connected to the highlighted node.
- Model true/false branches, early returns, handled `.catch()` fallbacks, and rethrown errors more accurately.
- Collapse called helper functions by default with an on-demand expansion control.
- Reduce duplicate generic success/error nodes in asynchronous flows.
- Preserve source-order call sequencing and show where branch paths rejoin.
- Summarize `fetch` method and URL, with expandable headers, body fields, and abort signal.
- Describe rejected promises as handled, rethrown, or propagated to the caller instead of assuming they are unhandled.
- Add entire-file visualization and a fit-graph viewport control.

## 0.1.0 — Preview

- Live function-focused mental-model diagrams for JavaScript and TypeScript.
- React `useState` and `useReducer` visualization.
- Named and inline JSX event detection.
- Async success and error paths.
- Cross-file function navigation and source highlighting.
- Live cursor-to-node highlighting with configurable follow-focus.
- Dependency-aware automatic graph layout.
- Incremental TypeScript project caching and analysis diagnostics.
