import * as esbuild from 'esbuild';
import { rm } from 'node:fs/promises';

const watch = process.argv.includes('--watch');
const clean = process.argv.includes('--clean');

if (clean) {
  await rm('dist', { recursive: true, force: true });
  process.exit(0);
}

const extensionOptions = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  sourcemap: true,
  external: ['vscode']
};

const webviewOptions = {
  entryPoints: ['src/webview/index.tsx'],
  bundle: true,
  outfile: 'dist/webview.js',
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  sourcemap: true,
  loader: { '.css': 'css' }
};

if (watch) {
  const contexts = await Promise.all([
    esbuild.context(extensionOptions),
    esbuild.context(webviewOptions)
  ]);
  await Promise.all(contexts.map((context) => context.watch()));
  console.log('Watching extension and webview sources...');
} else {
  await Promise.all([esbuild.build(extensionOptions), esbuild.build(webviewOptions)]);
}
