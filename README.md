# Code Imagination

Code Imagination is an experimental VS Code extension that turns the function under your cursor into a live visual mental model.

> Preview release: the extension supports React and Angular workflows in JavaScript and TypeScript.

The MVP recognizes standalone functions and ordinary class methods across JavaScript and TypeScript, named and inline JSX event handlers, React `useState` and `useReducer`, Angular `@Component` methods, inline-template events, signals and `.set()` / `.update()`, true/false branches, branch joins, early returns, ordered call sites, handled and propagated asynchronous errors, imported local functions, expandable `fetch` request configuration, on-demand project-wide function usages, and resulting UI updates.

Angular analysis also covers external templates, inputs and outputs, lifecycle and post-render hooks, host listeners/bindings, view queries, reactive forms, two-way bindings, modern template conditions and loops, custom component bindings, async and custom pipes, content projection, constructor and `inject()` dependencies, provider metadata, Router guards/navigation/resolvers, expandable typed `HttpClient` requests, common RxJS pipeline operators, NgRx primitives, modern signal resources, SSR hydration intent, directives, and pipes. Template elements and attributes use a source-location-aware HTML parser; Angular block syntax is scanned separately. These relationships are inferred statically and remain collapsed where detail could make the graph noisy.

Moving the source cursor highlights the smallest matching diagram node and animates only its connected edges without disrupting the graph layout. When the cursor leaves a function, the last focused function remains visible instead of expanding the whole file.

Dependency-aware automatic layout arranges event, function, condition, request, async, state, and render nodes from left to right. Branches are separated and visibly rejoin before subsequent statements. Called helpers and HTTP request details remain collapsed until their **Expand details** control is selected. Live cursor updates use fast syntax analysis; resolving an imported call or searching project-wide usages loads type information on demand.

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
- Runtime-created templates, dynamically selected providers, server-only branches, and values known only after dependency injection cannot be guaranteed by static analysis.
- Request configuration shows source expressions; values computed only at runtime cannot be predicted.
- Class-based React state is not supported yet.
- Very large monorepos still need broader performance testing.

## Roadmap / TODO

- [x] Add Angular support:
  - [x] recognize `@Component` class methods and signal properties;
  - [x] connect inline templates to their component TypeScript files;
  - [x] connect external HTML templates to their component TypeScript files;
  - [x] visualize template events such as `(click)="increment()"`;
  - [x] understand Angular signals and `.set()` / `.update()` state changes;
  - [x] show Angular change detection and the resulting UI update.
  - [x] model inputs, outputs, `EventEmitter`, `computed()`, `effect()`, injected services, and RxJS subscriptions.
  - [x] model lifecycle hooks, view queries, reactive forms, two-way binding, Router navigation, `HttpClient`, common RxJS operators, `*ngIf` / `*ngFor`, and `@if` / `@for`.
  - [x] model host APIs, custom component bindings, async/custom pipes, content projection, NgRx, guards/resolvers, modern resources, providers, and hydration intent.
- [x] Add an on-demand **Used by** view for JavaScript and TypeScript functions:
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

- Run `pnpm test` for analyzer and graph unit tests.
- Run `pnpm run test:integration` to launch a clean VS Code Extension Host and verify activation, Angular analysis, and cross-file source highlighting.
- Run `pnpm run test:all` for type-checking plus both test layers.
- Run `pnpm run package:vsix` to produce an installable `code-imagination-0.2.0.vsix`.
- Install the VSIX from **Extensions: Install from VSIX...** in the VS Code Command Palette.
