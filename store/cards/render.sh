#!/bin/sh
# Render the 8 Xpeaker feature cards (1600x900) from card.html via headless Chrome.
# Edit the CARDS array in card.html to change copy, then re-run.
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
cd "$(dirname "$0")" || exit 1
for i in 1 2 3 4 5 6 7 8; do
  "$CHROME" --headless=new --hide-scrollbars --force-device-scale-factor=1 \
    --window-size=1600,900 --default-background-color=000000ff \
    --screenshot="card-0$i.png" --user-data-dir="/tmp/xp_card$i" \
    "file://$PWD/card.html?i=$i" >/dev/null 2>&1
  echo "rendered card-0$i.png"
done
