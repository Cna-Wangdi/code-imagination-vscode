# Code Imagination

Code Imagination is an experimental VS Code extension that turns the function under your cursor into a live visual mental model.

> Preview release: the extension currently focuses on React projects written in JavaScript or TypeScript.

The MVP recognizes named and inline JSX event handlers, React `useState` and `useReducer`, conditions, setter and dispatch calls, awaited operations with success/error paths, imported local functions, and the resulting UI re-render in JavaScript and TypeScript files.

Moving the source cursor highlights the smallest matching diagram node and its connected edges without disrupting the graph layout.

Dependency-aware automatic layout arranges event, function, condition, async, state, and render nodes from left to right. Branches are separated automatically, and cursor-only highlighting does not recompute node positions.

The extension caches and incrementally rebuilds its TypeScript project model. Cursor-only movement reuses the existing program, while unsaved document edits, source-file changes, and `tsconfig.json` updates invalidate the relevant analysis safely.

## Settings

- `codeImagination.updateDelay` controls the typing debounce.
- `codeImagination.followFocus` enables or disables automatic viewport movement.
- `codeImagination.focusAnimationDuration` controls follow-focus animation speed.

The viewport only moves when the active node is outside the visible canvas. An **ANALYZING** indicator appears while a project model is being refreshed.

## Privacy

All source analysis runs locally in the VS Code extension host. Code Imagination does not upload code, require an account, or call an AI service.

## Current limitations

- Static analysis cannot always resolve dynamic calls or runtime-generated state.
- Class-based React state is not supported yet.
- Very large monorepos still need broader performance testing.
- The Marketplace publisher identifier will be finalized before public release.

If analysis fails, run **Code Imagination: Show Diagnostic Logs** from the Command Palette. Error details are written to the local Code Imagination output channel without including full source contents.

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
