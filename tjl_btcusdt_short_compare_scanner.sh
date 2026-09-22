#!/usr/bin/env bash
# Parallel Short-side comparison scanner: baseline vs ATR-buffered (v2c,
# bufferMult=0.5, LOCKED IN per pine/tjl_btcusdt_v2c_atrbuffer.pine).
#
# Purpose: forward/paper-test validation. TradingView's plan limits block a
# longer historical backtest, so instead of tuning further on the same
# Jul1-Sep18 2026 sample, this runs BOTH Short entry formulas side by side on
# fresh data neither was tuned on, logging to separate output files so hit
# dates/times can be diffed directly going forward.
#
# Long side is deliberately NOT computed here - it's byte-identical between
# baseline and buffered (unaffected by this change) and is already scanned
# independently by tjl_btcusdt_scanner.sh on its own schedule. This script's
# only job is the Short-side A/B comparison.
#
# Same data-source rationale as tjl_btcusdt_scanner.sh: hits Binance's public
# REST API directly (verified earlier that TradingView's BINANCE:BTCUSDT feed
# IS Binance's own data) - no MCP, no TradingView Desktop needed to run.
set -uo pipefail

SYMBOL="BTCUSDT"
SYMBOL_LABEL="BINANCE:BTCUSDT"
BUFFER_MULT="0.5"
ATR_LEN="14"
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"

to_win_path() { command -v cygpath >/dev/null 2>&1 && cygpath -m "$1" || echo "$1"; }

SCRIPT_DIR="$(to_win_path "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)")"
TIMESTAMP=$(date -u +"%Y-%m-%d_%H%MUTC")
OUT_FILE_BASELINE="$SCRIPT_DIR/tjl_btcusdt_short_baseline_${TIMESTAMP}.json"
OUT_FILE_BUFFERED="$SCRIPT_DIR/tjl_btcusdt_short_buffered_${TIMESTAMP}.json"
STATE_FILE_BASELINE="$SCRIPT_DIR/.tjl_btcusdt_short_baseline_state.json"
STATE_FILE_BUFFERED="$SCRIPT_DIR/.tjl_btcusdt_short_buffered_state.json"
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

# ---- 1. Daily klines (last completed bar's low/close, SMA200) ----
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

# ---- 3. 15m klines (session low since 00:00 UTC today + ATR14 warmup) ----
log "Fetching 15m klines from Binance..."
if ! fetch_retry "https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=15m&limit=100" "$TMP_DIR/intraday.json"; then
  log "ERROR: failed to fetch 15m klines after 3 attempts"
  exit 1
fi

# ---- 4. Compute + evaluate both variants ----
python3 - "$TMP_DIR/daily.json" "$TMP_DIR/price.json" "$TMP_DIR/intraday.json" "$SCANNED_AT" "$SYMBOL_LABEL" \
  "$OUT_FILE_BASELINE" "$OUT_FILE_BUFFERED" "$STATE_FILE_BASELINE" "$STATE_FILE_BUFFERED" "$BUFFER_MULT" "$ATR_LEN" <<'PYEOF'
import json, sys, datetime, os

(daily_path, price_path, intraday_path, scanned_at, symbol_label,
 out_baseline_path, out_buffered_path, state_baseline_path, state_buffered_path,
 buffer_mult_str, atr_len_str) = sys.argv[1:12]

buffer_mult = float(buffer_mult_str)
atr_len = int(atr_len_str)

daily = json.load(open(daily_path, encoding="utf-8"))
price_data = json.load(open(price_path, encoding="utf-8"))
intraday = json.load(open(intraday_path, encoding="utf-8"))

# Binance kline array: [openTime, open, high, low, close, volume, closeTime, ...]
# Last daily bar is today's still-forming bar (Binance convention), so the
# "last completed daily bar" is the second-to-last entry - same as
# tjl_btcusdt_scanner.sh.
last_completed = daily[-2]
prev_daily_low = float(last_completed[3])
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
# Exclude the current (still-forming) bar, per spec - matches
# tjl_btcusdt_scanner.sh's session_high handling, mirrored here for the low.
completed_today = today_bars[:-1] if len(today_bars) > 1 else []
session_low = min((float(b[3]) for b in completed_today), default=None)

# ---- Wilder ATR(14) on completed 15m bars ----
# Approximation, not an exact replica of Pine's ta.atr(): this scanner is a
# live monitor evaluated once per 30-min tick, not a bar-by-bar backtest, so
# ATR is computed from the last N COMPLETED 15m bars (excluding the
# currently-forming one) rather than the live-updating current bar Pine sees
# mid-bar. Same non-repainting philosophy as session_low/prev_daily_* above.
completed_bars = intraday[:-1] if len(intraday) > 1 else []
trs = []
for i in range(1, len(completed_bars)):
    high_i = float(completed_bars[i][2])
    low_i = float(completed_bars[i][3])
    prev_close = float(completed_bars[i - 1][4])
    tr = max(high_i - low_i, abs(high_i - prev_close), abs(low_i - prev_close))
    trs.append(tr)

atr14 = None
if len(trs) >= atr_len:
    atr14 = sum(trs[:atr_len]) / atr_len
    for tr in trs[atr_len:]:
        atr14 = (atr14 * (atr_len - 1) + tr) / atr_len

daily_breakdown = curr_px < prev_daily_low and prev_daily_close < sma200
intraday_breakdown_baseline = session_low is not None and curr_px < session_low
intraday_breakdown_buffered = (
    session_low is not None and atr14 is not None
    and curr_px < session_low - buffer_mult * atr14
)


def classify(daily_ok, intraday_ok):
    if daily_ok and intraday_ok:
        return "PASS"
    elif not daily_ok:
        return "fail_daily"
    else:
        return "fail_intraday"


result_baseline = classify(daily_breakdown, intraday_breakdown_baseline)
result_buffered = classify(daily_breakdown, intraday_breakdown_buffered)


def write_state(state_path, result):
    prev_state = None
    if os.path.exists(state_path):
        try:
            with open(state_path, encoding="utf-8") as f:
                prev_state = json.load(f)
        except (json.JSONDecodeError, OSError):
            prev_state = None

    # should_notify tracked for later Telegram wiring (still pending, folded
    # in together for both scanners at once) - no push mechanism here yet.
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
    return should_notify, notify_reason


should_notify_baseline, notify_reason_baseline = write_state(state_baseline_path, result_baseline)
should_notify_buffered, notify_reason_buffered = write_state(state_buffered_path, result_buffered)

output_baseline = {
    "scanned_at": scanned_at,
    "symbol": symbol_label,
    "variant": "short_baseline",
    "buffer_mult": 0.0,
    "curr_price": curr_px,
    "prev_daily_low": prev_daily_low,
    "prev_daily_close": prev_daily_close,
    "sma200": sma200,
    "session_low": session_low,
    "atr14_15m": atr14,
    "daily_breakdown": daily_breakdown,
    "intraday_breakdown": intraday_breakdown_baseline,
    "result": result_baseline,
}
json.dump(output_baseline, open(out_baseline_path, "w", encoding="utf-8"), indent=2)

output_buffered = {
    "scanned_at": scanned_at,
    "symbol": symbol_label,
    "variant": "short_buffered",
    "buffer_mult": buffer_mult,
    "curr_price": curr_px,
    "prev_daily_low": prev_daily_low,
    "prev_daily_close": prev_daily_close,
    "sma200": sma200,
    "session_low": session_low,
    "atr14_15m": atr14,
    "daily_breakdown": daily_breakdown,
    "intraday_breakdown": intraday_breakdown_buffered,
    "result": result_buffered,
}
json.dump(output_buffered, open(out_buffered_path, "w", encoding="utf-8"), indent=2)

print(json.dumps({
    "result_baseline": result_baseline,
    "result_buffered": result_buffered,
    "should_notify_baseline": should_notify_baseline,
    "should_notify_buffered": should_notify_buffered,
    "notify_reason_baseline": notify_reason_baseline,
    "notify_reason_buffered": notify_reason_buffered,
    "curr_price": curr_px,
    "session_low": session_low,
    "atr14_15m": atr14,
}))
PYEOF

if [ ! -s "$OUT_FILE_BASELINE" ] || [ ! -s "$OUT_FILE_BUFFERED" ]; then
  log "ERROR: failed to compute/save one or both scan results"
  exit 1
fi

log "Saved baseline to $OUT_FILE_BASELINE"
log "Saved buffered to $OUT_FILE_BUFFERED"

# ---- 5. One-line summary ----
python3 -c "
import json
b = json.load(open('$OUT_FILE_BASELINE', encoding='utf-8'))
f = json.load(open('$OUT_FILE_BUFFERED', encoding='utf-8'))
sb = json.load(open('$STATE_FILE_BASELINE', encoding='utf-8'))
sf = json.load(open('$STATE_FILE_BUFFERED', encoding='utf-8'))
notify_b = f\" [NOTIFY baseline: {sb['notify_reason']}]\" if sb['should_notify'] else ''
notify_f = f\" [NOTIFY buffered: {sf['notify_reason']}]\" if sf['should_notify'] else ''
atr_str = f\"{b['atr14_15m']:,.2f}\" if b['atr14_15m'] is not None else 'n/a'
print(f\"BTCUSDT Short compare: baseline={b['result']} buffered={f['result']} — curr_px \${b['curr_price']:,.2f}, prev_daily_low \${b['prev_daily_low']:,.2f}, session_low \${b['session_low']:,.2f}, atr14 \${atr_str}{notify_b}{notify_f}\")
"
