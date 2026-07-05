// Xpeaker — MAIN-world bridge.
// Runs in the PAGE's JS context (not the isolated content-script world), so it can
// read React's `__reactFiber$…` expando on tweet nodes — which is INVISIBLE to the
// content script (DOM-node expando properties don't cross the isolated/main world
// boundary). It answers a synchronous DOM event dispatched by the content script by
// stamping the author's follow relationship onto the article as `data-xp-following`
// ("true" | "false" | "unknown"); data attributes ARE readable across worlds.
(function () {
  if (window.__xpeakerMainBridge) return;
  window.__xpeakerMainBridge = true;

  // Find the tweet AUTHOR's legacy-user object (screen_name === author handle) and
  // return its `following` flag. Must NOT match `viewerUser` (the logged-in account,
  // present on every tweet) — that would read our own flag. The author object can sit
  // a couple of levels deep inside a prop, so search shallowly-recursively up the fiber.
  function readFollow(el) {
    try {
      var nameEl = el.querySelector('[data-testid="User-Name"]');
      var hm = nameEl && nameEl.innerText.match(/@(\w+)/);
      var handle = hm ? hm[1].toLowerCase() : null;
      if (!handle) return 'unknown';
      var k = Object.keys(el).find(function (x) { return x.indexOf('__reactFiber$') === 0; });
      if (!k) return 'unknown';
      var hit = function (v) {
        return (v && typeof v === 'object' && typeof v.following === 'boolean'
          && typeof v.screen_name === 'string' && v.screen_name.toLowerCase() === handle)
          ? v.following : undefined;
      };
      var node = el[k], hops = 0;
      while (node && hops < 200) {
        var p = node.memoizedProps;
        if (p && typeof p === 'object') {
          var v1 = Object.values(p);
          for (var i = 0; i < v1.length; i++) {
            var a = v1[i], r = hit(a); if (r !== undefined) return String(r);
            if (a && typeof a === 'object') {
              var v2 = Object.values(a);
              for (var j = 0; j < v2.length; j++) {
                var b = v2[j]; r = hit(b); if (r !== undefined) return String(r);
                if (b && typeof b === 'object') {
                  var v3 = Object.values(b);
                  for (var m = 0; m < v3.length; m++) { r = hit(v3[m]); if (r !== undefined) return String(r); }
                }
              }
            }
          }
        }
        node = node.return; hops++;
      }
    } catch (e) {}
    return 'unknown';
  }

  document.addEventListener('xpeaker-getfollow', function (e) {
    var el = e.target;
    if (el && el.querySelector) el.setAttribute('data-xp-following', readFollow(el));
  }, true);
})();
