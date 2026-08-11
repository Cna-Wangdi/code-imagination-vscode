import * as vscode from 'vscode';
import * as path from 'node:path';
import ts from 'typescript';
import { analyzeCode } from './analyzer';
import { getAnalysisScope } from './analysisMode';
import type { SourceLocation, VisualModel, VisualizerSettings } from './model';

export interface CodeImaginationExtensionApi {
  refresh(): Promise<void>;
  getModel(): VisualModel | undefined;
  reveal(location: SourceLocation): Promise<void>;
}

interface DocumentSnapshot {
  fileName: string;
  text: string;
  version: number;
}

interface ProjectConfiguration {
  key: string;
  rootNames: string[];
  options: ts.CompilerOptions;
}

class TypeScriptProjectCache {
  private program?: ts.Program;
  private programKey?: string;
  private dirty = true;
  private readonly documents = new Map<string, DocumentSnapshot>();
  private readonly configurations = new Map<string, ProjectConfiguration>();

  updateDocument(document: vscode.TextDocument): void {
    if (!isSupportedDocument(document) || document.uri.scheme !== 'file') return;
    const key = normalizeFileName(document.fileName);
    const previous = this.documents.get(key);
    if (previous?.version === document.version) return;
    this.documents.set(key, {
      fileName: path.normalize(document.fileName),
      text: document.getText(),
      version: document.version
    });
    this.dirty = true;
  }

  forgetDocument(document: vscode.TextDocument): void {
    if (this.documents.delete(normalizeFileName(document.fileName))) this.dirty = true;
  }

  invalidate(clearConfigurations = false): void {
    this.dirty = true;
    if (clearConfigurations) this.configurations.clear();
  }

  getProgram(document: vscode.TextDocument, scope: 'imports' | 'project'): ts.Program {
    this.updateDocument(document);
    const activeFile = path.normalize(document.fileName);
    const configuration = this.getConfiguration(activeFile);
    const buildKey = scope === 'project'
      ? `${configuration.key}:project`
      : `${configuration.key}:imports:${normalizeFileName(activeFile)}`;
    const existingSource = this.program?.getSourceFiles()
      .some((source) => normalizeFileName(source.fileName) === normalizeFileName(activeFile));

    if (!this.dirty && this.program && this.programKey === buildKey && existingSource) {
      return this.program;
    }

    const rootNames = scope === 'project'
      ? configuration.rootNames.some((file) => normalizeFileName(file) === normalizeFileName(activeFile))
        ? configuration.rootNames
        : [...configuration.rootNames, activeFile]
      : [activeFile];
    const host = ts.createCompilerHost(configuration.options, true);
    const originalGetSourceFile = host.getSourceFile.bind(host);
    host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
      const snapshot = this.documents.get(normalizeFileName(fileName));
      if (snapshot) {
        return ts.createSourceFile(
          fileName,
          snapshot.text,
          languageVersion,
          true,
          scriptKindFor(snapshot.fileName)
        );
      }
      return originalGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
    };

    this.program = ts.createProgram({
      rootNames,
      options: configuration.options,
      host,
      oldProgram: this.programKey === buildKey ? this.program : undefined
    });
    this.programKey = buildKey;
    this.dirty = false;
    return this.program;
  }

  private getConfiguration(activeFile: string): ProjectConfiguration {
    const configPath = ts.findConfigFile(path.dirname(activeFile), ts.sys.fileExists, 'tsconfig.json');
    if (!configPath) {
      const key = `implicit:${normalizeFileName(path.dirname(activeFile))}`;
      return { key, rootNames: [activeFile], options: defaultCompilerOptions() };
    }

    const primary = this.readConfiguration(configPath, activeFile);
    if (primary.rootNames.some((file) => normalizeFileName(file) === normalizeFileName(activeFile))) return primary;

    const candidates = ts.sys.readDirectory(path.dirname(configPath), ['.json'], undefined, ['tsconfig*.json'], 1)
      .filter((candidate) => normalizeFileName(candidate) !== normalizeFileName(configPath));
    for (const candidate of candidates) {
      const configuration = this.readConfiguration(candidate, activeFile);
      if (configuration.rootNames.some((file) => normalizeFileName(file) === normalizeFileName(activeFile))) {
        return configuration;
      }
    }
    return primary;
  }

  private readConfiguration(configPath: string, activeFile: string): ProjectConfiguration {
    const key = normalizeFileName(configPath);
    const cached = this.configurations.get(key);
    if (cached) return cached;
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    const configuration = !config.error
      ? (() => {
        const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath));
        return { key, rootNames: parsed.fileNames, options: parsed.options };
      })()
      : { key, rootNames: [activeFile], options: defaultCompilerOptions() };
    this.configurations.set(key, configuration);
    return configuration;
  }
}

class VisualizerProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private timer?: NodeJS.Timeout;
  private suppressSelectionUpdatesUntil = 0;
  private highlightedEditor?: vscode.TextEditor;
  private lastModel?: VisualModel;
  private analysisSequence = 0;
  private focusedFunction?: { fileName: string; name: string; start: number };
  private expandedFileName?: string;
  private lastAnalyzedFileName?: string;
  private entireFile = false;
  private readonly expandedNodeIds = new Set<string>();
  private readonly expandedUsages = new Map<string, string>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly sourceHighlight: vscode.TextEditorDecorationType,
    private readonly projectCache: TypeScriptProjectCache,
    private readonly output: vscode.OutputChannel
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist')]
    };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((message) => {
      if (message.type === 'ready') {
        this.sendSettings();
        void this.updateNow();
      }
      if (message.type === 'reveal' && message.location) void this.revealLocation(message.location as SourceLocation);
      if (message.type === 'toggleExpand' && typeof message.nodeId === 'string') {
        if (this.expandedNodeIds.has(message.nodeId)) this.expandedNodeIds.delete(message.nodeId);
        else this.expandedNodeIds.add(message.nodeId);
        void this.updateNow();
      }
      if (message.type === 'toggleEntireFile') {
        this.entireFile = !this.entireFile;
        void this.updateNow();
      }
      if (message.type === 'toggleUsages'
        && typeof message.targetId === 'string'
        && typeof message.sourceId === 'string') {
        if (this.expandedUsages.has(message.targetId)) this.expandedUsages.delete(message.targetId);
        else this.expandedUsages.set(message.targetId, message.sourceId);
        void this.updateNow();
      }
    });
  }

  scheduleUpdate(): void {
    if (Date.now() < this.suppressSelectionUpdatesUntil) return;
    if (this.timer) clearTimeout(this.timer);
    const delay = vscode.workspace.getConfiguration('codeImagination').get<number>('updateDelay', 350);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.updateNow();
    }, delay);
  }

  handleSelection(editor: vscode.TextEditor): void {
    if (Date.now() < this.suppressSelectionUpdatesUntil) return;
    if (this.highlightedEditor) {
      this.highlightedEditor.setDecorations(this.sourceHighlight, []);
      this.highlightedEditor = undefined;
    }
    const offset = editor.document.offsetAt(editor.selection.active);
    const fileName = path.normalize(editor.document.fileName).toLowerCase();
    const nodeId = this.lastModel?.nodes
      .filter((node) => node.location
        && path.normalize(node.location.fileName).toLowerCase() === fileName
        && offset >= node.location.start
        && offset <= node.location.end)
      .sort((a, b) => {
        const aSize = a.location ? a.location.end - a.location.start : Number.MAX_SAFE_INTEGER;
        const bSize = b.location ? b.location.end - b.location.start : Number.MAX_SAFE_INTEGER;
        return aSize - bSize;
      })[0]?.id;
    void this.view?.webview.postMessage({ type: 'activeNode', nodeId });
    this.scheduleUpdate();
  }

  async updateNow(): Promise<void> {
    if (!this.view) return;
    const sequence = ++this.analysisSequence;
    await this.view.webview.postMessage({ type: 'analysisStatus', analyzing: true });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    if (sequence !== this.analysisSequence || !this.view) return;

    const startedAt = performance.now();
    const activeEditor = vscode.window.activeTextEditor;
    let analysisDocument = activeEditor && isSupportedDocument(activeEditor.document)
      ? activeEditor.document
      : this.focusedFunction
        ? vscode.workspace.textDocuments.find((document) =>
          isSupportedDocument(document) && normalizeFileName(document.fileName) === this.focusedFunction?.fileName)
        : undefined;
    if (!analysisDocument && this.lastAnalyzedFileName) {
      try {
        analysisDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(this.lastAnalyzedFileName));
      } catch {
        analysisDocument = undefined;
      }
    }
    try {
      let model: VisualModel;
      if (!analysisDocument) {
        model = { fileName: '', languageId: '', nodes: [], edges: [], message: 'Open a JavaScript, TypeScript, JSX, or TSX file to begin.' };
      } else {
        const text = analysisDocument.getText();
        const cursorOffset = activeEditor?.document === analysisDocument
          ? analysisDocument.offsetAt(activeEditor.selection.active)
          : this.focusedFunction?.start ?? 0;
        const normalizedFileName = normalizeFileName(analysisDocument.fileName);
        this.lastAnalyzedFileName = analysisDocument.fileName;
        if (this.expandedFileName !== normalizedFileName) {
          this.expandedFileName = normalizedFileName;
          this.expandedNodeIds.clear();
          this.expandedUsages.clear();
        }
        const analysisScope = getAnalysisScope(this.expandedNodeIds, this.expandedUsages.size);
        const program = analysisScope === 'syntax'
          ? undefined
          : this.projectCache.getProgram(analysisDocument, analysisScope);
        const externalTemplates = await this.loadExternalTemplates(text, analysisDocument.fileName);
        const preferredFunction = this.focusedFunction?.fileName === normalizedFileName
          ? { name: this.focusedFunction.name, start: this.focusedFunction.start }
          : undefined;
        model = analyzeCode(text, analysisDocument.fileName, analysisDocument.languageId, cursorOffset, program, {
          preferredFunction,
          expandedNodeIds: [...this.expandedNodeIds],
          expandedUsages: [...this.expandedUsages].map(([targetId, sourceId]) => ({ targetId, sourceId })),
          externalTemplates,
          entireFile: this.entireFile
        });
        const rootNode = model.rootFunctionId
          ? model.nodes.find((node) => node.id === model.rootFunctionId)
          : undefined;
        if (model.activeFunction && rootNode?.location) {
          this.focusedFunction = {
            fileName: normalizedFileName,
            name: model.activeFunction,
            start: rootNode.location.start
          };
        }
      }
      this.lastModel = model;
      await this.view.webview.postMessage({ type: 'model', model });
      const duration = Math.round(performance.now() - startedAt);
      if (duration >= 100) this.output.appendLine(`[analysis] ${model.fileName || 'no active file'} completed in ${duration}ms`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      this.output.appendLine(`[error] Analysis failed for ${analysisDocument?.fileName ?? 'unknown file'}: ${message}`);
      if (stack) this.output.appendLine(stack);
      const model: VisualModel = {
        fileName: analysisDocument ? path.basename(analysisDocument.fileName) : '',
        languageId: analysisDocument?.languageId ?? '',
        nodes: [],
        edges: [],
        message: 'Analysis failed. Run “Code Imagination: Show Diagnostic Logs” for details.'
      };
      this.lastModel = model;
      await this.view.webview.postMessage({ type: 'model', model });
    } finally {
      if (sequence === this.analysisSequence && this.view) {
        await this.view.webview.postMessage({ type: 'analysisStatus', analyzing: false });
      }
    }
  }

  getModel(): VisualModel | undefined {
    return this.lastModel;
  }

  sendSettings(): void {
    const configuration = vscode.workspace.getConfiguration('codeImagination');
    const settings: VisualizerSettings = {
      followFocus: configuration.get<boolean>('followFocus', true),
      focusAnimationDuration: configuration.get<number>('focusAnimationDuration', 350)
    };
    void this.view?.webview.postMessage({ type: 'settings', settings });
  }

  async revealLocation(location: SourceLocation): Promise<void> {
    const currentEditor = vscode.window.activeTextEditor;
    const targetUri = vscode.Uri.file(location.fileName);

    // Opening another source file emits both active-editor and selection events.
    // Suppress those programmatic events so the graph remains unchanged.
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.suppressSelectionUpdatesUntil = Date.now() + 1500;
    const document = await vscode.workspace.openTextDocument(targetUri);
    const editor = await vscode.window.showTextDocument(document, {
      viewColumn: currentEditor?.viewColumn ?? vscode.ViewColumn.One,
      preserveFocus: false,
      preview: true
    });
    const start = document.positionAt(location.start);
    const end = document.positionAt(location.end);
    const range = new vscode.Range(start, end);

    if (this.highlightedEditor && this.highlightedEditor !== editor) {
      this.highlightedEditor.setDecorations(this.sourceHighlight, []);
    }
    this.highlightedEditor = editor;
    editor.selection = new vscode.Selection(start, end);
    editor.setDecorations(this.sourceHighlight, [range]);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  private async loadExternalTemplates(text: string, componentFile: string): Promise<Array<{ fileName: string; text: string }>> {
    const templates: Array<{ fileName: string; text: string }> = [];
    const pattern = /templateUrl\s*:\s*["']([^"']+)["']/g;
    for (const match of text.matchAll(pattern)) {
      const relativePath = match[1];
      if (!relativePath) continue;
      const fileName = path.resolve(path.dirname(componentFile), relativePath);
      try {
        const openDocument = vscode.workspace.textDocuments.find((document) => normalizeFileName(document.fileName) === normalizeFileName(fileName));
        if (openDocument) {
          templates.push({ fileName, text: openDocument.getText() });
          continue;
        }
        const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(fileName));
        templates.push({ fileName, text: new TextDecoder().decode(bytes) });
      } catch (error) {
        this.output.appendLine(`[angular] Unable to read template ${fileName}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return templates;
  }

  private html(webview: vscode.Webview): string {
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.css'));
    const nonce = Math.random().toString(36).slice(2);
    return `<!doctype html>
      <html lang="en"><head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};">
        <link rel="stylesheet" href="${style}">
        <title>Code Imagination</title>
      </head><body><div id="root"></div><script nonce="${nonce}" src="${script}"></script></body></html>`;
  }
}

export function activate(context: vscode.ExtensionContext): CodeImaginationExtensionApi {
  const sourceHighlight = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
    borderColor: new vscode.ThemeColor('editor.findMatchBorder'),
    borderWidth: '1px',
    borderStyle: 'solid',
    borderRadius: '3px',
    isWholeLine: false,
    overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.findMatchForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Center
  });
  const projectCache = new TypeScriptProjectCache();
  const output = vscode.window.createOutputChannel('Code Imagination', { log: true });
  output.appendLine('[info] Code Imagination activated');
  const provider = new VisualizerProvider(context.extensionUri, sourceHighlight, projectCache, output);
  const sourceWatcher = vscode.workspace.createFileSystemWatcher('**/*.{ts,tsx,js,jsx}');
  const templateWatcher = vscode.workspace.createFileSystemWatcher('**/*.html');
  const configWatcher = vscode.workspace.createFileSystemWatcher('**/tsconfig.json');
  const refreshFromDisk = () => {
    projectCache.invalidate();
    provider.scheduleUpdate();
  };
  const refreshConfiguration = () => {
    projectCache.invalidate(true);
    provider.scheduleUpdate();
  };
  context.subscriptions.push(
    sourceHighlight,
    output,
    sourceWatcher,
    templateWatcher,
    configWatcher,
    sourceWatcher.onDidCreate(refreshFromDisk),
    sourceWatcher.onDidChange(refreshFromDisk),
    sourceWatcher.onDidDelete(refreshFromDisk),
    templateWatcher.onDidCreate(() => provider.scheduleUpdate()),
    templateWatcher.onDidChange(() => provider.scheduleUpdate()),
    templateWatcher.onDidDelete(() => provider.scheduleUpdate()),
    configWatcher.onDidCreate(refreshConfiguration),
    configWatcher.onDidChange(refreshConfiguration),
    configWatcher.onDidDelete(refreshConfiguration),
    vscode.window.registerWebviewViewProvider('codeImagination.visualizer', provider),
    vscode.workspace.onDidChangeTextDocument((event) => {
      projectCache.updateDocument(event.document);
      if (isSupportedDocument(event.document) || event.document.languageId === 'html') provider.scheduleUpdate();
    }),
    vscode.workspace.onDidCloseTextDocument((document) => projectCache.forgetDocument(document)),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('codeImagination')) {
        provider.sendSettings();
        provider.scheduleUpdate();
      }
    }),
    vscode.window.onDidChangeActiveTextEditor(() => provider.scheduleUpdate()),
    vscode.window.onDidChangeTextEditorSelection((event) => provider.handleSelection(event.textEditor)),
    vscode.commands.registerCommand('codeImagination.refresh', () => provider.updateNow()),
    vscode.commands.registerCommand('codeImagination.openBeside', () => vscode.commands.executeCommand('codeImagination.visualizer.focus')),
    vscode.commands.registerCommand('codeImagination.showLogs', () => output.show(true))
  );
  return {
    refresh: () => provider.updateNow(),
    getModel: () => provider.getModel(),
    reveal: (location) => provider.revealLocation(location)
  };
}

export function deactivate(): void {}

function defaultCompilerOptions(): ts.CompilerOptions {
  return {
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    jsx: ts.JsxEmit.ReactJSX,
    allowJs: true,
    checkJs: false,
    skipLibCheck: true
  };
}

function scriptKindFor(fileName: string): ts.ScriptKind {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (lower.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (lower.endsWith('.js')) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function normalizeFileName(fileName: string): string {
  return path.normalize(fileName).toLowerCase();
}

function isSupportedDocument(document: vscode.TextDocument): boolean {
  return ['typescript', 'typescriptreact', 'javascript', 'javascriptreact'].includes(document.languageId);
}
