#!/usr/bin/env python3
"""
Consolidated forward/paper-test scanner - replaces the three separate
per-symbol scanners (tjl_btcusdt_three_variant_scanner.py,
tjl_ethusdt_scanner.py [never existed as its own file], tjl_solusdt_scanner.py)
with a single script covering all three symbols in one run, so Task
Scheduler only needs one task/one 30-min tick instead of one per symbol.

State and trade-log files are UNCHANGED in name/format from the previous
per-symbol scripts - only the execution/scheduling consolidated, not the
data. This lets consolidation happen without resetting any symbol's
forward-test history.

  BTCUSDT (prefix "", i.e. bare ".tjl_<variant>_forward_state.json" -
  matches the original tjl_btcusdt_three_variant_scanner.py exactly):
    v2  - baseline entry (buffer=0.0), chandelier trailing exit (ATR
          initial stop 1.5x, trail 2x), Daily SMA200 gate, both sides.
    v2c - buffer=0.5 entry (LOCKED IN), same chandelier trailing exit,
          SMA200 gate, both sides.
    v2e - buffer=0.5 entry, FIXED take-profit exit at R:R=2.25 (LOCKED
          IN), no trailing, SMA200 gate, both sides.
    v2f - same entry+exit as v2e, but the SMA200 gate is REPLACED by a
          Daily pivot-structure + SMA50-slope STATE gate (confirmed HH/HL
          + rising SMA50 for Long, confirmed LH/LL + falling SMA50 for
          Short). Both sides. This is the variant adopted live (both
          sides) per the portfolio decision.
    All four kept running for ongoing comparison, as originally built -
    portfolio adoption of v2f doesn't retire v2/v2c/v2e's tracking.

  ETHUSDT (prefix "ethusdt_"):
    v2f - buffer=0.5 entry, fixed TP R:R=2.25, same trend-structure gate
          as BTC's v2f (computed from ETH's own Daily bars). Long-only
          per the portfolio decision (ETH Long only).

  SOLUSDT (prefix "solusdt_"):
    v2e - buffer=0.5 entry, fixed TP R:R=2.25, UNGATED (no Daily trend
          filter - per the Jul1-Sep20 2026 finding that SOL Long-only
          v2e ungated outperformed every gated variant tried for this
          symbol). Long-only per the portfolio decision (SOL Long only).

Reuses the exact simulation loop, entry/exit formulas, and ATR/session-
high bookkeeping validated in the two predecessor scripts. Does NOT
modify any .pine file. No Telegram/push wiring yet - should_notify is
tracked per variant same as before, for later use.
"""
import json
import os
import time as time_module
import urllib.request
from datetime import datetime, timezone, timedelta

BINANCE_KLINES_URL = "https://api.binance.com/api/v3/klines"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"

ATR_LEN = 14
INITIAL_STOP_ATR_MULT = 1.5
TRAIL_ATR_MULT = 2.0
SMA_LEN = 200
GATE_PIVOT_LEN = 3
GATE_SMA_LEN = 50
GATE_SLOPE_LOOKBACK = 10

from paths_config import DATA_DIR  # noqa: E402 - see paths_config.py: data stays at repo root,
                                     # decoupled from this script's own location (moved here
                                     # during chore/restructure, 2026-10-09)

SYMBOLS = {
    "BTCUSDT": {
        "label": "BINANCE:BTCUSDT",
        "state_prefix": "",
        "variants": {
            "v2": {"buffer_mult": 0.0, "exit_style": "trail", "gate": "sma200"},
            "v2c": {"buffer_mult": 0.5, "exit_style": "trail", "gate": "sma200"},
            "v2e": {"buffer_mult": 0.5, "exit_style": "fixed_tp", "rr_mult": 2.25, "gate": "sma200"},
            "v2f": {"buffer_mult": 0.5, "exit_style": "fixed_tp", "rr_mult": 2.25, "gate": "trend_structure"},
        },
    },
    "ETHUSDT": {
        "label": "BINANCE:ETHUSDT",
        "state_prefix": "ethusdt_",
        "variants": {
            "v2f": {"buffer_mult": 0.5, "exit_style": "fixed_tp", "rr_mult": 2.25, "gate": "trend_structure",
                    "long_only": True},
        },
    },
    "SOLUSDT": {
        "label": "BINANCE:SOLUSDT",
        "state_prefix": "solusdt_",
        "variants": {
            "v2e": {"buffer_mult": 0.5, "exit_style": "fixed_tp", "rr_mult": 2.25, "gate": "none",
                    "long_only": True},
        },
    },
}


def fetch_json(url, timeout=20):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read())


def fetch_retry(url, attempts=3, timeout=20):
    last_err = None
    for _ in range(attempts):
        try:
            return fetch_json(url, timeout=timeout)
        except Exception as e:  # noqa: BLE001 - genuinely want to retry on anything transient
            last_err = e
            time_module.sleep(1)
    raise RuntimeError(f"failed to fetch {url} after {attempts} attempts: {last_err}")


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


def build_trend_gate_index(daily_bars, pivot_len=GATE_PIVOT_LEN, sma_len=GATE_SMA_LEN,
                            slope_lookback=GATE_SLOPE_LOOKBACK):
    """Daily pivot HH/HL (or LH/LL) + SMA(sma_len) slope gate. Pivot at bar i
    is only confirmed pivot_len bars later, matching Pine's ta.pivothigh/
    ta.pivotlow confirmation lag. Returns date -> {allow_long, allow_short},
    keyed by the SAME calendar date whose gate state a [1]-offset access
    would read (i.e. callers should look this up by prev_day, exactly like
    sma200_by_date).
    """
    daily_by_date = {}
    for b in daily_bars:
        daily_by_date[utc_date(b["open_time"])] = b
    dates_sorted = sorted(daily_by_date.keys())
    n = len(dates_sorted)
    highs = [daily_by_date[d]["high"] for d in dates_sorted]
    lows = [daily_by_date[d]["low"] for d in dates_sorted]
    closes = [daily_by_date[d]["close"] for d in dates_sorted]

    pivot_high_at, pivot_low_at = {}, {}
    for i in range(pivot_len, n - pivot_len):
        window_h = highs[i - pivot_len:i] + highs[i + 1:i + pivot_len + 1]
        if all(highs[i] > h for h in window_h):
            pivot_high_at[i + pivot_len] = highs[i]
        window_l = lows[i - pivot_len:i] + lows[i + 1:i + pivot_len + 1]
        if all(lows[i] < l for l in window_l):
            pivot_low_at[i + pivot_len] = lows[i]

    def sma(i, length):
        if i - length + 1 < 0:
            return None
        return sum(closes[i - length + 1:i + 1]) / length

    last_ph = prev_ph = last_pl = prev_pl = None
    gate_by_date = {}
    for i, d in enumerate(dates_sorted):
        if i in pivot_high_at:
            prev_ph = last_ph
            last_ph = pivot_high_at[i]
        if i in pivot_low_at:
            prev_pl = last_pl
            last_pl = pivot_low_at[i]
        structure_up = (last_ph is not None and prev_ph is not None and last_pl is not None
                        and prev_pl is not None and last_ph > prev_ph and last_pl > prev_pl)
        structure_down = (last_ph is not None and prev_ph is not None and last_pl is not None
                           and prev_pl is not None and last_ph < prev_ph and last_pl < prev_pl)
        sma_val = sma(i, sma_len)
        sma_prev = sma(i - slope_lookback, sma_len) if i - slope_lookback >= 0 else None
        slope_rising = sma_val is not None and sma_prev is not None and sma_val > sma_prev
        slope_falling = sma_val is not None and sma_prev is not None and sma_val < sma_prev
        gate_by_date[d] = {
            "allow_long": structure_up and slope_rising,
            "allow_short": structure_down and slope_falling,
        }
    return gate_by_date


def state_path(prefix, variant):
    return os.path.join(DATA_DIR, f".tjl_{prefix}{variant}_forward_state.json")


def trades_path(prefix, variant):
    return os.path.join(DATA_DIR, f"tjl_{prefix}{variant}_forward_trades.jsonl")


def load_state(prefix, variant):
    path = state_path(prefix, variant)
    if os.path.exists(path):
        try:
            with open(path, encoding="utf-8") as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError):
            pass
    return {
        "position": 0,  # 0 flat, 1 long, -1 short
        "entry_price": None,
        "entry_time": None,
        "initial_stop": None,
        "tp_price": None,
        "highest_since_entry": None,
        "lowest_since_entry": None,
        "last_processed_bar_time": None,
        "last_scan_at": None,
        "last_result": None,
        "should_notify": True,
        "notify_reason": "first_run",
    }


def save_state(prefix, variant, state):
    with open(state_path(prefix, variant), "w", encoding="utf-8") as f:
        json.dump(state, f, indent=2)


def append_trade(prefix, variant, trade):
    with open(trades_path(prefix, variant), "a", encoding="utf-8") as f:
        f.write(json.dumps(trade) + "\n")


def process_variant(prefix, variant_name, cfg, bars_15m, atr, daily_by_date, sma200_by_date, gate_by_date,
                     scanned_at):
    state = load_state(prefix, variant_name)
    buffer_mult = cfg["buffer_mult"]
    exit_style = cfg["exit_style"]
    rr_mult = cfg.get("rr_mult")
    gate_type = cfg.get("gate", "sma200")
    long_only = cfg.get("long_only", False)

    last_processed = state.get("last_processed_bar_time")
    new_bars_start_idx = 0
    if last_processed is not None:
        for i, bar in enumerate(bars_15m):
            if bar["open_time"] > last_processed:
                new_bars_start_idx = i
                break
        else:
            new_bars_start_idx = len(bars_15m)  # nothing new

    position = state["position"]
    entry_price = state["entry_price"]
    initial_stop = state["initial_stop"]
    tp_price = state["tp_price"]
    highest_since_entry = state["highest_since_entry"]
    lowest_since_entry = state["lowest_since_entry"]
    entry_time = state["entry_time"]

    session_high = None
    session_low = None
    cur_day = None
    closed_trades = []
    last_result = state.get("last_result")

    for i, bar in enumerate(bars_15m):
        d = utc_date(bar["open_time"])
        if d != cur_day:
            cur_day = d
            session_high = None
            session_low = None
        session_high_excl = session_high
        session_low_excl = session_low
        session_high = bar["high"] if session_high is None else max(session_high, bar["high"])
        session_low = bar["low"] if session_low is None else min(session_low, bar["low"])

        if i < new_bars_start_idx:
            continue  # already processed in a previous run

        prev_day = d - timedelta(days=1)
        d_high1 = daily_by_date.get(prev_day, {}).get("high")
        d_low1 = daily_by_date.get(prev_day, {}).get("low")
        d_close1 = daily_by_date.get(prev_day, {}).get("close")
        d_sma200_1 = sma200_by_date.get(prev_day)
        gate_state = gate_by_date.get(prev_day, {"allow_long": False, "allow_short": False})

        curr_px = bar["close"]
        atr_val = atr[i]

        just_exited = False
        if position != 0:
            if position == 1:
                if exit_style == "trail":
                    highest_since_entry = max(highest_since_entry, bar["high"])
                    trail_stop = highest_since_entry - TRAIL_ATR_MULT * atr_val
                    active_stop = max(trail_stop, initial_stop)
                    if bar["low"] <= active_stop:
                        exit_price = active_stop
                        closed_trades.append(_trade_record("Long", entry_time, entry_price, bar["open_time"], exit_price))
                        position = 0
                        just_exited = True
                else:  # fixed_tp
                    hit_stop = bar["low"] <= initial_stop
                    hit_tp = bar["high"] >= tp_price
                    if hit_stop or hit_tp:
                        # Conservative: if both the stop and TP fall inside the
                        # same 15m bar's range, assume the worse outcome (stop)
                        # fills first - can't know intrabar sequencing from
                        # OHLC alone, and this scanner favors not overstating
                        # results.
                        exit_price = initial_stop if hit_stop else tp_price
                        closed_trades.append(_trade_record("Long", entry_time, entry_price, bar["open_time"], exit_price))
                        position = 0
                        just_exited = True
            elif position == -1:
                if exit_style == "trail":
                    lowest_since_entry = min(lowest_since_entry, bar["low"])
                    trail_stop = lowest_since_entry + TRAIL_ATR_MULT * atr_val
                    active_stop = min(trail_stop, initial_stop)
                    if bar["high"] >= active_stop:
                        exit_price = active_stop
                        closed_trades.append(_trade_record("Short", entry_time, entry_price, bar["open_time"], exit_price))
                        position = 0
                        just_exited = True
                else:  # fixed_tp
                    hit_stop = bar["high"] >= initial_stop
                    hit_tp = bar["low"] <= tp_price
                    if hit_stop or hit_tp:
                        exit_price = initial_stop if hit_stop else tp_price
                        closed_trades.append(_trade_record("Short", entry_time, entry_price, bar["open_time"], exit_price))
                        position = 0
                        just_exited = True

        if gate_type == "trend_structure":
            entries_ok = atr_val is not None and d_high1 is not None and d_low1 is not None
            daily_trend_allows_long = gate_state["allow_long"]
            daily_trend_allows_short = gate_state["allow_short"]
        elif gate_type == "none":
            entries_ok = atr_val is not None and d_high1 is not None and d_low1 is not None
            daily_trend_allows_long = True
            daily_trend_allows_short = True
        else:  # sma200
            entries_ok = atr_val is not None and d_high1 is not None and d_sma200_1 is not None
            daily_trend_allows_long = d_close1 is not None and d_sma200_1 is not None and d_close1 > d_sma200_1
            daily_trend_allows_short = d_close1 is not None and d_sma200_1 is not None and d_close1 < d_sma200_1

        if position == 0 and not just_exited and entries_ok:
            daily_breakout = curr_px > d_high1 and daily_trend_allows_long
            intraday_breakout = session_high_excl is not None and curr_px > session_high_excl
            long_condition = daily_breakout and intraday_breakout

            daily_breakdown = (not long_only) and curr_px < d_low1 and daily_trend_allows_short
            intraday_breakdown = (
                not long_only
                and session_low_excl is not None
                and curr_px < session_low_excl - buffer_mult * atr_val
            )
            short_condition = daily_breakdown and intraday_breakdown

            if long_condition:
                position = 1
                entry_price = curr_px
                entry_time = bar["open_time"]
                initial_stop = curr_px - INITIAL_STOP_ATR_MULT * atr_val
                if exit_style == "trail":
                    highest_since_entry = bar["high"]
                else:
                    tp_price = curr_px + rr_mult * INITIAL_STOP_ATR_MULT * atr_val
                last_result = "PASS_LONG"
            elif short_condition:
                position = -1
                entry_price = curr_px
                entry_time = bar["open_time"]
                initial_stop = curr_px + INITIAL_STOP_ATR_MULT * atr_val
                if exit_style == "trail":
                    lowest_since_entry = bar["low"]
                else:
                    tp_price = curr_px - rr_mult * INITIAL_STOP_ATR_MULT * atr_val
                last_result = "PASS_SHORT"
            else:
                last_result = "fail_daily" if not (daily_breakout or daily_breakdown) else "fail_intraday"

    for t in closed_trades:
        append_trade(prefix, variant_name, t)

    prev_should_notify_state = state.get("last_result")
    should_notify = False
    notify_reason = None
    if state.get("last_scan_at") is None:
        should_notify = True
        notify_reason = "first_run"
    elif closed_trades:
        should_notify = True
        notify_reason = "trade_closed"
    elif last_result in ("PASS_LONG", "PASS_SHORT") and prev_should_notify_state not in ("PASS_LONG", "PASS_SHORT"):
        should_notify = True
        notify_reason = "new_entry"

    new_state = {
        "position": position,
        "entry_price": entry_price,
        "entry_time": entry_time,
        "initial_stop": initial_stop,
        "tp_price": tp_price,
        "highest_since_entry": highest_since_entry,
        "lowest_since_entry": lowest_since_entry,
        "last_processed_bar_time": bars_15m[-1]["open_time"] if bars_15m else last_processed,
        "last_scan_at": scanned_at,
        "last_result": last_result,
        "should_notify": should_notify,
        "notify_reason": notify_reason,
    }
    save_state(prefix, variant_name, new_state)

    return {
        "variant": variant_name,
        "position": position,
        "last_result": last_result,
        "closed_trades_this_run": len(closed_trades),
        "should_notify": should_notify,
        "notify_reason": notify_reason,
    }


def _trade_record(side, entry_time, entry_price, exit_time, exit_price):
    ret_pct = ((exit_price - entry_price) / entry_price * 100 if side == "Long"
               else (entry_price - exit_price) / entry_price * 100)
    return {
        "side": side,
        "entry_time": entry_time,
        "entry_time_iso": datetime.fromtimestamp(entry_time / 1000, tz=timezone.utc).isoformat(),
        "entry_price": entry_price,
        "exit_time": exit_time,
        "exit_time_iso": datetime.fromtimestamp(exit_time / 1000, tz=timezone.utc).isoformat(),
        "exit_price": exit_price,
        "return_pct": ret_pct,
    }


def scan_symbol(symbol, cfg, scanned_at):
    daily_end = datetime.now(timezone.utc)
    daily_start = daily_end - timedelta(days=250)
    daily_raw = fetch_retry(
        f"{BINANCE_KLINES_URL}?symbol={symbol}&interval=1d"
        f"&startTime={int(daily_start.timestamp() * 1000)}&endTime={int(daily_end.timestamp() * 1000)}&limit=1000"
    )
    daily_bars = [to_bar(k) for k in daily_raw]
    daily_by_date, sma200_by_date = build_daily_index(daily_bars)
    gate_by_date = build_trend_gate_index(daily_bars)

    # 500 15m bars (~5.2 days) - plenty of headroom to catch up even after
    # extended downtime, while keeping the ATR warmup context intact.
    intraday_raw = fetch_retry(f"{BINANCE_KLINES_URL}?symbol={symbol}&interval=15m&limit=500")
    bars_15m = [to_bar(k) for k in intraday_raw]
    # Drop the last (still-forming) bar - non-repainting convention.
    bars_15m = bars_15m[:-1] if len(bars_15m) > 1 else bars_15m
    atr = wilder_atr(bars_15m, ATR_LEN)

    prefix = cfg["state_prefix"]
    results = {}
    for variant_name, variant_cfg in cfg["variants"].items():
        results[variant_name] = process_variant(
            prefix, variant_name, variant_cfg, bars_15m, atr, daily_by_date, sma200_by_date, gate_by_date, scanned_at
        )
    return results


def main():
    scanned_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    all_results = {}
    for symbol, cfg in SYMBOLS.items():
        all_results[symbol] = scan_symbol(symbol, cfg, scanned_at)

    print(json.dumps(all_results))
    for symbol, results in all_results.items():
        summary_bits = []
        for v, r in results.items():
            pos_str = {0: "flat", 1: "LONG", -1: "SHORT"}[r["position"]]
            notify_bit = f" [NOTIFY:{r['notify_reason']}]" if r["should_notify"] else ""
            summary_bits.append(f"{v}={pos_str}({r['last_result']}){notify_bit}")
        print(f"{symbol} {len(results)}-variant forward scan: " + ", ".join(summary_bits))


if __name__ == "__main__":
    main()
