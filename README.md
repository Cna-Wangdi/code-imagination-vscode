# Code Imagination

Code Imagination is an experimental VS Code extension that turns the function under your cursor into a live visual mental model.

> Preview release: the extension currently focuses on React projects written in JavaScript or TypeScript.

The MVP recognizes named and inline JSX event handlers, React `useState` and `useReducer`, true/false branches, branch joins, early returns, ordered call sites, setter and dispatch calls, handled and propagated asynchronous errors, imported local functions, expandable `fetch` request configuration, and the resulting UI re-render in JavaScript and TypeScript files.

Moving the source cursor highlights the smallest matching diagram node and animates only its connected edges without disrupting the graph layout. When the cursor leaves a function, the last focused function remains visible instead of expanding the whole file.

Dependency-aware automatic layout arranges event, function, condition, request, async, state, and render nodes from left to right. Branches are separated and visibly rejoin before subsequent statements. Called helpers and HTTP request details remain collapsed until their **Expand details** control is selected.

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
- Request configuration shows source expressions; values computed only at runtime cannot be predicted.
- Class-based React state is not supported yet.
- Very large monorepos still need broader performance testing.

## Roadmap / TODO

- [ ] Add Angular support:
  - recognize `@Component` class methods and component properties;
  - connect inline and external templates to their component TypeScript files;
  - visualize template events such as `(click)="increment()"`;
  - understand Angular signals and `.set()` / `.update()` state changes;
  - show Angular change detection and the resulting UI update.
- [ ] Add an on-demand **Used by** view for functions:
  - find call sites across the current project;
  - show each usage with its file and line number;
  - open and highlight the selected usage without replacing the current graph;
  - keep usage nodes collapsed until requested so large projects stay readable.
- [ ] Add pluggable language support beyond JavaScript and TypeScript:
  - use VS Code symbol, reference, and call-hierarchy providers for a generic function graph;
  - support function definitions, calls, conditions, async work, and **Used by** references where the installed language tooling provides them;
  - add dedicated analyzers for Python, C#, Java, Go, and Rust incrementally;
  - keep framework-specific state and UI behavior in separate adapters instead of applying React concepts to every language.

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
- Run `pnpm run package:vsix` to produce an installable `code-imagination-0.1.0.vsix`.
- Install the VSIX from **Extensions: Install from VSIX...** in the VS Code Command Palette.
