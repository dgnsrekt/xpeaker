// Xpeaker offscreen document — runs transformers.js on-device.
// The service worker can't use WebGPU/full WASM, so generation happens here.
// All work is SERIALIZED (one load/generate at a time) to avoid concurrent model loads,
// and WebGPU is probed with a timeout before use (it can hang inside an offscreen doc).

import { pipeline, env } from '@huggingface/transformers';

env.allowLocalModels = false; // models come from the HF hub, then browser-cached
try {
  env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('wasm/');
  // An offscreen doc isn't cross-origin-isolated, so SharedArrayBuffer (and ORT's
  // threaded WASM) is unavailable → it aborts. Force single-threaded.
  env.backends.onnx.wasm.numThreads = 1;
  // Keep ORT quiet (verbose floods the console and cripples inference).
  env.backends.onnx.logLevel = 'error';
} catch (e) {}

const DEFAULT_MODEL = 'onnx-community/Qwen2.5-1.5B-Instruct';
const log = (...a) => console.log('[Xpeaker AI]', ...a);

let current = null;             // { key, gen }
let queue = Promise.resolve();  // serialize all jobs
const keyOf = (m, d) => `${m}|${d}`;

async function webgpuOK() {
  try {
    if (typeof navigator === 'undefined' || !navigator.gpu) return false;
    const adapter = await Promise.race([
      navigator.gpu.requestAdapter(),
      new Promise((r) => setTimeout(() => r(null), 3000)),
    ]);
    return !!adapter;
  } catch (e) { return false; }
}

async function loadGenerator(model, device, onProgress) {
  const key = keyOf(model, device);
  if (current && current.key === key) return current.gen;
  if (current) { try { await current.gen.dispose(); } catch (e) {} current = null; }
  const dtype = device === 'webgpu' ? 'q4f16' : 'q4';
  log('loading', model, 'device=' + device, 'dtype=' + dtype);
  const gen = await pipeline('text-generation', model, { device, dtype, progress_callback: onProgress });
  current = { key, gen };
  log('model ready', model, device);
  if (onProgress) onProgress({ status: 'ready' });
  return gen;
}

async function runGenerate(payload, onProgress) {
  const model = payload.model || DEFAULT_MODEL;
  const want = payload.backend || 'auto';
  let primary;
  if (want === 'wasm') primary = 'wasm';
  else if (want === 'webgpu') primary = 'webgpu';
  else primary = (await webgpuOK()) ? 'webgpu' : 'wasm';
  const devices = primary === 'webgpu' ? ['webgpu', 'wasm'] : ['wasm'];
  const messages = [];
  if (payload.system) messages.push({ role: 'system', content: payload.system });
  messages.push({ role: 'user', content: payload.user });
  const folded = [{ role: 'user', content: payload.system ? `${payload.system}\n\n${payload.user}` : payload.user }];
  const genOpts = {
    max_new_tokens: payload.maxTokens || 200,
    do_sample: false,
    repetition_penalty: 1.1,   // mild — high values + no_repeat_ngram push small models into gibberish
    return_full_text: false,
  };
  let lastErr;
  for (const device of devices) {
    try {
      const gen = await loadGenerator(model, device, onProgress);
      log('generating on', device);
      let out;
      try { out = await gen(messages, genOpts); }
      catch (tplErr) { out = await gen(folded, genOpts); } // some templates reject a system role
      let text = out && out[0] && out[0].generated_text;
      if (Array.isArray(text)) text = (text[text.length - 1] && text[text.length - 1].content) || '';
      text = (text || '').trim();
      log('done:', JSON.stringify(text.slice(0, 80)));
      return { text, backend: device };
    } catch (e) {
      lastErr = e; current = null;
      let detail;
      try { detail = (typeof e === 'number') ? ('wasm-abort#' + e) : ((e && (e.stack || e.message)) || String(e)); } catch (_) { detail = String(e); }
      console.error('[Xpeaker AI] failed on', device, detail);
    }
  }
  throw lastErr || new Error('generation failed');
}

// Serialize every job through a single promise chain.
function generate(payload, onProgress) {
  const job = queue.then(() => runGenerate(payload, onProgress));
  queue = job.catch(() => {});
  return job;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return;
  if (msg.t === 'ai-ping') { sendResponse({ ok: true }); return false; }
  if (msg.t === 'ai-generate') {
    generate(msg.payload, (p) => {
      try { chrome.runtime.sendMessage({ t: 'ai-progress', reqId: msg.reqId, progress: p }); } catch (e) {}
    })
      .then((res) => sendResponse({ ok: true, text: res.text, backend: res.backend }))
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true; // async response
  }
});
// --- one-time environment diagnostics ---
try {
  log('ENV',
    'COI=' + (typeof self !== 'undefined' && self.crossOriginIsolated),
    'SAB=' + (typeof SharedArrayBuffer),
    'gpu=' + (typeof navigator !== 'undefined' && !!navigator.gpu),
    'numThreads=' + env.backends.onnx.wasm.numThreads,
    'wasmPaths=' + env.backends.onnx.wasm.wasmPaths);
} catch (e) { log('ENV log failed', String(e)); }
for (const f of ['ort-wasm-simd-threaded.jsep.wasm', 'ort-wasm-simd-threaded.jsep.mjs']) {
  fetch(chrome.runtime.getURL('wasm/' + f))
    .then((r) => log('WASM fetch', f, r.status, r.headers.get('content-type')))
    .catch((e) => log('WASM fetch FAIL', f, String(e)));
}
log('offscreen engine ready');
