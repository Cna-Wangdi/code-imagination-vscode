import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTests } from '@vscode/test-electron';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vscodeExecutablePath = process.env.VSCODE_EXECUTABLE_PATH;

try {
  await runTests({
    extensionDevelopmentPath: repositoryRoot,
    extensionTestsPath: path.join(repositoryRoot, '.test-dist', 'integration.cjs'),
    launchArgs: [path.join(repositoryRoot, 'examples'), '--disable-extensions'],
    ...(vscodeExecutablePath ? { vscodeExecutablePath } : { version: 'stable' })
  });
} catch (error) {
  console.error('VS Code integration tests failed.');
  console.error(error);
  process.exitCode = 1;
}
