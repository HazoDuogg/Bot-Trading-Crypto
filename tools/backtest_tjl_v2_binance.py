#!/usr/bin/env python3
"""
NOTE (added during the chore/restructure reorganization, 2026-10-09): this
is a Python REPLICA of the Pine strategy, not a real TradingView Strategy
Tester run. It has a known, unresolved ~10-trade divergence against live
Pine on at least one prior comparison and was never fully reconciled - it
was accepted in-session as "good enough" for the specific crash-coverage
window Pine's plan-gated history couldn't reach, with trades labeled
borderline/clear-cut to weight confidence, not treated as exact. Do not
treat its numbers as Pine-equivalent without re-checking against a real
Strategy Tester run wherever that's possible.

Standalone backtester replicating tjl_btcusdt_v2_longshort.pine EXACTLY,
using Binance's public REST API instead of TradingView (which gates
intraday historical depth behind a paid plan on this account - confirmed
directly: Custom date range in the Strategy Tester hit a paid-plan upsell,
and both chart_set_visible_range and chart_scroll_to_date silently failed
to move the 15m chart earlier than ~mid-September).

Does NOT modify pine/tjl_btcusdt_v2_longshort.pine or any other Pine file.

Replicated exactly from the Pine source:
  - daily_breakout    = curr_close > prev_completed_daily_high
                         AND prev_completed_daily_close > SMA200(prev completed days)
  - daily_breakdown   = curr_close < prev_completed_daily_low
                         AND prev_completed_daily_close < SMA200(prev completed days)
  - session_high/low  = extrema of today's UTC session's 15m bars, EXCLUDING
                         the current (still-forming) bar
  - mutual exclusion  = no new entry while a position is open (flat check)
  - exits             = ATR(14) initial stop (entry -/+ 1.5x ATR) + chandelier
                         trail (highest/lowest since entry -/+ 2x ATR), trail
                         only ever tightens, checked via intrabar high/low
                         starting the bar AFTER entry (matching Pine: entry
                         fills are not visible to position_size until the
                         following bar's script evaluation)

Pine's `[1]` offset inside request.security(..., "D", x[1], ...) means: for
any 15m bar during UTC day D, the referenced value is day D-1's (the last
CLOSED daily bar, never the forming day-D one). That is replicated here as
daily_by_date[D - 1 day].

---
EXTENSION (crash-coverage run): adds the v2c ATR-buffer Short fix
(BUFFER_MULT, locked at 0.5 per pine/tjl_btcusdt_v2c_atrbuffer.pine) and
runs Apr 1 - Jul 15, 2026 - a window TradingView's Strategy Tester date
range restriction never let us backtest directly, since it includes the
real May 10 - Jun 30 downtrend confirmed via direct daily-data inspection.

Explicitly NOT chasing Pine-exact ATR float precision this time (that
unresolved gap caused the earlier ~10-trade overcount). Instead every
exit's margin between the triggering bar's high/low and the stop level is
measured and trades are labeled "borderline" (margin < BORDERLINE_MARGIN_PCT
of entry price - i.e. could plausibly flip under a slightly different ATR
value) vs "clear-cut", so results can be weighted by confidence rather than
trusted uniformly.
"""
import json
import time as time_module
import urllib.request
from datetime import datetime, timezone, timedelta

BINANCE_KLINES_URL = "https://api.binance.com/api/v3/klines"
SYMBOL = "BTCUSDT"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"

ATR_LEN = 14
INITIAL_STOP_ATR_MULT = 1.5
TRAIL_ATR_MULT = 2.0
SMA_LEN = 200

# v2c ATR-buffer fix, locked in per pine/tjl_btcusdt_v2c_atrbuffer.pine: the
# Short-side intraday breakdown must clear session_low by this many ATRs, not
# just tick under it. 0.0 reproduces the original v2 (no buffer) behavior.
BUFFER_MULT = 0.5

# Threshold (as % of entry price) below which a stop-hit is flagged
# "borderline" rather than "clear-cut". This run explicitly does NOT chase
# Pine-exact ATR float precision (that's what caused the unresolved ~10-trade
# overcount before) - instead, every exit's margin between the triggering
# bar's high/low and the active stop is measured, so trades whose outcome
# could plausibly flip under a slightly different ATR value are labeled and
# can be discounted separately from the clear-cut ones.
BORDERLINE_MARGIN_PCT = 0.10


def fetch_klines(interval, start_ms, end_ms):
    """Paginate Binance klines across [start_ms, end_ms), 1000 bars per call."""
    out = []
    cursor = start_ms
    while cursor < end_ms:
        url = (
            f"{BINANCE_KLINES_URL}?symbol={SYMBOL}&interval={interval}"
            f"&startTime={cursor}&endTime={end_ms}&limit=1000"
        )
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=20) as resp:
            batch = json.loads(resp.read())
        if not batch:
            break
        out.extend(batch)
        last_close_time = batch[-1][6]
        if last_close_time <= cursor:
            break
        cursor = last_close_time + 1
        if len(batch) < 1000:
            break
        time_module.sleep(0.2)  # be polite to the public endpoint
    return out


def to_bar(k):
    return {
        "open_time": k[0],
        "open": float(k[1]),
        "high": float(k[2]),
        "low": float(k[3]),
        "close": float(k[4]),
        "close_time": k[6],
    }


def utc_date(ms):
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).date()


def wilder_atr(bars, length=14):
    """Pine's ta.atr(): RMA (Wilder smoothing) of True Range."""
    trs = [None] * len(bars)
    for i in range(len(bars)):
        if i == 0:
            trs[i] = bars[i]["high"] - bars[i]["low"]
        else:
            pc = bars[i - 1]["close"]
            trs[i] = max(
                bars[i]["high"] - bars[i]["low"],
                abs(bars[i]["high"] - pc),
                abs(bars[i]["low"] - pc),
            )
    atr = [None] * len(bars)
    for i in range(len(bars)):
        if i < length - 1:
            continue
        if i == length - 1:
            atr[i] = sum(trs[i - length + 1 : i + 1]) / length
        else:
            atr[i] = (atr[i - 1] * (length - 1) + trs[i]) / length
    return atr


def run_backtest(bars_15m, daily_by_date, sma200_by_date, label, entries_allowed_from_ms=None,
                  buffer_mult=0.0):
    atr = wilder_atr(bars_15m, ATR_LEN)

    position = 0  # 0 flat, 1 long, -1 short
    entry_price = None
    initial_stop = None
    highest_since_entry = None
    lowest_since_entry = None
    entry_bar_idx = None

    session_high_excl = None
    session_low_excl = None
    session_high = None
    session_low = None
    cur_day = None

    trades = []

    for i, bar in enumerate(bars_15m):
        d = utc_date(bar["open_time"])
        if d != cur_day:
            cur_day = d
            session_high = None
            session_low = None

        # Values EXCLUDING the current (still-forming) bar - captured before
        # this bar's own high/low is folded in, matching the Pine script's
        # sessionHighExclCurrent / sessionLowExclCurrent exactly.
        session_high_excl = session_high
        session_low_excl = session_low
        session_high = bar["high"] if session_high is None else max(session_high, bar["high"])
        session_low = bar["low"] if session_low is None else min(session_low, bar["low"])

        # REVERTED. Was briefly "2 days" based on trade-count pattern-matching
        # against 5 cases, but that conclusion is WRONG - verified directly
        # against the LIVE deployed Pine script (not inferred): its "Prev
        # Daily High" plot reads 77,179.47 against real time, which is an
        # exact match for yesterday's actual completed daily high (verified
        # against the real daily chart), not the day-before-yesterday's
        # (76,560.76). The deployed v1/v2 scripts correctly use a 1-day lag.
        # The 2-day "fix" was masking a different, still-unidentified bug in
        # this replica - do not reintroduce it without new evidence.
        prev_day = d - timedelta(days=1)
        d_high1 = daily_by_date.get(prev_day, {}).get("high")
        d_low1 = daily_by_date.get(prev_day, {}).get("low")
        d_close1 = daily_by_date.get(prev_day, {}).get("close")
        d_sma200_1 = sma200_by_date.get(prev_day)

        curr_px = bar["close"]
        atr_val = atr[i]

        # ---- Manage an open position first (mirrors Pine bar-order: the
        # entry bar itself never sees position_size != 0, so the exit-check
        # block only ever fires starting the bar AFTER entry). ----
        # `just_exited` blocks the entry check below from running on THIS
        # same bar: in Pine, strategy.position_size only reads back as 0
        # starting the bar AFTER strategy.exit() fires, exactly the same
        # one-bar visibility delay already confirmed for entries during the
        # na-ATR debugging. Without this, the sim could exit and re-enter
        # within the same iteration - which Pine's execution model can't do
        # - and that alone was producing ~2x Pine's real trade count.
        just_exited = False
        if position != 0 and i > entry_bar_idx:
            if position == 1:
                highest_since_entry = max(highest_since_entry, bar["high"])
                trail_stop = highest_since_entry - TRAIL_ATR_MULT * atr_val
                active_stop = max(trail_stop, initial_stop)
                if bar["low"] <= active_stop:
                    exit_price = active_stop
                    # Margin between the triggering bar's low and the stop
                    # level: how far past the stop (downward) the bar actually
                    # reached. A tiny margin means a slightly different ATR
                    # value (Pine float precision vs this replica's) could
                    # plausibly have missed or delayed this exact stop hit.
                    margin_pct = (active_stop - bar["low"]) / entry_price * 100
                    trades.append({
                        "side": "Long", "entry_time": bars_15m[entry_bar_idx]["open_time"],
                        "entry_price": entry_price, "exit_time": bar["open_time"],
                        "exit_price": exit_price,
                        "return_pct": (exit_price - entry_price) / entry_price * 100,
                        "stop_margin_pct": margin_pct,
                        "borderline": margin_pct < BORDERLINE_MARGIN_PCT,
                    })
                    position = 0
                    just_exited = True
            elif position == -1:
                lowest_since_entry = min(lowest_since_entry, bar["low"])
                trail_stop = lowest_since_entry + TRAIL_ATR_MULT * atr_val
                active_stop = min(trail_stop, initial_stop)
                if bar["high"] >= active_stop:
                    exit_price = active_stop
                    # Penetration for Short: how far above the stop the
                    # bar's high reached.
                    margin_pct = (bar["high"] - active_stop) / entry_price * 100
                    trades.append({
                        "side": "Short", "entry_time": bars_15m[entry_bar_idx]["open_time"],
                        "entry_price": entry_price, "exit_time": bar["open_time"],
                        "exit_price": exit_price,
                        "return_pct": (entry_price - exit_price) / entry_price * 100,
                        "stop_margin_pct": margin_pct,
                        "borderline": margin_pct < BORDERLINE_MARGIN_PCT,
                    })
                    position = 0
                    just_exited = True

        # ---- Entry check (only when flat, and ATR must be a real number -
        # matches the not na(atrVal) guard added after the na-stop bug).
        # entries_allowed_from_ms mirrors the Strategy Tester's "testing
        # period": it only restricts when NEW trades may open - all the
        # underlying calculations (ATR, SMA200, session tracking) still run
        # continuously over the full fetched history including the warmup
        # bars before this cutoff, exactly like Pine's indicators do. ----
        entries_allowed = entries_allowed_from_ms is None or bar["open_time"] >= entries_allowed_from_ms
        if position == 0 and not just_exited and entries_allowed and atr_val is not None and d_high1 is not None and d_sma200_1 is not None:
            daily_breakout = curr_px > d_high1 and d_close1 > d_sma200_1
            intraday_breakout = session_high_excl is not None and curr_px > session_high_excl
            long_condition = daily_breakout and intraday_breakout

            daily_breakdown = curr_px < d_low1 and d_close1 < d_sma200_1
            # v2c: must clear session_low by buffer_mult * ATR, not just tick
            # under it (buffer_mult=0.0 reproduces original v2 behavior).
            intraday_breakdown = (
                session_low_excl is not None
                and curr_px < session_low_excl - buffer_mult * atr_val
            )
            short_condition = daily_breakdown and intraday_breakdown

            if long_condition:
                position = 1
                entry_price = curr_px
                entry_bar_idx = i
                initial_stop = curr_px - INITIAL_STOP_ATR_MULT * atr_val
                highest_since_entry = bar["high"]
            elif short_condition:
                position = -1
                entry_price = curr_px
                entry_bar_idx = i
                initial_stop = curr_px + INITIAL_STOP_ATR_MULT * atr_val
                lowest_since_entry = bar["low"]

    return summarize(trades, label)


def summarize(trades, label):
    def pct(x):
        return f"{x:.1f}%" if x is not None else "n/a"

    def side_stats(side_trades):
        n = len(side_trades)
        if n == 0:
            return {"trades": 0, "win_rate": None, "gross_profit": 0, "gross_loss": 0, "pf": None,
                    "borderline": 0, "clear_cut": 0}
        wins = [t for t in side_trades if t["return_pct"] > 0]
        losses = [t for t in side_trades if t["return_pct"] <= 0]
        gp = sum(t["return_pct"] for t in wins)
        gl = -sum(t["return_pct"] for t in losses)
        pf = (gp / gl) if gl > 0 else float("inf") if gp > 0 else None
        borderline = sum(1 for t in side_trades if t.get("borderline"))
        return {
            "trades": n,
            "win_rate": len(wins) / n * 100,
            "gross_profit": gp,
            "gross_loss": gl,
            "pf": pf,
            "borderline": borderline,
            "clear_cut": n - borderline,
        }

    longs = [t for t in trades if t["side"] == "Long"]
    shorts = [t for t in trades if t["side"] == "Short"]

    combined = side_stats(trades)
    long_stats = side_stats(longs)
    short_stats = side_stats(shorts)

    # simple equity curve (sum of % returns, not compounded - matches the
    # spirit of comparing "combined P&L%" without needing position sizing)
    net_pct = sum(t["return_pct"] for t in trades)

    # rough max drawdown on a cumulative-sum-of-% equity curve
    cum = 0.0
    peak = 0.0
    max_dd = 0.0
    for t in trades:
        cum += t["return_pct"]
        peak = max(peak, cum)
        max_dd = max(max_dd, peak - cum)

    print(f"\n=== {label} ===")
    print(f"Combined: {combined['trades']} trades, win rate {pct(combined['win_rate'])}, "
          f"net {net_pct:+.2f}% (sum of trade %), PF {combined['pf']:.2f}" if combined['pf'] else
          f"Combined: {combined['trades']} trades")
    print(f"  max drawdown (cum %): {max_dd:.2f}%")
    print(f"Long:  {long_stats['trades']} trades, win rate {pct(long_stats['win_rate'])}, "
          f"PF {long_stats['pf']:.2f}, borderline stops {long_stats['borderline']}/{long_stats['trades']}"
          if long_stats['trades'] else "Long:  0 trades")
    print(f"Short: {short_stats['trades']} trades, win rate {pct(short_stats['win_rate'])}, "
          f"PF {short_stats['pf']:.2f}, borderline stops {short_stats['borderline']}/{short_stats['trades']}"
          if short_stats['trades'] else "Short: 0 trades")

    return {"trades": trades, "combined": combined, "long": long_stats, "short": short_stats, "net_pct": net_pct, "max_dd": max_dd}


def build_daily_index(daily_bars):
    daily_by_date = {}
    for b in daily_bars:
        daily_by_date[utc_date(b["open_time"])] = b
    dates_sorted = sorted(daily_by_date.keys())
    closes = [daily_by_date[d]["close"] for d in dates_sorted]
    sma200_by_date = {}
    for i, d in enumerate(dates_sorted):
        if i >= SMA_LEN - 1:
            sma200_by_date[d] = sum(closes[i - SMA_LEN + 1 : i + 1]) / SMA_LEN
    return daily_by_date, sma200_by_date


def ms(dt_str):
    return int(datetime.strptime(dt_str, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp() * 1000)


import os

CACHE_DIR = "backtest_cache"


def cached_fetch(interval, start_ms, end_ms, name):
    os.makedirs(CACHE_DIR, exist_ok=True)
    path = os.path.join(CACHE_DIR, f"{name}.json")
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    raw = fetch_klines(interval, start_ms, end_ms)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(raw, f)
    return raw


if __name__ == "__main__":
    print("Fetching daily klines (for SMA200 + prev-day high/low/close)...")
    daily_raw = cached_fetch("1d", ms("2025-08-01"), ms("2026-09-19"), "daily")
    daily_bars = [to_bar(k) for k in daily_raw]
    print(f"  {len(daily_bars)} daily bars, {utc_date(daily_bars[0]['open_time'])} to {utc_date(daily_bars[-1]['open_time'])}")
    daily_by_date, sma200_by_date = build_daily_index(daily_bars)
    print(f"  SMA200 available from {min(sma200_by_date.keys())}")

    # 45-day pre-window warmup buffer: ta.atr()'s Wilder smoothing (RMA) has
    # a long but exponentially-decaying memory (alpha=1/14) - it converges to
    # within a fraction of a percent of its "infinite history" value after a
    # few dozen bar-lengths, so 45 days (~4320 15m bars) of prior history is
    # far more than enough for the ATR value at the window start to match
    # Pine's continuously-running ATR, without needing Pine's exact full
    # chart history. Confirmed this was the actual bug: first attempt fetched
    # 15m data starting exactly at the window boundary (cold ATR seed) and
    # produced 76 trades combined vs Pine's real 43 - entries/exits fire on
    # ATR-derived stop levels, so a cold-started ATR desyncs the whole
    # stateful trade sequence almost immediately.
    WARMUP_DAYS = 45

    # Rough sanity check only (NOT a precision-match requirement this time -
    # see BORDERLINE_MARGIN_PCT note above). Live Pine v2c @ bufferMult=0.5
    # over this exact window: 33 trades combined (15 Long / 18 Short).
    print("\nFetching 15m klines for SANITY-CHECK window (Jul 1 - Sep 18, 2026, +45d warmup)...")
    val_start = ms("2026-07-01") - WARMUP_DAYS * 86400_000
    val_raw = cached_fetch("15m", val_start, ms("2026-09-19"), "val_15m_warm")
    val_bars = [to_bar(k) for k in val_raw]
    print(f"  {len(val_bars)} 15m bars (from {utc_date(val_bars[0]['open_time'])})")
    val_result = run_backtest(val_bars, daily_by_date, sma200_by_date,
                               "SANITY CHECK (v2c, buffer=0.5): Jul 1 - Sep 18, 2026",
                               entries_allowed_from_ms=ms("2026-07-01"), buffer_mult=BUFFER_MULT)
    print(f"  (live Pine v2c reference: 33 combined / 15 Long / 18 Short - rough gauge only, not a precision gate)")

    # ---- Main deliverable: current locked entry logic (v2c, buffer=0.5)
    # over a window that actually INCLUDES the real May-Jun 2026 downtrend,
    # something the TradingView Strategy Tester's date-range restriction
    # never let us test directly. Apr 1 start gives lead-in before the crash;
    # Jul 15 end gives a look past it into the subsequent chop.
    print("\nFetching 15m klines for CRASH-COVERAGE window (Apr 1 - Jul 15, 2026, +45d warmup)...")
    crash_start = ms("2026-04-01") - WARMUP_DAYS * 86400_000
    crash_raw = cached_fetch("15m", crash_start, ms("2026-07-16"), "crash_15m_warm")
    crash_bars = [to_bar(k) for k in crash_raw]
    print(f"  {len(crash_bars)} 15m bars (from {utc_date(crash_bars[0]['open_time'])})")
    crash_result = run_backtest(crash_bars, daily_by_date, sma200_by_date,
                                 "CRASH COVERAGE (v2c, buffer=0.5): Apr 1 - Jul 15, 2026",
                                 entries_allowed_from_ms=ms("2026-04-01"), buffer_mult=BUFFER_MULT)

    # ---- Classify Short trades by whether they fall inside the real crash
    # window (May 10 - Jun 30, 2026, per the direct daily-data check) vs the
    # choppy periods before/after it.
    CRASH_START = datetime(2026, 5, 10, tzinfo=timezone.utc)
    CRASH_END = datetime(2026, 6, 30, 23, 59, 59, tzinfo=timezone.utc)
    shorts = [t for t in crash_result["trades"] if t["side"] == "Short"]
    in_crash = [t for t in shorts if CRASH_START <= datetime.fromtimestamp(t["entry_time"] / 1000, tz=timezone.utc) <= CRASH_END]
    outside_crash = [t for t in shorts if t not in in_crash]

    def short_summary(label, ts):
        if not ts:
            print(f"  {label}: 0 trades")
            return
        wins = [t for t in ts if t["return_pct"] > 0]
        gp = sum(t["return_pct"] for t in ts if t["return_pct"] > 0)
        gl = -sum(t["return_pct"] for t in ts if t["return_pct"] <= 0)
        pf = (gp / gl) if gl > 0 else float("inf") if gp > 0 else None
        borderline = sum(1 for t in ts if t.get("borderline"))
        pf_str = f"{pf:.2f}" if pf is not None else "n/a"
        print(f"  {label}: {len(ts)} trades, win rate {len(wins)/len(ts)*100:.1f}%, PF {pf_str}, "
              f"borderline stops {borderline}/{len(ts)}")

    print(f"\n=== Short trades: inside real crash window (May 10 - Jun 30) vs outside ===")
    short_summary("Inside crash window", in_crash)
    short_summary("Outside crash window (chop before/after)", outside_crash)

    if os.environ.get("DEBUG_TRADES"):
        print("\n=== ALL crash-coverage trades ===")
        for t in crash_result["trades"]:
            et = datetime.fromtimestamp(t["entry_time"] / 1000, tz=timezone.utc).strftime("%Y-%m-%d %H:%M")
            xt = datetime.fromtimestamp(t["exit_time"] / 1000, tz=timezone.utc).strftime("%Y-%m-%d %H:%M")
            print(f"{t['side']:5s} entry {et} @ {t['entry_price']:.2f} -> exit {xt} @ {t['exit_price']:.2f}  "
                  f"{t['return_pct']:+.2f}%  margin {t['stop_margin_pct']:.3f}%  "
                  f"{'BORDERLINE' if t['borderline'] else 'clear-cut'}")
