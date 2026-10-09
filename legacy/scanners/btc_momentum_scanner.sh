#!/usr/bin/env bash
# BTCUSDT momentum scanner.
#
# Data source: Binance public REST API (api.binance.com/api/v3/ticker/24hr),
# no auth required. Verified reachable via plain curl with no bot-protection
# issues (unlike Benzinga below).
#
# Catalyst source: Benzinga. The user-facing quote page for Bitcoin is
# benzinga.com/quote/BTC-USD - NOT /quote/BTCUSD (no dash), which 404s
# ("BTCUSD - Not Found"), verified directly before writing this script.
# Benzinga sits behind Cloudflare bot management that fingerprints the TLS
# client, not just headers - curl.exe (Schannel-backed on Windows) gets
# through where Node's fetch or Python's requests/urllib get a 403 challenge
# page. All Benzinga fetches below MUST go through curl for that reason.
#
# The one-sentence catalyst + verbatim headlines are produced by asking the
# Anthropic API to summarize the scraped Benzinga headlines/teasers with the
# user's exact prompt text - set ANTHROPIC_API_KEY for that step to run;
# without it, catalyst/headlines come back null/[] (the rest of the scan
# still runs and saves normally).
set -uo pipefail

SYMBOL="BTCUSDT"
BENZINGA_SYMBOL="BTC-USD"  # see note above - NOT "BTCUSD" as literally requested
ANTHROPIC_MODEL="claude-haiku-4-5-20251001"
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"
BINANCE_URL="https://api.binance.com/api/v3/ticker/24hr?symbol=${SYMBOL}"

# cygpath -m gives a forward-slash Windows path (C:/Users/...) that both MSYS
# tools (curl, cat) and the native Windows python3 on this machine can
# resolve - plain MSYS paths like /tmp/xxx or /d/... are invisible to it.
to_win_path() { command -v cygpath >/dev/null 2>&1 && cygpath -m "$1" || echo "$1"; }

SCRIPT_DIR="$(to_win_path "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)")"
TIMESTAMP=$(date -u +"%Y-%m-%d_%H%MUTC")
OUT_FILE="$SCRIPT_DIR/btc_scan_${TIMESTAMP}.json"
SCANNED_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

TMP_DIR="$(to_win_path "$(mktemp -d)")"
trap 'rm -rf "$TMP_DIR"' EXIT

log() { echo "$1" >&2; }

# ---- 1. Fetch Binance 24hr ticker ----
log "Fetching BTCUSDT 24hr ticker from Binance..."
FETCH_OK=0
for attempt in 1 2 3; do
  if curl -s -m 15 -A "$UA" "$BINANCE_URL" -o "$TMP_DIR/binance.json" && [ -s "$TMP_DIR/binance.json" ]; then
    FETCH_OK=1
    break
  fi
  log "  fetch attempt $attempt failed, retrying..."
done
if [ "$FETCH_OK" -ne 1 ]; then
  log "ERROR: failed to fetch $BINANCE_URL after 3 attempts"
  exit 1
fi

# ---- 2. Parse + compute fields ----
python3 - "$TMP_DIR/binance.json" > "$TMP_DIR/parsed.json" <<'PYEOF'
import json, sys

with open(sys.argv[1], encoding="utf-8") as f:
    d = json.load(f)

if "code" in d and "msg" in d:
    print(json.dumps({"error": f"Binance API error {d['code']}: {d['msg']}"}))
    sys.exit(0)

out = {
    "price": float(d["lastPrice"]),
    "change_pct_24h": float(d["priceChangePercent"]),
    "high_24h": float(d["highPrice"]),
    "low_24h": float(d["lowPrice"]),
    "volume_24h_btc": float(d["volume"]),
    "volume_24h_usdt": float(d["quoteVolume"]),  # computed per spec's COMPUTE section, kept outside the strict OUTPUT schema
}
print(json.dumps(out))
PYEOF

if [ ! -s "$TMP_DIR/parsed.json" ]; then
  log "ERROR: failed to parse Binance response"
  exit 1
fi

PARSE_ERROR=$(python3 -c "import json; d=json.load(open('$TMP_DIR/parsed.json')); print(d.get('error',''))" | tr -d '\r')
if [ -n "$PARSE_ERROR" ]; then
  log "ERROR: $PARSE_ERROR"
  exit 1
fi

log "Parsed: $(cat "$TMP_DIR/parsed.json")"

# ---- 3. Fetch Benzinga headlines (curl only - see header note) ----
log "Fetching news catalyst from Benzinga ($BENZINGA_SYMBOL)..."

BZ_HTML="$TMP_DIR/benzinga.html"
curl -s -m 15 -A "$UA" "https://www.benzinga.com/quote/${BENZINGA_SYMBOL}" -o "$BZ_HTML" 2>/dev/null || true

# Extract up to 2 real headlines+teasers (anchored on the actual content div,
# not the Tailwind arbitrary-variant class string that also contains the
# literal substrings "title-text"/"teaser-text").
python3 - "$BZ_HTML" > "$TMP_DIR/scraped.json" <<'PYEOF2'
import re, sys, json, html as htmllib

path = sys.argv[1]
try:
    with open(path, encoding="utf-8", errors="ignore") as f:
        content = f.read()
except FileNotFoundError:
    content = ""

items = []
for idx in [m.start() for m in re.finditer(r'<div class="quote-news-item', content)][:2]:
    block = content[idx:idx + 2500]
    title = re.search(r'<h3[^>]*class="title-text[^"]*"[^>]*>(?:<span[^>]*>)?([^<]+)', block)
    teaser = re.search(r'<div[^>]*class="teaser-text[^"]*"[^>]*>(?:<span[^>]*>)?([^<]*)', block)
    if title:
        items.append({
            "title": htmllib.unescape(title.group(1)).strip(),
            "teaser": htmllib.unescape(teaser.group(1)).strip() if teaser else "",
        })

print(json.dumps(items))
PYEOF2

SCRAPED_COUNT=$(python3 -c "import json; print(len(json.load(open('$TMP_DIR/scraped.json'))))" 2>/dev/null | tr -d '\r')
SCRAPED_COUNT=${SCRAPED_COUNT:-0}
log "Scraped $SCRAPED_COUNT headline(s) from Benzinga."

CATALYST="null"
HEADLINES="[]"

if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  log "WARNING: ANTHROPIC_API_KEY not set - catalyst/headlines will be null."
fi

# ---- 4. Summarize into a catalyst via the Anthropic API (exact prompt) ----
if [ -n "${ANTHROPIC_API_KEY:-}" ] && [ "$SCRAPED_COUNT" -gt 0 ]; then
  python3 - "$TMP_DIR/scraped.json" "$ANTHROPIC_MODEL" > "$TMP_DIR/req.json" <<'PYEOF3'
import json, sys

scraped_path, model = sys.argv[1:3]
items = json.load(open(scraped_path, encoding="utf-8"))
context = "\n".join(f"- {it['title']}: {it['teaser']}" for it in items)
prompt = (
    "What recent news or catalyst is driving Bitcoin price action right now? "
    "Return a one-sentence summary, then up to 2 recent headlines verbatim. "
    "Just the data - no commentary.\n\n"
    f"Recent Benzinga headlines:\n{context}\n\n"
    "Respond in exactly this format:\n"
    "SUMMARY: <one sentence>\n"
    "HEADLINE: <verbatim headline 1>\n"
    "HEADLINE: <verbatim headline 2 (omit this line if only one is relevant)>"
)
body = {
    "model": model,
    "max_tokens": 300,
    "messages": [{"role": "user", "content": prompt}],
}
print(json.dumps(body))
PYEOF3

  curl -s -m 20 "https://api.anthropic.com/v1/messages" \
    -H "x-api-key: ${ANTHROPIC_API_KEY}" \
    -H "anthropic-version: 2023-06-01" \
    -H "content-type: application/json" \
    -d @"$TMP_DIR/req.json" \
    -o "$TMP_DIR/llm_response.json" 2>/dev/null || true

  if [ -s "$TMP_DIR/llm_response.json" ]; then
    PARSED=$(python3 - "$TMP_DIR/llm_response.json" <<'PYEOF4'
import json, sys, re

path = sys.argv[1]
try:
    data = json.load(open(path, encoding="utf-8"))
    text = data["content"][0]["text"]
except Exception:
    print(json.dumps({"catalyst": None, "headlines": []}))
    sys.exit(0)

summary_m = re.search(r"SUMMARY:\s*(.+)", text)
headlines = re.findall(r"HEADLINE:\s*(.+)", text)
catalyst = summary_m.group(1).strip() if summary_m else None
headlines = [h.strip() for h in headlines if h.strip()][:2]
print(json.dumps({"catalyst": catalyst, "headlines": headlines}))
PYEOF4
)
    CATALYST=$(python3 -c "import json,sys; d=json.loads(sys.argv[1]); print(json.dumps(d['catalyst']))" "$PARSED")
    HEADLINES=$(python3 -c "import json,sys; d=json.loads(sys.argv[1]); print(json.dumps(d['headlines']))" "$PARSED")
  fi
fi

# ---- 5. Assemble final JSON per the exact requested schema ----
python3 - "$TMP_DIR/parsed.json" "$SCANNED_AT" "$SYMBOL" "$CATALYST" "$HEADLINES" "$OUT_FILE" <<'PYEOF5'
import json, sys

parsed_path, scanned_at, symbol, catalyst_json, headlines_json, out_path = sys.argv[1:7]
parsed = json.load(open(parsed_path, encoding="utf-8"))

result = {
    "scanned_at": scanned_at,
    "symbol": symbol,
    "price": parsed["price"],
    "change_pct_24h": parsed["change_pct_24h"],
    "high_24h": parsed["high_24h"],
    "low_24h": parsed["low_24h"],
    "volume_24h_btc": parsed["volume_24h_btc"],
    "catalyst": json.loads(catalyst_json),
    "headlines": json.loads(headlines_json),
}
json.dump(result, open(out_path, "w", encoding="utf-8"), indent=2)
PYEOF5

log "Saved to $OUT_FILE"

# ---- 6. One-line summary ----
python3 -c "
import json
data = json.load(open('$OUT_FILE', encoding='utf-8'))
print(f\"BTCUSDT: \${data['price']:,.2f} ({data['change_pct_24h']:+.1f}% 24h) \u2014 {data['catalyst'] or 'no catalyst'}\")
"
