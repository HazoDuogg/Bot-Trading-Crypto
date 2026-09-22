#!/usr/bin/env python3
"""
One-off: stress-test "halve N=3/4/5" (and flat baseline) on the Apr1-Jul15
2026 crash-coverage window - the same window backtest_tjl_v2_binance.py
used for BTC's original v2/v2c crash check, chosen for continuity so this
result is comparable to that established precedent rather than an arbitrary
new window.

DATA SOURCE HONESTY NOTE (same standard as the v2f trend-gate crash check
documented in tjl_forward_scanner.py's docstring, which used a "Daily-bar
analytical proxy... not live P&L" for the same reason):

  TradingView's Strategy Tester custom date range is Premium-gated on this
  account (confirmed directly, hit an "Upgrade now" dialog), AND the
  intraday chart's own max-loadable history is capped independent of that -
  confirmed directly for SOLUSDT: even with "load max history" on the 15m
  chart, the earliest available bar was 2026-08-14, only ~5.5 weeks before
  today (2026-09-22). Apr1-Jul15 is 2-5+ months further back than that wall
  reaches, and this is a per-account bar-count/day-count limit (not a
  per-symbol one), so BTCUSDT/ETHUSDT face the same wall - a REAL Pine
  Strategy Tester backtest of this window is not obtainable on this account
  for any of the three symbols. (Not independently re-confirmed for BTC/ETH
  specifically in this pass - inferred from the SOL finding plus the wall
  being an account/plan limit, not a symbol-specific one. Flagging this
  inference explicitly rather than presenting it as directly re-verified.)

  This script instead uses Binance's public REST API (full history, no
  plan wall) run through the EXACT SAME simulation code already used
  throughout this session (tjl_forward_scanner.py's building blocks,
  imported not reimplemented) - a Python replica, same class of approach
  already established and accepted for BTC's original Apr-Jul crash check
  in backtest_tjl_v2_binance.py (that one used v2/v2c trailing-exit logic;
  this one uses the actually-live v2f/v2e fixed-TP logic, extended to
  ETH/SOL for the first time on this window). This is NOT a live-Pine-
  confirmed result - labeled as such throughout, same honesty standard
  requested.
"""
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from datetime import datetime, timezone
import portfolio_risk_sim as prs
import circuit_breaker_sim as cbs

# Override the window to match backtest_tjl_v2_binance.py's crash-coverage
# range exactly (Apr 1 - Jul 15 2026) for continuity with the established
# precedent, instead of the Jul1-Sep20 window used everywhere else this
# session.
prs.WINDOW_START = prs.ms("2026-04-01")
prs.WINDOW_END = prs.ms("2026-07-16")
cbs.WINDOW_START = prs.WINDOW_START


def fmt_t(ms_val):
    return datetime.fromtimestamp(ms_val / 1000, tz=timezone.utc).strftime("%Y-%m-%d %H:%M")


def main():
    print(f"Window: {fmt_t(prs.WINDOW_START)} -> {fmt_t(prs.WINDOW_END)} (Apr1-Jul15 2026 crash-coverage)\n")

    all_trades = []
    for symbol, cfg in prs.CONFIGS.items():
        trades = prs.backtest_symbol(symbol, cfg)
        all_trades.extend(trades)
        wins = [t for t in trades if t["r_mult"] > 0]
        longs = sum(1 for t in trades if t["side"] == "Long")
        shorts = sum(1 for t in trades if t["side"] == "Short")
        wr = (len(wins) / len(trades) * 100) if trades else 0.0
        print(f"{symbol}: {len(trades)} trades ({longs} Long, {shorts} Short), win rate {wr:.1f}%")

    if not all_trades:
        print("No trades at all in this window - stopping.")
        return

    base_curve, _, base_dd, _ = prs.simulate(all_trades, "flat")
    base_final = base_curve[-1][1]
    base_ret = (base_final / 500.0 - 1) * 100
    ratio = base_ret / base_dd if base_dd else float("inf")
    print(f"\nBASELINE (a) flat 1%/trade: final ${base_final:,.2f}, return {base_ret:+.1f}%, "
          f"max DD {base_dd:.2f}%, Return/MaxDD {ratio:.2f}")

    # Per-symbol consecutive-loss streaks for calibration (same diagnostic as the Jul-Sep run)
    for symbol in prs.CONFIGS:
        sym_trades = sorted([t for t in all_trades if t["symbol"] == symbol], key=lambda t: t["entry_time"])
        streak = 0
        streak_events = []
        for t in sym_trades:
            if t["r_mult"] < 0:
                streak += 1
            else:
                if streak >= 3:
                    streak_events.append(streak)
                streak = 0
        if streak >= 3:
            streak_events.append(streak)
        print(f"{symbol} consecutive-loss streaks >=3: {streak_events}")

    print(f"\n{'Mode':<10} {'N':>3} {'Final Eq':>12} {'Return%':>9} {'MaxDD%':>8} {'Ret/DD':>7} {'Blocked':>8} {'Halved':>7} {'#Trips':>7}")
    for mode in ["halve", "pause"]:
        for N in [3, 4, 5]:
            r = cbs.simulate_breaker(all_trades, mode, N)
            ret_pct = (r["final_equity"] / 500.0 - 1) * 100
            r_ratio = ret_pct / r["max_dd"] if r["max_dd"] else float("inf")
            print(f"{mode:<10} {N:>3} {r['final_equity']:>12,.2f} {ret_pct:>8.1f}% {r['max_dd']:>7.2f}% "
                  f"{r_ratio:>7.2f} {r['blocked']:>8} {r['halved_trades']:>7} {len(r['trip_events']):>7}")


if __name__ == "__main__":
    main()
