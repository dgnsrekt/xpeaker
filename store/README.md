# Store assets

Chrome Web Store listing assets for Xpeaker, and the generators that produce them.
See [`../CHROME_STORE.md`](../CHROME_STORE.md) for the listing copy, permission
justifications, and submission checklist.

```
store/
├── screenshots/   final 1280×800 PNGs uploaded to the store (01 hero · 02 settings · 03 thread)
├── raw/           raw browser captures used as inputs (hero · settings · thread)
└── templates/     self-contained HTML that frames each raw capture into a marketing shot
```

## Regenerate a screenshot

The templates use **relative** paths (`../raw/*.png`, `../../icons/icon128.png`), so they
render anywhere. Each renders to exactly 1280×800 via headless Chrome:

```sh
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
cd store
for pair in hero:01-hero-read-aloud settings:02-settings thread:03-thread-mode; do
  tpl=${pair%%:*}; out=${pair##*:}
  "$CHROME" --headless=new --hide-scrollbars --force-device-scale-factor=1 \
    --window-size=1280,800 --default-background-color=000000ff \
    --screenshot="screenshots/$out.png" --user-data-dir="/tmp/xp_shot_$tpl" \
    "file://$PWD/templates/$tpl.html"
done
```

Chrome exits non-zero (144) after capturing — that's a harmless hang-on-exit; the PNG is
still written. To refresh the product imagery, replace a file in `raw/` (keep the name) and
re-run. To restyle (headline, bullets, layout), edit the matching `templates/*.html`.
