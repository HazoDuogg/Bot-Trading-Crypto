#!/usr/bin/env python3
"""
One-off: test a PER-SYMBOL consecutive-loss circuit breaker on the same
112-trade dataset (BTCUSDT v2f both sides, ETHUSDT v2f Long, SOLUSDT v2e
Long, Jul1-Sep20 2026) used for the flat-vs-correlation-cap comparison.

Two circuit-breaker modes, swept over N (consecutive losses on ONE symbol
before it trips):
  (a) pause  - after N consecutive losses on a symbol, block new entries on
               THAT symbol only for a fixed cooldown (24h), then resume at
               normal 1% risk. Other symbols are completely unaffected.
  (b) halve  - after N consecutive losses on a symbol, that symbol's risk
               drops to 0.5% until its next winning trade (then resets to
               1%). Other symbols unaffected.

Baseline for comparison: flat 1% per trade, no breaker (the winning scheme
from the correlation-cap test: +48.1% return, 13.06% max DD).

Consecutive-loss state is tracked PER SYMBOL using that symbol's own trade
sequence (each symbol only ever has one open position at a time, so streaks
are unambiguous - no overlap issue within a symbol). Equity still compounds
via a single global chronological event replay, exactly like the
correlation-cap simulation, so cross-symbol timing effects are preserved.
"""
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from datetime import datetime, timezone
import portfolio_risk_sim as prs

WINDOW_START = prs.WINDOW_START


def simulate_breaker(all_trades, mode, N, cooldown_hours=24, risk_per_trade=0.01, starting_equity=500.0):
    events = []
    for t in all_trades:
        events.append((t["entry_time"], "entry", t))
        events.append((t["exit_time"], "exit", t))
    events.sort(key=lambda e: (e[0], 0 if e[1] == "exit" else 1))

    equity = starting_equity
    open_trades = {}  # id(t) -> risk_frac
    consec_losses = {s: 0 for s in prs.CONFIGS}
    cooldown_until = {s: -1 for s in prs.CONFIGS}
    equity_curve = [(WINDOW_START, equity)]
    blocked = 0
    halved_trades = 0
    trip_events = []  # (symbol, time) when breaker actually trips (crosses N)

    for t_ms, kind, trade in events:
        tid = id(trade)
        sym = trade["symbol"]
        if kind == "entry":
            if mode == "pause":
                if t_ms < cooldown_until[sym]:
                    blocked += 1
                    continue
                risk_frac = risk_per_trade
            else:  # halve
                if consec_losses[sym] >= N:
                    risk_frac = risk_per_trade * 0.5
                    halved_trades += 1
                else:
                    risk_frac = risk_per_trade
            open_trades[tid] = risk_frac
        else:  # exit
            if tid not in open_trades:
                continue
            risk_frac = open_trades.pop(tid)
            pnl_frac = risk_frac * trade["r_mult"]
            equity *= (1.0 + pnl_frac)
            equity_curve.append((t_ms, equity))

            if trade["r_mult"] < 0:
                consec_losses[sym] += 1
                if consec_losses[sym] == N:
                    trip_events.append((sym, t_ms))
                    if mode == "pause":
                        cooldown_until[sym] = t_ms + cooldown_hours * 3600 * 1000
            else:
                consec_losses[sym] = 0

    peak = equity_curve[0][1]
    max_dd = 0.0
    dd_start = dd_end = None
    peak_t = equity_curve[0][0]
    for t_ms, e in equity_curve:
        if e > peak:
            peak = e
            peak_t = t_ms
        dd = (peak - e) / peak * 100
        if dd > max_dd:
            max_dd = dd
            dd_start, dd_end = peak_t, t_ms

    return {
        "equity_curve": equity_curve, "final_equity": equity_curve[-1][1],
        "max_dd": max_dd, "dd_window": (dd_start, dd_end),
        "blocked": blocked, "halved_trades": halved_trades, "trip_events": trip_events,
    }


def fmt_t(ms):
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d %H:%M")


def main():
    all_trades = []
    for symbol, cfg in prs.CONFIGS.items():
        all_trades.extend(prs.backtest_symbol(symbol, cfg))

    # Baseline
    base_curve, _, base_dd, _ = prs.simulate(all_trades, "flat")
    base_final = base_curve[-1][1]
    base_ret = (base_final / 500.0 - 1) * 100
    print(f"BASELINE (a) flat 1%/trade: final ${base_final:,.2f}, return {base_ret:+.1f}%, max DD {base_dd:.2f}%, "
          f"Return/MaxDD {base_ret/base_dd:.2f}")

    # Show SOL's actual consecutive-loss streaks for calibration
    sol_trades = sorted([t for t in all_trades if t["symbol"] == "SOLUSDT"], key=lambda t: t["entry_time"])
    streak = 0
    max_streak = 0
    streak_events = []
    for t in sol_trades:
        if t["r_mult"] < 0:
            streak += 1
            max_streak = max(max_streak, streak)
        else:
            if streak >= 3:
                streak_events.append(streak)
            streak = 0
    if streak >= 3:
        streak_events.append(streak)
    print(f"\nSOL consecutive-loss streaks >=3 observed in the data: {streak_events} (max streak: {max_streak})")

    print(f"\n{'Mode':<10} {'N':>3} {'Final Eq':>12} {'Return%':>9} {'MaxDD%':>8} {'Ret/DD':>7} {'Blocked':>8} {'Halved':>7} {'#Trips':>7}")
    results = {}
    for mode in ["pause", "halve"]:
        for N in [3, 4, 5]:
            r = simulate_breaker(all_trades, mode, N)
            ret_pct = (r["final_equity"] / 500.0 - 1) * 100
            ratio = ret_pct / r["max_dd"] if r["max_dd"] else float("inf")
            key = f"{mode}_N{N}"
            results[key] = r
            print(f"{mode:<10} {N:>3} {r['final_equity']:>12,.2f} {ret_pct:>8.1f}% {r['max_dd']:>7.2f}% "
                  f"{ratio:>7.2f} {r['blocked']:>8} {r['halved_trades']:>7} {len(r['trip_events']):>7}")

    print(f"\n=== Max-DD window per config (baseline was {fmt_t(1751328600000)}-ish Jul2-Aug5) ===")
    print(f"Baseline: {fmt_t(base_curve[0][0])} anchor; DD window not tracked in prs.simulate return - recomputed below")
    # recompute baseline dd window explicitly
    peak = base_curve[0][1]; peak_t = base_curve[0][0]; max_dd=0; dd_s=dd_e=None
    for t_ms, e in base_curve:
        if e > peak: peak=e; peak_t=t_ms
        dd = (peak-e)/peak*100
        if dd > max_dd: max_dd=dd; dd_s,dd_e = peak_t,t_ms
    print(f"  flat baseline max DD window: {fmt_t(dd_s)} -> {fmt_t(dd_e)} ({max_dd:.2f}%)")
    for key, r in results.items():
        s,e = r["dd_window"]
        print(f"  {key}: {fmt_t(s)} -> {fmt_t(e)} ({r['max_dd']:.2f}%)")

    print("\n=== Breaker trip events (symbol, time) per config ===")
    for key, r in results.items():
        print(f"{key}: {[(s, fmt_t(t)) for s,t in r['trip_events']]}")


if __name__ == "__main__":
    main()
