// Xpeaker — shared constants + helpers used by the content script, options page, and
// popup. Plain script (no modules / no build): loaded first in the content_scripts list,
// and via <script src="../shared.js"> in the options/popup pages. Exposes a global `XP`.
'use strict';

var XP = {
  SUPERTONIC_URL: 'https://chromewebstore.google.com/detail/supertonic-text-to-speech/mdoplmghlkjcnegkdhocjbjcncocbdhk',
  SPEED_PRESETS: [1, 1.25, 1.5, 1.75, 2],
  MODES: ['single', 'thread'],

  DEFAULTS: {
    voice: '', speed: 1.0,
    announceAuthor: false, readAltText: true,
    authorVoices: {}, autoVoices: false,
    mode: 'single', direction: 'up', postGapMs: 250, maxChars: 4000,
    pauseOnVideo: true, fallbackToNative: true,
    highlight: 'caption',   // 'off' | 'caption' | 'both'
    keymap: 'default',      // 'default' | 'vim'
    barDensity: 'compact',  // 'compact' | 'expanded'
  },

  // Alt + key. label shows in the expanded bar / options; keys = [key, action].
  KEYMAPS: {
    default: { label: 'Default', keys: [['R', 'read'], ['T', 'thread'], ['S', 'stop'], ['N', 'next'], ['B', 'back'], ['Space', 'pause'], ['↑/↓', 'speed']] },
    vim: { label: 'Vim-ish', keys: [['P', 'read'], ['J', 'down'], ['K', 'up'], ['T', 'thread'], ['Space', 'pause'], ['S', 'stop'], ['H/L', 'speed']] },
  },

  // Merge stored settings over the defaults (cloning the authorVoices map).
  mergeSettings: function (saved) {
    saved = saved || {};
    return Object.assign({}, XP.DEFAULTS, saved, { authorVoices: Object.assign({}, saved.authorVoices || {}) });
  },

  // Prefer voices whose name/engine mentions Supertonic; otherwise any ttsEngine-provided
  // voice (extension engines carry extensionId; native OS voices don't).
  pickEngineVoices: function (all) {
    var named = all.filter(function (v) { return /supertonic/i.test(v.voiceName || '') || /supertonic/i.test(v.extensionId || ''); });
    if (named.length) return named;
    return all.filter(function (v) { return !!v.extensionId; });
  },
};
