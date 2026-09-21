#!/usr/bin/env bash
# Capture the portfolio screenshots from a running demo (make demo). Usage: scripts/screenshots.sh [out_dir] [base_url]
set -euo pipefail
OUT="${1:-docs/screens}"
BASE="${2:-http://127.0.0.1:8103}"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
mkdir -p "$OUT"
curl -fsS -X POST "$BASE/api/demo/reset" > /dev/null

shot() {
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=2 --window-size=1600,1200 \
    --virtual-time-budget=6000 --screenshot="$OUT/$1" "$BASE$2" > /dev/null 2>&1
  echo "$OUT/$1"
}

shot 01-overview.png "/"
shot 02-incidents.png "/incidents"
shot 03-incident-detail.png "/incidents/issue%3A48377?alert=1007"
shot 04-sent-to-slack.png "/outbox"
shot 05-rules.png "/rules?window=14400"
shot 06-sources-test-event.png "/sources?source=n8n&send=2"
shot 07-incidents-after-test.png "/incidents?source=n8n"
