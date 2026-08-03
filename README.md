# Code Imagination

Code Imagination is an experimental VS Code extension that turns the function under your cursor into a live visual mental model.

The MVP recognizes named and inline JSX event handlers, React `useState` and `useReducer`, conditions, setter and dispatch calls, awaited operations with success/error paths, imported local functions, and the resulting UI re-render in JavaScript and TypeScript files.

Moving the source cursor highlights the smallest matching diagram node and its connected edges without disrupting the graph layout.

Dependency-aware automatic layout arranges event, function, condition, async, state, and render nodes from left to right. Branches are separated automatically, and cursor-only highlighting does not recompute node positions.

The extension caches and incrementally rebuilds its TypeScript project model. Cursor-only movement reuses the existing program, while unsaved document edits, source-file changes, and `tsconfig.json` updates invalidate the relevant analysis safely.

## Run locally

1. Install dependencies with `npm install`.
2. Build with `npm run build`.
3. Press `F5` in VS Code.
4. In the Extension Development Host, open `examples/Counter.tsx`.
5. Select the **Code Imagination** icon in the Activity Bar and put the cursor inside `increment`.

The visualization updates automatically while you type. Click a visual node to reveal and highlight its source code. Imported-function nodes open their defining file without replacing the current visualization.

## Verify and package

- Run `pnpm test` for analyzer tests.
- Run `pnpm run package:vsix` to produce an installable `code-imagination-0.0.1.vsix`.
- Install the VSIX from **Extensions: Install from VSIX...** in the VS Code Command Palette.
