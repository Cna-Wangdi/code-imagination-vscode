import * as vscode from 'vscode';
import * as path from 'node:path';
import ts from 'typescript';
import { analyzeCode } from './analyzer';
import type { SourceLocation, VisualModel, VisualizerSettings } from './model';

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

  getProgram(document: vscode.TextDocument): ts.Program {
    this.updateDocument(document);
    const activeFile = path.normalize(document.fileName);
    const configuration = this.getConfiguration(activeFile);
    const existingSource = this.program?.getSourceFiles()
      .some((source) => normalizeFileName(source.fileName) === normalizeFileName(activeFile));

    if (!this.dirty && this.program && this.programKey === configuration.key && existingSource) {
      return this.program;
    }

    const rootNames = configuration.rootNames.some((file) => normalizeFileName(file) === normalizeFileName(activeFile))
      ? configuration.rootNames
      : [...configuration.rootNames, activeFile];
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
      oldProgram: this.programKey === configuration.key ? this.program : undefined
    });
    this.programKey = configuration.key;
    this.dirty = false;
    return this.program;
  }

  private getConfiguration(activeFile: string): ProjectConfiguration {
    const configPath = ts.findConfigFile(path.dirname(activeFile), ts.sys.fileExists, 'tsconfig.json');
    const key = configPath ? normalizeFileName(configPath) : `implicit:${normalizeFileName(path.dirname(activeFile))}`;
    const cached = this.configurations.get(key);
    if (cached) return cached;

    let configuration: ProjectConfiguration;
    if (configPath) {
      const config = ts.readConfigFile(configPath, ts.sys.readFile);
      if (!config.error) {
        const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath));
        configuration = { key, rootNames: parsed.fileNames, options: parsed.options };
      } else {
        configuration = { key, rootNames: [activeFile], options: defaultCompilerOptions() };
      }
    } else {
      configuration = { key, rootNames: [activeFile], options: defaultCompilerOptions() };
    }
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

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly sourceHighlight: vscode.TextEditorDecorationType,
    private readonly projectCache: TypeScriptProjectCache
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
      if (message.type === 'reveal' && message.location) this.reveal(message.location as SourceLocation);
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

    const editor = vscode.window.activeTextEditor;
    let model: VisualModel;
    if (!editor || !['typescript', 'typescriptreact', 'javascript', 'javascriptreact'].includes(editor.document.languageId)) {
      model = { fileName: '', languageId: '', nodes: [], edges: [], message: 'Open a JavaScript, TypeScript, JSX, or TSX file to begin.' };
    } else {
      const text = editor.document.getText();
      const cursorOffset = editor.document.offsetAt(editor.selection.active);
      const program = this.projectCache.getProgram(editor.document);
      model = analyzeCode(text, editor.document.fileName, editor.document.languageId, cursorOffset, program);
    }
    this.lastModel = model;
    await this.view.webview.postMessage({ type: 'model', model });
    if (sequence === this.analysisSequence) {
      await this.view.webview.postMessage({ type: 'analysisStatus', analyzing: false });
    }
  }

  sendSettings(): void {
    const configuration = vscode.workspace.getConfiguration('codeImagination');
    const settings: VisualizerSettings = {
      followFocus: configuration.get<boolean>('followFocus', true),
      focusAnimationDuration: configuration.get<number>('focusAnimationDuration', 350)
    };
    void this.view?.webview.postMessage({ type: 'settings', settings });
  }

  private async reveal(location: SourceLocation): Promise<void> {
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

export function activate(context: vscode.ExtensionContext): void {
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
  const provider = new VisualizerProvider(context.extensionUri, sourceHighlight, projectCache);
  const sourceWatcher = vscode.workspace.createFileSystemWatcher('**/*.{ts,tsx,js,jsx}');
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
    sourceWatcher,
    configWatcher,
    sourceWatcher.onDidCreate(refreshFromDisk),
    sourceWatcher.onDidChange(refreshFromDisk),
    sourceWatcher.onDidDelete(refreshFromDisk),
    configWatcher.onDidCreate(refreshConfiguration),
    configWatcher.onDidChange(refreshConfiguration),
    configWatcher.onDidDelete(refreshConfiguration),
    vscode.window.registerWebviewViewProvider('codeImagination.visualizer', provider),
    vscode.workspace.onDidChangeTextDocument((event) => {
      projectCache.updateDocument(event.document);
      if (isSupportedDocument(event.document)) provider.scheduleUpdate();
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
    vscode.commands.registerCommand('codeImagination.openBeside', () => vscode.commands.executeCommand('codeImagination.visualizer.focus'))
  );
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
