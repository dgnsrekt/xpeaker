// Bundle the offscreen transformers.js engine into a single ESM file for MV3.
import * as esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['offscreen/offscreen.js'],
  outfile: 'offscreen/offscreen.bundle.js',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  // Node-only optional deps transformers.js probes for — never used in-browser.
  external: ['onnxruntime-node', 'sharp', 'node:fs', 'node:path', 'node:url'],
  logLevel: 'info',
  legalComments: 'none',
  metafile: false,
});
console.log('✓ built offscreen/offscreen.bundle.js');
