import * as esbuild from 'esbuild';
import { mkdir } from 'node:fs/promises';

await mkdir('.test-dist', { recursive: true });
await esbuild.build({
  entryPoints: ['tests/integration/index.ts'],
  bundle: true,
  outfile: '.test-dist/integration.cjs',
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode']
});
