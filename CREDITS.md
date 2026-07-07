# Credits

## Focus Mode background shaders

Xpeaker's Focus Mode backgrounds are GLSL shaders (see the *Architecture* section of the
[README](README.md)). Credit to their authors:

| Shader / scene | By |
|---|---|
| **Aurora**, **Plasma**, **Nebula**, **Tunnel**, **Kaleidoscope**, **Fractal** | [@claudeai](https://x.com/claudeai) |
| **Kleinian** | [@zozuar](https://x.com/zozuar) ([source tweet](https://x.com/zozuar/status/1512791605593653258)) — hand-ported from a [twigl](https://twigl.app) "geekest" (WebGL2) shader into Xpeaker's WebGL1 data-shader convention |
| **Matrix rain**, **Doodle**, **Smash** (interactive scenes) | [@claudeai](https://x.com/claudeai) |
| **Ticker** (bull/bear brand shader) | [@claudeai](https://x.com/claudeai) |
| **Mars** signature shader (fires on [@elonmusk](https://x.com/elonmusk)'s posts) | [@claudeai](https://x.com/claudeai) |

Each shader's author also shows in the Focus dock's background-scene tooltip.

## Third-party dependencies

Bundled under `vendor/` — **not** MIT; each under its own upstream license:

- [Transformers.js](https://github.com/huggingface/transformers.js) — Apache-2.0 — powers the on-device mood classifier.
- [ONNX Runtime](https://github.com/microsoft/onnxruntime) (Web / WASM build) — MIT — the inference engine.

Mood model: [`onnx-community/emotion-english-distilroberta-base-ONNX`](https://huggingface.co/onnx-community/emotion-english-distilroberta-base-ONNX),
downloaded from HuggingFace only when you enable the mood ring, then cached locally.

Neural voices are produced by the separate
[Supertonic Text-to-Speech Voices](https://chromewebstore.google.com/detail/supertonic-text-to-speech/mdoplmghlkjcnegkdhocjbjcncocbdhk)
companion extension.
