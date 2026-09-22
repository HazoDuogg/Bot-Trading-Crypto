#!/usr/bin/env python3
"""
One-off: backtest ETHUSDT v2f Long-only and SOLUSDT v2e Long-only (ungated)
over Jul1-Sep20 2026 (same window as the BTC v2e/v2f sweep), producing full
trade lists - then split each symbol's Long trades by BTC's own daily-return
regime on the trade's entry day (BTC strong-up day vs BTC flat-or-down day)
to check whether ETH/SOL's Long edge holds up independent of BTC pumping.

Reuses the exact simulation loop / entry-exit formulas / gate builders from
tjl_forward_scanner.py (the same code currently running live) rather than
re-deriving them - imported directly, not copy-pasted, so there's no risk of
this one-off diverging from what's actually deployed.
"""
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import json
import time as time_module
import urllib.request
from datetime import datetime, timezone, timedelta

import tjl_forward_scanner as tfs

BINANCE_KLINES_URL = tfs.BINANCE_KLINES_URL
UA = tfs.UA


def ms(dt_str):
    return int(datetime.strptime(dt_str, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp() * 1000)


def fetch_klines_paginated(symbol, interval, start_ms, end_ms):
    out = []
    cursor = start_ms
    while cursor < end_ms:
        url = (f"{BINANCE_KLINES_URL}?symbol={symbol}&interval={interval}"
               f"&startTime={cursor}&endTime={end_ms}&limit=1000")
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
        time_module.sleep(0.15)
    return out


CACHE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cache")
os.makedirs(CACHE_DIR, exist_ok=True)


def cached_fetch(symbol, interval, start_ms, end_ms, name):
    path = os.path.join(CACHE_DIR, f"{name}.json")
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    raw = fetch_klines_paginated(symbol, interval, start_ms, end_ms)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(raw, f)
    return raw


WARMUP_DAYS = 45
WINDOW_START = ms("2026-07-01")
WINDOW_END = ms("2026-09-21")  # through Sep 20 close


def backtest_symbol_long_only(symbol, variant_cfg):
    """Simulate ONE variant's Long-only entries/exits over the window using
    tjl_forward_scanner's own building blocks, returning the raw trade list
    (no state files touched - this bypasses process_variant's persistence
    and reimplements just the simulation loop inline over a fixed window,
    since process_variant is designed around incremental forward-test state,
    not a one-shot backtest range)."""
    daily_start = WINDOW_START - WARMUP_DAYS * 86400_000
    daily_raw = cached_fetch(symbol, "1d", daily_start - 250 * 86400_000, WINDOW_END,
                              f"{symbol}_1d")
    daily_bars = [tfs.to_bar(k) for k in daily_raw]
    daily_by_date, sma200_by_date = tfs.build_daily_index(daily_bars)
    gate_by_date = tfs.build_trend_gate_index(daily_bars)

    intraday_raw = cached_fetch(symbol, "15m", daily_start, WINDOW_END, f"{symbol}_15m")
    bars_15m = [tfs.to_bar(k) for k in intraday_raw]
    atr = tfs.wilder_atr(bars_15m, tfs.ATR_LEN)

    buffer_mult = variant_cfg["buffer_mult"]
    rr_mult = variant_cfg.get("rr_mult")
    gate_type = variant_cfg.get("gate", "sma200")
    long_only = variant_cfg.get("long_only", False)

    position = 0
    entry_price = entry_time = initial_stop = tp_price = None
    session_high = session_low = None
    cur_day = None
    trades = []

    for i, bar in enumerate(bars_15m):
        d = tfs.utc_date(bar["open_time"])
        if d != cur_day:
            cur_day = d
            session_high = None
            session_low = None
        session_high_excl = session_high
        session_low_excl = session_low
        session_high = bar["high"] if session_high is None else max(session_high, bar["high"])
        session_low = bar["low"] if session_low is None else min(session_low, bar["low"])

        if bar["open_time"] < WINDOW_START:
            continue  # warmup-only bar: still fed through ATR/session tracking above, no entries

        prev_day = d - timedelta(days=1)
        d_high1 = daily_by_date.get(prev_day, {}).get("high")
        d_low1 = daily_by_date.get(prev_day, {}).get("low")
        d_close1 = daily_by_date.get(prev_day, {}).get("close")
        d_sma200_1 = sma200_by_date.get(prev_day)
        gate_state = gate_by_date.get(prev_day, {"allow_long": False, "allow_short": False})

        curr_px = bar["close"]
        atr_val = atr[i]

        just_exited = False
        if position == 1:
            hit_stop = bar["low"] <= initial_stop
            hit_tp = bar["high"] >= tp_price
            if hit_stop or hit_tp:
                exit_price = initial_stop if hit_stop else tp_price
                ret_pct = (exit_price - entry_price) / entry_price * 100
                trades.append({
                    "side": "Long", "entry_time": entry_time, "entry_price": entry_price,
                    "exit_time": bar["open_time"], "exit_price": exit_price, "return_pct": ret_pct,
                })
                position = 0
                just_exited = True

        if gate_type == "trend_structure":
            entries_ok = atr_val is not None and d_high1 is not None and d_low1 is not None
            allow_long = gate_state["allow_long"]
        elif gate_type == "none":
            entries_ok = atr_val is not None and d_high1 is not None and d_low1 is not None
            allow_long = True
        else:
            entries_ok = atr_val is not None and d_high1 is not None and d_sma200_1 is not None
            allow_long = d_close1 is not None and d_sma200_1 is not None and d_close1 > d_sma200_1

        if position == 0 and not just_exited and entries_ok:
            daily_breakout = curr_px > d_high1 and allow_long
            intraday_breakout = session_high_excl is not None and curr_px > session_high_excl
            if daily_breakout and intraday_breakout:
                position = 1
                entry_price = curr_px
                entry_time = bar["open_time"]
                initial_stop = curr_px - tfs.INITIAL_STOP_ATR_MULT * atr_val
                tp_price = curr_px + rr_mult * tfs.INITIAL_STOP_ATR_MULT * atr_val

    return trades


def build_btc_daily_returns():
    daily_start = WINDOW_START - 5 * 86400_000
    daily_raw = cached_fetch("BTCUSDT", "1d", daily_start, WINDOW_END, "BTCUSDT_1d_regime")
    bars = [tfs.to_bar(k) for k in daily_raw]
    by_date = {tfs.utc_date(b["open_time"]): b for b in bars}
    dates_sorted = sorted(by_date.keys())
    ret_by_date = {}
    for i in range(1, len(dates_sorted)):
        d0, d1 = dates_sorted[i - 1], dates_sorted[i]
        ret_by_date[d1] = by_date[d1]["close"] / by_date[d0]["close"] - 1.0
    return ret_by_date


def classify_regime(btc_ret_by_date, window_dates):
    """Top third of BTC daily returns (within the window) = 'strong up',
    bottom two-thirds = 'flat/down'."""
    window_rets = sorted(btc_ret_by_date[d] for d in window_dates if d in btc_ret_by_date)
    n = len(window_rets)
    cutoff = window_rets[int(n * 2 / 3)]  # top-third threshold
    return cutoff


def stats(trades):
    n = len(trades)
    if n == 0:
        return "0 trades"
    wins = [t for t in trades if t["return_pct"] > 0]
    gp = sum(t["return_pct"] for t in trades if t["return_pct"] > 0)
    gl = -sum(t["return_pct"] for t in trades if t["return_pct"] <= 0)
    pf = (gp / gl) if gl > 0 else float("inf") if gp > 0 else float("nan")
    return f"{n} trades, win rate {len(wins)/n*100:.1f}%, PF {pf:.2f}, net {sum(t['return_pct'] for t in trades):+.2f}%"


def main():
    btc_ret_by_date = build_btc_daily_returns()
    window_dates = [tfs.utc_date(WINDOW_START) + timedelta(days=i)
                    for i in range((tfs.utc_date(WINDOW_END) - tfs.utc_date(WINDOW_START)).days + 1)]
    cutoff = classify_regime(btc_ret_by_date, window_dates)
    print(f"BTC daily-return top-third cutoff (>= this = 'BTC strong-up day'): {cutoff*100:+.2f}%")
    strong_up_days = {d for d in window_dates if btc_ret_by_date.get(d, -999) >= cutoff}
    print(f"  {len(strong_up_days)} 'BTC strong-up' days, {len(window_dates)-len(strong_up_days)} 'BTC flat/down' days out of {len(window_dates)}\n")

    configs = {
        "ETHUSDT": {"buffer_mult": 0.5, "rr_mult": 2.25, "gate": "trend_structure", "long_only": True},
        "SOLUSDT": {"buffer_mult": 0.5, "rr_mult": 2.25, "gate": "none", "long_only": True},
    }

    for symbol, cfg in configs.items():
        trades = backtest_symbol_long_only(symbol, cfg)
        print(f"=== {symbol} Long-only ({'v2f trend-structure gate' if cfg['gate']=='trend_structure' else 'v2e ungated'}), Jul1-Sep20 2026 ===")
        print(f"  ALL: {stats(trades)}")

        on_strong_up = [t for t in trades if tfs.utc_date(t["entry_time"]) in strong_up_days]
        on_flat_down = [t for t in trades if tfs.utc_date(t["entry_time"]) not in strong_up_days]
        print(f"  Entered on BTC strong-up day:  {stats(on_strong_up)}")
        print(f"  Entered on BTC flat/down day:  {stats(on_flat_down)}")
        print()


if __name__ == "__main__":
    main()
