import * as esbuild from 'esbuild';
import { mkdir } from 'node:fs/promises';

await mkdir('.test-dist', { recursive: true });
await esbuild.build({
  entryPoints: ['src/analyzer.ts'],
  bundle: true,
  outfile: '.test-dist/analyzer.cjs',
  platform: 'node',
  format: 'cjs',
  target: 'node20'
});
