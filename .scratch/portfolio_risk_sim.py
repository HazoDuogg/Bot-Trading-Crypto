#!/usr/bin/env python3
"""
One-off: model portfolio-level equity curve/drawdown under two position-
sizing schemes, using the three symbols' LIVE-LOCKED configs (same as
tjl_forward_scanner.py) over Jul1-Sep20 2026:
  BTCUSDT v2f - buffer 0.5, fixed TP RR=2.25, trend-structure gate, BOTH sides
  ETHUSDT v2f - buffer 0.5, fixed TP RR=2.25, trend-structure gate, Long only
  SOLUSDT v2e - buffer 0.5, fixed TP RR=2.25, ungated,             Long only

All three variants share the identical exit bracket shape (stop = entry -/+
1.5xATR = "1R", take-profit = entry +/- rrMult*1R = "+2.25R"), so every trade
resolves to EXACTLY one of two outcomes: -1R (stop hit) or +2.25R (TP hit).
That makes R-multiple bookkeeping exact - no need to approximate P&L.

Scheme (a) CURRENT: every trade risks a flat 1% of equity at entry, no
matter how many other symbols are simultaneously open in the same direction.
Scheme (b) CAPPED: a new trade's risk is sized down so total risk currently
committed to OPEN positions sharing its direction (Long or Short, across all
three symbols) never exceeds a cap (tested at 1.0% and 1.5%). Existing open
positions are never resized after the fact (not realistic to do so); only
the INCOMING trade's size is constrained by remaining budget. If the budget
is already exhausted, the incoming trade is skipped entirely (blocked, not
just shrunk to ~0).

This is an event-driven simulation (entries and exits processed in
chronological order), so equity compounds correctly even with overlapping
positions across symbols.
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

CACHE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cache")
os.makedirs(CACHE_DIR, exist_ok=True)


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

CONFIGS = {
    "BTCUSDT": {"buffer_mult": 0.5, "rr_mult": 2.25, "gate": "trend_structure", "long_only": False},
    "ETHUSDT": {"buffer_mult": 0.5, "rr_mult": 2.25, "gate": "trend_structure", "long_only": True},
    "SOLUSDT": {"buffer_mult": 0.5, "rr_mult": 2.25, "gate": "none", "long_only": True},
}


def backtest_symbol(symbol, cfg):
    """Full trade list (both sides per cfg) for the live-locked variant,
    over WINDOW_START..WINDOW_END, using the exact tjl_forward_scanner
    building blocks (imported, not reimplemented)."""
    daily_start = WINDOW_START - WARMUP_DAYS * 86400_000
    daily_raw = cached_fetch(symbol, "1d", daily_start - 250 * 86400_000, WINDOW_END, f"{symbol}_1d")
    daily_bars = [tfs.to_bar(k) for k in daily_raw]
    daily_by_date, sma200_by_date = tfs.build_daily_index(daily_bars)
    gate_by_date = tfs.build_trend_gate_index(daily_bars)

    intraday_raw = cached_fetch(symbol, "15m", daily_start, WINDOW_END, f"{symbol}_15m")
    bars_15m = [tfs.to_bar(k) for k in intraday_raw]
    atr = tfs.wilder_atr(bars_15m, tfs.ATR_LEN)

    buffer_mult = cfg["buffer_mult"]
    rr_mult = cfg["rr_mult"]
    gate_type = cfg["gate"]
    long_only = cfg["long_only"]

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
            continue

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
                r_mult = -1.0 if hit_stop else rr_mult
                trades.append({"symbol": symbol, "side": "Long", "entry_time": entry_time,
                               "exit_time": bar["open_time"], "r_mult": r_mult})
                position = 0
                just_exited = True
        elif position == -1:
            hit_stop = bar["high"] >= initial_stop
            hit_tp = bar["low"] <= tp_price
            if hit_stop or hit_tp:
                r_mult = -1.0 if hit_stop else rr_mult
                trades.append({"symbol": symbol, "side": "Short", "entry_time": entry_time,
                               "exit_time": bar["open_time"], "r_mult": r_mult})
                position = 0
                just_exited = True

        if gate_type == "trend_structure":
            entries_ok = atr_val is not None and d_high1 is not None and d_low1 is not None
            allow_long, allow_short = gate_state["allow_long"], gate_state["allow_short"]
        elif gate_type == "none":
            entries_ok = atr_val is not None and d_high1 is not None and d_low1 is not None
            allow_long, allow_short = True, True
        else:
            entries_ok = atr_val is not None and d_high1 is not None and d_sma200_1 is not None
            allow_long = d_close1 is not None and d_sma200_1 is not None and d_close1 > d_sma200_1
            allow_short = d_close1 is not None and d_sma200_1 is not None and d_close1 < d_sma200_1

        if position == 0 and not just_exited and entries_ok:
            daily_breakout = curr_px > d_high1 and allow_long
            intraday_breakout = session_high_excl is not None and curr_px > session_high_excl
            long_condition = daily_breakout and intraday_breakout

            daily_breakdown = (not long_only) and curr_px < d_low1 and allow_short
            intraday_breakdown = (not long_only and session_low_excl is not None
                                   and curr_px < session_low_excl - buffer_mult * atr_val)
            short_condition = daily_breakdown and intraday_breakdown

            if long_condition:
                position = 1
                entry_price, entry_time = curr_px, bar["open_time"]
                initial_stop = curr_px - tfs.INITIAL_STOP_ATR_MULT * atr_val
                tp_price = curr_px + rr_mult * tfs.INITIAL_STOP_ATR_MULT * atr_val
            elif short_condition:
                position = -1
                entry_price, entry_time = curr_px, bar["open_time"]
                initial_stop = curr_px + tfs.INITIAL_STOP_ATR_MULT * atr_val
                tp_price = curr_px - rr_mult * tfs.INITIAL_STOP_ATR_MULT * atr_val

    return trades


def simulate(all_trades, scheme, cap=None, risk_per_trade=0.01, starting_equity=500.0):
    """Event-driven equity simulation.
    scheme='flat': every trade risks risk_per_trade of equity, no cap.
    scheme='capped': incoming trade's risk is min(risk_per_trade, remaining
      budget under `cap` given other currently-OPEN same-direction trades
      across symbols). Existing open trades are never resized.
    Returns (equity_curve: list of (time_ms, equity), trades_with_risk, max_dd_pct, blocked_count).
    """
    events = []
    for t in all_trades:
        events.append((t["entry_time"], "entry", t))
        events.append((t["exit_time"], "exit", t))
    events.sort(key=lambda e: (e[0], 0 if e[1] == "exit" else 1))  # process exits before entries at same ts

    equity = starting_equity
    open_trades = {}  # id(t) -> risk_fraction locked at entry
    equity_curve = [(WINDOW_START, equity)]
    blocked = 0
    trade_risk_log = []

    for t_ms, kind, trade in events:
        tid = id(trade)
        if kind == "entry":
            if scheme == "flat":
                risk_frac = risk_per_trade
            else:  # capped
                committed = sum(r for tt, r in open_trades.values() if tt["side"] == trade["side"])
                remaining = max(0.0, cap - committed)
                risk_frac = min(risk_per_trade, remaining)
            if risk_frac <= 0:
                blocked += 1
                continue
            open_trades[tid] = (trade, risk_frac)
            trade_risk_log.append({**trade, "risk_frac": risk_frac})
        else:  # exit
            if tid not in open_trades:
                continue  # was blocked at entry, never opened
            _, risk_frac = open_trades.pop(tid)
            pnl_frac = risk_frac * trade["r_mult"]
            equity *= (1.0 + pnl_frac)
            equity_curve.append((t_ms, equity))

    # max drawdown on the equity curve
    peak = equity_curve[0][1]
    max_dd = 0.0
    for _, e in equity_curve:
        peak = max(peak, e)
        dd = (peak - e) / peak * 100
        max_dd = max(max_dd, dd)

    return equity_curve, trade_risk_log, max_dd, blocked


def overlap_stats(all_trades):
    """% of Long-side trade-time where >=2 symbols are simultaneously Long
    (and same for Short), to quantify how often the cap actually binds."""
    longs = sorted([t for t in all_trades if t["side"] == "Long"], key=lambda t: t["entry_time"])
    shorts = sorted([t for t in all_trades if t["side"] == "Short"], key=lambda t: t["entry_time"])

    def pct_time_with_overlap(trades):
        if not trades:
            return 0.0
        events = []
        for t in trades:
            events.append((t["entry_time"], 1))
            events.append((t["exit_time"], -1))
        events.sort()
        cur = 0
        overlap_ms = 0
        total_ms = 0
        last_t = events[0][0]
        for t_ms, delta in events:
            dt = t_ms - last_t
            if cur >= 2:
                overlap_ms += dt
            if cur >= 1:
                total_ms += dt
            cur += delta
            last_t = t_ms
        return (overlap_ms / total_ms * 100) if total_ms else 0.0

    return pct_time_with_overlap(longs), pct_time_with_overlap(shorts)


def main():
    all_trades = []
    for symbol, cfg in CONFIGS.items():
        trades = backtest_symbol(symbol, cfg)
        all_trades.extend(trades)
        wins = [t for t in trades if t["r_mult"] > 0]
        print(f"{symbol}: {len(trades)} trades ({sum(1 for t in trades if t['side']=='Long')} Long, "
              f"{sum(1 for t in trades if t['side']=='Short')} Short), win rate {len(wins)/len(trades)*100:.1f}%")

    overlap_long_pct, overlap_short_pct = overlap_stats(all_trades)
    print(f"\n% of Long open-time with >=2 symbols simultaneously Long: {overlap_long_pct:.1f}%")
    print(f"% of Short open-time with >=2 symbols simultaneously Short: {overlap_short_pct:.1f}%")

    print(f"\n{'Scheme':<28} {'Final Equity':>14} {'Return%':>10} {'MaxDD%':>9} {'Blocked':>9}")
    results = {}
    for label, scheme, cap in [
        ("(a) flat 1% per trade", "flat", None),
        ("(b) capped 1.0% total", "capped", 0.01),
        ("(b) capped 1.5% total", "capped", 0.015),
    ]:
        curve, log, max_dd, blocked = simulate(all_trades, scheme, cap=cap)
        final_eq = curve[-1][1]
        ret_pct = (final_eq / 500.0 - 1) * 100
        results[label] = (curve, max_dd, ret_pct, blocked)
        print(f"{label:<28} {final_eq:>14,.2f} {ret_pct:>9.1f}% {max_dd:>8.2f}% {blocked:>9}")

    print("\n=== Equity curve snapshots (every ~10th closed trade) for (a) vs capped 1.25%-equiv range ===")
    for label in results:
        curve = results[label][0]
        print(f"\n{label}:")
        step = max(1, len(curve) // 10)
        for i in range(0, len(curve), step):
            t_ms, e = curve[i]
            dt = datetime.fromtimestamp(t_ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d")
            print(f"  {dt}: ${e:,.2f}")


if __name__ == "__main__":
    main()
