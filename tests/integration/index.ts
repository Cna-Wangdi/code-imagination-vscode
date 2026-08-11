import assert from 'node:assert/strict';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { CodeImaginationExtensionApi } from '../../src/extension';

const extensionId = 'code-imagination.code-imagination';

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension<CodeImaginationExtensionApi>(extensionId);
  assert.ok(extension, `Expected ${extensionId} in the Extension Development Host`);

  const api = await extension.activate();
  const commands = await vscode.commands.getCommands(true);
  assert.ok(commands.includes('codeImagination.refresh'));
  assert.ok(commands.includes('codeImagination.openBeside'));
  assert.ok(commands.includes('codeImagination.showLogs'));

  const componentPath = path.join(extension.extensionPath, 'examples', 'AngularDashboard.component.ts');
  const component = await vscode.workspace.openTextDocument(vscode.Uri.file(componentPath));
  const editor = await vscode.window.showTextDocument(component);
  const incrementOffset = component.getText().indexOf('this.count.update');
  assert.notEqual(incrementOffset, -1);
  const incrementPosition = component.positionAt(incrementOffset);
  editor.selection = new vscode.Selection(incrementPosition, incrementPosition);

  await vscode.commands.executeCommand('codeImagination.visualizer.focus');
  await waitFor(() => api.getModel() !== undefined, 'visualizer model');
  await api.refresh();

  const model = api.getModel();
  assert.ok(model, 'Expected a model after refreshing the visualizer');
  assert.equal(model.activeFunction, 'increment');
  assert.ok(model.nodes.some((node) => node.kind === 'setter' && node.label.includes('count.update')));

  const templateEvent = model.nodes.find((node) =>
    node.kind === 'event'
    && node.label === 'Button click'
    && node.location?.fileName.endsWith('AngularDashboard.component.html')
  );
  assert.ok(templateEvent?.location, 'Expected an external-template event with an HTML source location');

  await api.reveal(templateEvent.location);
  const revealedEditor = vscode.window.activeTextEditor;
  assert.ok(revealedEditor);
  assert.equal(normalizePath(revealedEditor.document.fileName), normalizePath(templateEvent.location.fileName));
  assert.equal(revealedEditor.document.offsetAt(revealedEditor.selection.start), templateEvent.location.start);
  assert.equal(revealedEditor.document.offsetAt(revealedEditor.selection.end), templateEvent.location.end);

  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
}

async function waitFor(predicate: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function normalizePath(value: string): string {
  return path.normalize(value).toLowerCase();
}
