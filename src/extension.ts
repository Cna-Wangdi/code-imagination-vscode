import * as vscode from 'vscode';
import * as path from 'node:path';
import ts from 'typescript';
import { analyzeCode } from './analyzer';
import type { SourceLocation, VisualModel } from './model';

class VisualizerProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private timer?: NodeJS.Timeout;
  private suppressSelectionUpdatesUntil = 0;
  private highlightedEditor?: vscode.TextEditor;
  private lastModel?: VisualModel;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly sourceHighlight: vscode.TextEditorDecorationType
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist')]
    };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((message) => {
      if (message.type === 'ready') this.updateNow();
      if (message.type === 'reveal' && message.location) this.reveal(message.location as SourceLocation);
    });
  }

  scheduleUpdate(): void {
    if (Date.now() < this.suppressSelectionUpdatesUntil) return;
    if (this.timer) clearTimeout(this.timer);
    const delay = vscode.workspace.getConfiguration('codeImagination').get<number>('updateDelay', 350);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.updateNow();
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

  updateNow(): void {
    if (!this.view) return;
    const editor = vscode.window.activeTextEditor;
    let model: VisualModel;
    if (!editor || !['typescript', 'typescriptreact', 'javascript', 'javascriptreact'].includes(editor.document.languageId)) {
      model = { fileName: '', languageId: '', nodes: [], edges: [], message: 'Open a JavaScript, TypeScript, JSX, or TSX file to begin.' };
    } else {
      const text = editor.document.getText();
      const cursorOffset = editor.document.offsetAt(editor.selection.active);
      const program = createProjectProgram(editor.document, text);
      model = analyzeCode(text, editor.document.fileName, editor.document.languageId, cursorOffset, program);
    }
    this.lastModel = model;
    void this.view.webview.postMessage({ type: 'model', model });
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
  const provider = new VisualizerProvider(context.extensionUri, sourceHighlight);
  context.subscriptions.push(
    sourceHighlight,
    vscode.window.registerWebviewViewProvider('codeImagination.visualizer', provider),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document === vscode.window.activeTextEditor?.document) provider.scheduleUpdate();
    }),
    vscode.window.onDidChangeActiveTextEditor(() => provider.scheduleUpdate()),
    vscode.window.onDidChangeTextEditorSelection((event) => provider.handleSelection(event.textEditor)),
    vscode.commands.registerCommand('codeImagination.refresh', () => provider.updateNow()),
    vscode.commands.registerCommand('codeImagination.openBeside', () => vscode.commands.executeCommand('codeImagination.visualizer.focus'))
  );
}

export function deactivate(): void {}

function createProjectProgram(document: vscode.TextDocument, activeText: string): ts.Program {
  const activeFile = path.normalize(document.fileName);
  const configPath = ts.findConfigFile(path.dirname(activeFile), ts.sys.fileExists, 'tsconfig.json');
  let rootNames = [activeFile];
  let options: ts.CompilerOptions = {
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    jsx: ts.JsxEmit.ReactJSX,
    allowJs: true,
    checkJs: false,
    skipLibCheck: true
  };

  if (configPath) {
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    if (!config.error) {
      const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath));
      rootNames = parsed.fileNames.includes(activeFile) ? parsed.fileNames : [...parsed.fileNames, activeFile];
      options = parsed.options;
    }
  }

  const host = ts.createCompilerHost(options, true);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
    if (path.normalize(fileName).toLowerCase() === activeFile.toLowerCase()) {
      const kind = activeFile.endsWith('.tsx') ? ts.ScriptKind.TSX
        : activeFile.endsWith('.jsx') ? ts.ScriptKind.JSX
        : activeFile.endsWith('.js') ? ts.ScriptKind.JS
        : ts.ScriptKind.TS;
      return ts.createSourceFile(fileName, activeText, languageVersion, true, kind);
    }
    return originalGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
  };

  return ts.createProgram({ rootNames, options, host });
}
