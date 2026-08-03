import * as esbuild from 'esbuild';
import { mkdir } from 'node:fs/promises';

await mkdir('.test-dist', { recursive: true });
await esbuild.build({
  entryPoints: {
    analyzer: 'src/analyzer.ts',
    graphLayout: 'src/webview/graphLayout.ts'
  },
  bundle: true,
  outdir: '.test-dist',
  outExtension: { '.js': '.cjs' },
  platform: 'node',
  format: 'cjs',
  target: 'node20'
});
