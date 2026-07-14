#!/bin/sh
# Render the 440x280 Chrome Web Store promo tile from promo-tile.html via headless Chrome.
# Edit the copy in promo-tile.html, then re-run. (Headless Chrome may linger after writing the
# screenshot — the PNG is produced regardless; Ctrl-C or a timeout is harmless.)
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
cd "$(dirname "$0")" || exit 1
"$CHROME" --headless=new --hide-scrollbars --force-device-scale-factor=1 \
  --window-size=440,280 --default-background-color=000000ff \
  --screenshot="promo-tile.png" --user-data-dir="/tmp/xp_promo" \
  "file://$PWD/promo-tile.html" >/dev/null 2>&1 &
CHILD=$!
sleep 6; kill "$CHILD" 2>/dev/null; pkill -f xp_promo 2>/dev/null
echo "rendered promo-tile.png"; sips -g pixelWidth -g pixelHeight promo-tile.png 2>/dev/null | grep pixel
