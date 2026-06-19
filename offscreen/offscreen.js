// Xpeaker offscreen document — runs transformers.js on-device (WebGPU → WASM fallback).
// The service worker can't use WebGPU/full WASM, so all generation happens here.
// Messages: SW → {target:'offscreen', t:'ai-generate', reqId, payload} ; we reply via sendResponse
// and broadcast {t:'ai-progress', reqId, progress} during model download.

import { pipeline, env } from '@huggingface/transformers';

// Models are pulled from the HF hub on first use, then cached by the browser.
env.allowLocalModels = false;
// Load the onnxruntime WASM binaries bundled inside the extension (MV3 CSP blocks the CDN).
try { env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('wasm/'); } catch (e) {}

const DEFAULT_MODEL = 'onnx-community/gemma-3-1b-it-ONNX';

let current = null; // { key, gen }
const keyOf = (model, device) => `${model}|${device}`;

async function getGenerator(model, device, onProgress) {
  const key = keyOf(model, device);
  if (current && current.key === key) return current.gen;
  if (current) { try { await current.gen.dispose(); } catch (e) {} current = null; }
  const dtype = device === 'webgpu' ? 'q4f16' : 'q4';
  const gen = await pipeline('text-generation', model, { device, dtype, progress_callback: onProgress });
  current = { key, gen };
  return gen;
}

async function generate(payload, onProgress) {
  const model = payload.model || DEFAULT_MODEL;
  const want = payload.backend || 'auto';
  const order = want === 'wasm' ? ['wasm'] : want === 'webgpu' ? ['webgpu'] : ['webgpu', 'wasm'];
  // Gemma's chat template has no system role — fold any system text into the user turn.
  const content = payload.system ? `${payload.system}\n\n${payload.user}` : payload.user;
  let lastErr;
  for (const device of order) {
    try {
      const gen = await getGenerator(model, device, onProgress);
      const out = await gen([{ role: 'user', content }], {
        max_new_tokens: payload.maxTokens || 256,
        do_sample: false,
        return_full_text: false,
      });
      let text = out && out[0] && out[0].generated_text;
      if (Array.isArray(text)) text = (text[text.length - 1] && text[text.length - 1].content) || '';
      return { text: (text || '').trim(), backend: device };
    } catch (e) {
      lastErr = e; current = null;
      console.warn('[Xpeaker offscreen] generation failed on', device, e);
    }
  }
  throw lastErr || new Error('generation failed');
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
    return true; // keep the message channel open for the async response
  }
});
