#!/usr/bin/env bash
# Trend Join Long strategy scanner for BTCUSDT - fully deterministic version.
#
# Originally run via TradingView MCP tools (chart_set_symbol/timeframe,
# data_get_ohlcv, quote_get) against BINANCE:BTCUSDT. Verified directly that
# TradingView's BINANCE:BTCUSDT feed IS Binance's own market data - a same-
# moment comparison matched exactly (prev_daily_high 77179.47, session_high
# 77597.83 identical on both; sma200 differed by $0.09, curr_price by ~$30,
# both fully explained by the few seconds/minutes between the two fetches on
# a continuously-moving asset, not a data-source difference). So this script
# hits Binance's public REST API directly instead - no MCP, no TradingView
# Desktop, no CDP, no Claude session needed to run the scan itself.
set -uo pipefail

SYMBOL="BTCUSDT"
SYMBOL_LABEL="BINANCE:BTCUSDT"  # matches the schema's "symbol" field
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"

to_win_path() { command -v cygpath >/dev/null 2>&1 && cygpath -m "$1" || echo "$1"; }

SCRIPT_DIR="$(to_win_path "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)")"
TIMESTAMP=$(date -u +"%Y-%m-%d_%H%MUTC")
OUT_FILE="$SCRIPT_DIR/tjl_btcusdt_${TIMESTAMP}.json"
STATE_FILE="$SCRIPT_DIR/.tjl_btcusdt_state.json"
SCANNED_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

TMP_DIR="$(to_win_path "$(mktemp -d)")"
trap 'rm -rf "$TMP_DIR"' EXIT

log() { echo "$1" >&2; }

fetch_retry() {
  local url="$1" out="$2"
  for attempt in 1 2 3; do
    if curl -s -m 15 -A "$UA" "$url" -o "$out" && [ -s "$out" ]; then
      return 0
    fi
    log "  fetch attempt $attempt failed for $url, retrying..."
  done
  return 1
}

# ---- 1. Daily klines (last completed bar's high/close, SMA200) ----
log "Fetching daily klines from Binance..."
if ! fetch_retry "https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=1d&limit=210" "$TMP_DIR/daily.json"; then
  log "ERROR: failed to fetch daily klines after 3 attempts"
  exit 1
fi

# ---- 2. Current price ----
log "Fetching current price..."
if ! fetch_retry "https://api.binance.com/api/v3/ticker/price?symbol=${SYMBOL}" "$TMP_DIR/price.json"; then
  log "ERROR: failed to fetch current price after 3 attempts"
  exit 1
fi

# ---- 3. 15m klines (session high since 00:00 UTC today) ----
log "Fetching 15m klines from Binance..."
if ! fetch_retry "https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=15m&limit=100" "$TMP_DIR/intraday.json"; then
  log "ERROR: failed to fetch 15m klines after 3 attempts"
  exit 1
fi

# ---- 4. Compute + evaluate ----
python3 - "$TMP_DIR/daily.json" "$TMP_DIR/price.json" "$TMP_DIR/intraday.json" "$SCANNED_AT" "$SYMBOL_LABEL" "$OUT_FILE" "$STATE_FILE" <<'PYEOF'
import json, sys, datetime, os

daily_path, price_path, intraday_path, scanned_at, symbol_label, out_path, state_path = sys.argv[1:8]

daily = json.load(open(daily_path, encoding="utf-8"))
price_data = json.load(open(price_path, encoding="utf-8"))
intraday = json.load(open(intraday_path, encoding="utf-8"))

# Binance kline array: [openTime, open, high, low, close, volume, closeTime, ...]
# The last daily bar is today's still-forming bar (Binance's own convention -
# klines for the current open period are included and update live), so the
# "last completed daily bar" per spec is the second-to-last entry.
last_completed = daily[-2]
prev_daily_high = float(last_completed[2])
prev_daily_close = float(last_completed[4])

closes_200 = [float(bar[4]) for bar in daily[-200:]]
sma200 = sum(closes_200) / len(closes_200)

curr_px = float(price_data["price"])

today_start_ms = int(
    datetime.datetime.now(datetime.timezone.utc)
    .replace(hour=0, minute=0, second=0, microsecond=0)
    .timestamp() * 1000
)
today_bars = [b for b in intraday if b[0] >= today_start_ms]
# Exclude the current (still-forming) bar, per spec.
completed_today = today_bars[:-1] if len(today_bars) > 1 else []
session_high = max((float(b[2]) for b in completed_today), default=None)

daily_breakout = curr_px > prev_daily_high and prev_daily_close > sma200
intraday_breakout = session_high is not None and curr_px > session_high

if daily_breakout and intraday_breakout:
    result = "PASS"
elif not daily_breakout:
    result = "fail_daily"
else:
    result = "fail_intraday"

output = {
    "scanned_at": scanned_at,
    "symbol": symbol_label,
    "curr_price": curr_px,
    "prev_daily_high": prev_daily_high,
    "sma200": sma200,
    "session_high": session_high,
    "result": result,
}
json.dump(output, open(out_path, "w", encoding="utf-8"), indent=2)

# ---- Notify-decision state (delivery mechanism wired up separately later) ----
# should_notify=true exactly twice: the very first run after the scheduler
# starts (no prior state file), or when result becomes PASS having not been
# PASS on the immediately preceding run. Every other run just updates state.
prev_state = None
if os.path.exists(state_path):
    try:
        with open(state_path, encoding="utf-8") as f:
            prev_state = json.load(f)
    except (json.JSONDecodeError, OSError):
        prev_state = None

if prev_state is None:
    should_notify = True
    notify_reason = "first_run"
elif result == "PASS" and prev_state.get("last_result") != "PASS":
    should_notify = True
    notify_reason = "new_pass"
else:
    should_notify = False
    notify_reason = None

new_state = {
    "last_scan_at": scanned_at,
    "last_result": result,
    "should_notify": should_notify,
    "notify_reason": notify_reason,
}
json.dump(new_state, open(state_path, "w", encoding="utf-8"), indent=2)

reason_bits = []
reason_bits.append(f"px {'above' if curr_px > prev_daily_high else 'below'} prev daily high ({prev_daily_high:,.2f})")
reason_bits.append(f"prior close {'above' if prev_daily_close > sma200 else 'below'} SMA200 ({sma200:,.2f})")
if session_high is not None:
    reason_bits.append(f"px {'above' if curr_px > session_high else 'below'} session high ({session_high:,.2f})")
reason = "; ".join(reason_bits)

print(json.dumps({"result": result, "reason": reason, "curr_price": curr_px, "should_notify": should_notify, "notify_reason": notify_reason}))
PYEOF

if [ ! -s "$OUT_FILE" ]; then
  log "ERROR: failed to compute/save scan result"
  exit 1
fi

log "Saved to $OUT_FILE"

# ---- 5. One-line summary ----
python3 -c "
import json
data = json.load(open('$OUT_FILE', encoding='utf-8'))
state = json.load(open('$STATE_FILE', encoding='utf-8'))
notify_bit = f\" [NOTIFY: {state['notify_reason']}]\" if state['should_notify'] else ''
print(f\"BTCUSDT: {data['result']} — curr_px \${data['curr_price']:,.2f}, prev_daily_high \${data['prev_daily_high']:,.2f}, sma200 \${data['sma200']:,.2f}, session_high \${data['session_high']:,.2f}{notify_bit}\")
"
