// Copy the onnxruntime-web WASM runtime into the extension (served locally; HF CDN is CSP-blocked).
import { copyFileSync, mkdirSync, existsSync } from 'node:fs';

const dist = 'node_modules/@huggingface/transformers/dist';
const files = ['ort-wasm-simd-threaded.jsep.wasm', 'ort-wasm-simd-threaded.jsep.mjs'];

mkdirSync('wasm', { recursive: true });
for (const f of files) {
  const src = `${dist}/${f}`;
  if (!existsSync(src)) { console.warn('! missing', src); continue; }
  copyFileSync(src, `wasm/${f}`);
  console.log('✓ copied', f);
}
