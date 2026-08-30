# TICKET-RT-084 — Current Trend-Following Live-Like Baseline

## Frozen commit and production configuration

- Branch: `real-time`; commit: `76160e72d8c66347c7cd7e6d5c3930a8e0e317bf`. Tracked files were clean at freeze; the pre-existing untracked `apps/bot/scripts/research/rtCheckCurrentSlPct.ts` was excluded from this ticket.
- Symbols: BTCUSDT, ETHUSDT, SOLUSDT, HYPEUSDT, DOGEUSDT.
- H1 trend: latest available closed H1 close versus EMA200 computed by the current detector from its capped 300-candle H1 buffer; equal/above is UPTREND, below is DOWNTREND.
- Signal: three-candle M15 FVG in the H1 direction; candle-2 body/range minimum 0.7. Current No-Trade-Zone gates remain active.
- Entry: LIMIT at gapLow for LONG and gapHigh for SHORT. SL: candle-1 invalidation wick. Minimum SL distance: 0.5%. TP: fixed 2.1R. Pending expiry: 20 M15 candles.
- Production concurrency: one ENTRY_PENDING/position lifecycle per symbol. `liveRunner` does not call the portfolio exposure tracker; its configured 70% cap is therefore not applied here. Circuit-breaker and reconciliation failures cannot be reconstructed from OHLC.
- Sizing config is unchanged: per-trade margin cap 30%; leverage BTCUSDT=20x, ETHUSDT=20x, SOLUSDT=10x, HYPEUSDT=10x, DOGEUSDT=10x. Sizing does not change R-path outcomes.
- No production fee tier exists in source, so the audit assumes maker LIMIT entry 0.02%, taker SL 0.05%, taker TP 0.05%.

## Dataset and frozen candidate generation

- BTCUSDT: 2023-08-28T15:00:00.000Z to 2026-08-27T14:00:00.000Z; M15=105,119, H1=26,279
- ETHUSDT: 2023-08-28T15:00:00.000Z to 2026-08-27T14:00:00.000Z; M15=105,119, H1=26,279
- SOLUSDT: 2023-08-28T15:00:00.000Z to 2026-08-27T14:00:00.000Z; M15=105,119, H1=26,279
- HYPEUSDT: 2025-05-30T10:30:00.000Z to 2026-08-27T14:00:00.000Z; M15=43,599, H1=10,900
- DOGEUSDT: 2023-08-28T15:00:00.000Z to 2026-08-27T14:00:00.000Z; M15=105,119, H1=26,279

The current production signal engine detected 21,887 direction-matched signals. The production SL floor rejected 14,754 before order placement, leaving 7,133 order-eligible candidates. M1 never creates or filters a signal.

The replay dataset contains 846,060 M1 candles in 56,404 complete required M15 blocks. 56402/56404 re-aggregate exactly to the frozen M15 OHLC; 2 mismatches are retained and disclosed as data-version differences.

## Decision timestamp validation

Each candidate becomes eligible only at the close of its third M15 FVG candle. H1 ingestion requires `h1.openTime + 1h <= decisionTimestamp`; equality is allowed because the live poll processes newly closed H1 before M15. The runner rejects any fill earlier than the resolution-adjusted active time. M1 is read only after the frozen decision timestamp.

## Fill, fee, slippage, and latency methodology

Touch requires an entry touch; realistic requires 1bp trade-through; conservative requires 3bp. LIMIT fill price remains the configured entry with no beneficial improvement. The fill minute is evaluated and ambiguous SL+TP is SL-first. Base adverse SL slippage is 1bp and stress is 3bp; TP slippage is 0bp. Latency 0ms uses the decision-time minute, while 500/1000/2000ms all map conservatively to the next complete M1 candle because millisecond history is unavailable. A price already passed before activation is not backfilled; reset and later recross are required.

## Independent execution modes

| Scenario | Candidates | Filled | Expired | Not filled | Skipped | Open | Fill rate | Wins | Losses | WR | Gross PF | Net PF | Gross Exp R | Net Exp R | Gross Net R | Net R | MaxDD R | Loss streak |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Touch / base slip / 0ms | 7133 | 4959 | 2173 | 1 | 0 | 0 | 69.5% | 1727 | 3232 | 34.8% | 1.122 | 0.964 | 0.080 | -0.026 | 394.7 | -127.5 | 226.1 | 23 |
| Trade-through 1bp / base slip / 0ms | 7133 | 4919 | 2213 | 1 | 0 | 0 | 69.0% | 1680 | 3239 | 34.2% | 1.089 | 0.936 | 0.059 | -0.047 | 289.0 | -229.0 | 305.1 | 23 |
| Conservative 3bp / base slip / 0ms | 7133 | 4862 | 2270 | 1 | 0 | 0 | 68.2% | 1614 | 3248 | 33.2% | 1.044 | 0.897 | 0.029 | -0.076 | 141.4 | -370.6 | 426.6 | 23 |

## Production-constrained execution modes

| Scenario | Candidates | Filled | Expired | Not filled | Skipped | Open | Fill rate | Wins | Losses | WR | Gross PF | Net PF | Gross Exp R | Net Exp R | Gross Net R | Net R | MaxDD R | Loss streak |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Touch / base slip / 0ms | 7133 | 3632 | 1591 | 1 | 1909 | 0 | 50.9% | 1303 | 2329 | 35.9% | 1.175 | 1.006 | 0.112 | 0.004 | 407.3 | 16.3 | 126.0 | 14 |
| Trade-through 1bp / base slip / 0ms | 7133 | 3595 | 1623 | 1 | 1914 | 0 | 50.4% | 1260 | 2335 | 35.0% | 1.133 | 0.971 | 0.087 | -0.021 | 311.0 | -76.2 | 171.0 | 14 |
| Conservative 3bp / base slip / 0ms | 7133 | 3533 | 1664 | 1 | 1935 | 0 | 49.5% | 1199 | 2334 | 33.9% | 1.079 | 0.924 | 0.052 | -0.056 | 183.9 | -196.6 | 257.7 | 22 |

## Main realistic result

| Scenario | Candidates | Filled | Expired | Not filled | Skipped | Open | Fill rate | Wins | Losses | WR | Gross PF | Net PF | Gross Exp R | Net Exp R | Gross Net R | Net R | MaxDD R | Loss streak |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Trade-through 1bp / base slip / 0ms | 7133 | 4919 | 2213 | 1 | 0 | 0 | 69.0% | 1680 | 3239 | 34.2% | 1.089 | 0.936 | 0.059 | -0.047 | 289.0 | -229.0 | 305.1 | 23 |

## Latency sensitivity

| Scenario | Candidates | Filled | Expired | Not filled | Skipped | Open | Fill rate | Wins | Losses | WR | Gross PF | Net PF | Gross Exp R | Net Exp R | Gross Net R | Net R | MaxDD R | Loss streak |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Trade-through 1bp / base slip / 0ms | 7133 | 4919 | 2213 | 1 | 0 | 0 | 69.0% | 1680 | 3239 | 34.2% | 1.089 | 0.936 | 0.059 | -0.047 | 289.0 | -229.0 | 305.1 | 23 |
| Trade-through 1bp / base slip / 500ms | 7133 | 4902 | 2230 | 1 | 0 | 0 | 68.7% | 1674 | 3228 | 34.1% | 1.089 | 0.936 | 0.059 | -0.047 | 287.4 | -228.9 | 303.0 | 23 |
| Trade-through 1bp / base slip / 1000ms | 7133 | 4902 | 2230 | 1 | 0 | 0 | 68.7% | 1674 | 3228 | 34.1% | 1.089 | 0.936 | 0.059 | -0.047 | 287.4 | -228.9 | 303.0 | 23 |
| Trade-through 1bp / base slip / 2000ms | 7133 | 4902 | 2230 | 1 | 0 | 0 | 68.7% | 1674 | 3228 | 34.1% | 1.089 | 0.936 | 0.059 | -0.047 | 287.4 | -228.9 | 303.0 | 23 |

## LONG / SHORT breakdown

| Scenario | Candidates | Filled | Expired | Not filled | Skipped | Open | Fill rate | Wins | Losses | WR | Gross PF | Net PF | Gross Exp R | Net Exp R | Gross Net R | Net R | MaxDD R | Loss streak |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| LONG trend-following | 3565 | 2459 | 1105 | 1 | 0 | 0 | 69.0% | 854 | 1605 | 34.7% | 1.117 | 0.961 | 0.077 | -0.028 | 188.4 | -68.7 | 128.2 | 15 |
| SHORT trend-following | 3568 | 2460 | 1108 | 0 | 0 | 0 | 68.9% | 826 | 1634 | 33.6% | 1.062 | 0.912 | 0.041 | -0.065 | 100.6 | -160.3 | 206.9 | 27 |

## Chronological stability

| Scenario | Candidates | Filled | Expired | Not filled | Skipped | Open | Fill rate | Wins | Losses | WR | Gross PF | Net PF | Gross Exp R | Net Exp R | Gross Net R | Net R | MaxDD R | Loss streak |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Early (2023-09-06 to 2024-09-02) | 1937 | 1363 | 574 | 0 | 0 | 0 | 70.4% | 465 | 898 | 34.1% | 1.087 | 0.937 | 0.058 | -0.046 | 78.5 | -63.2 | 90.0 | 14 |
| Middle (2024-09-02 to 2025-08-30) | 2748 | 1893 | 855 | 0 | 0 | 0 | 68.9% | 614 | 1279 | 32.4% | 1.008 | 0.865 | 0.005 | -0.101 | 10.4 | -191.4 | 210.9 | 23 |
| Late (2025-08-30 to 2026-08-27) | 2448 | 1663 | 784 | 1 | 0 | 0 | 67.9% | 601 | 1062 | 36.1% | 1.188 | 1.022 | 0.120 | 0.015 | 200.1 | 25.6 | 102.9 | 15 |

## Combined stress scenario

| Scenario | Candidates | Filled | Expired | Not filled | Skipped | Open | Fill rate | Wins | Losses | WR | Gross PF | Net PF | Gross Exp R | Net Exp R | Gross Net R | Net R | MaxDD R | Loss streak |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Independent | 7133 | 4844 | 2288 | 1 | 0 | 0 | 67.9% | 1607 | 3237 | 33.2% | 1.043 | 0.875 | 0.028 | -0.095 | 137.7 | -461.3 | 507.4 | 23 |
| Production-constrained | 7133 | 3519 | 1672 | 1 | 1941 | 0 | 49.3% | 1194 | 2325 | 33.9% | 1.078 | 0.901 | 0.052 | -0.074 | 182.4 | -261.9 | 315.5 | 22 |

## Conventional backtest comparison

The existing RT-DOGE-001 report is preserved unchanged: 3,804 portfolio-constrained trades, 50.6% WR, PF 1.451, PnL $7,642.57 and MaxDD 2.28%. It is not a clean degradation denominator: it uses candidate suppression, sizing/global exposure, a different fee constant and M15 gap-intersection fills, and reports dollar/PCT rather than R expectancy.

For an apples-to-apples degradation calculation, the table below replays the same 7,133 frozen current candidates with the conventional M15 geometry: any gap intersection is treated as a LIMIT fill, the fill candle is skipped for outcome, and subsequent ambiguous M15 exits are SL-first. Fees are held equal to RT-084; no thresholds are changed.

| Scenario | Candidates | Filled | Expired | Not filled | Skipped | Open | Fill rate | Wins | Losses | WR | Gross PF | Net PF | Gross Exp R | Net Exp R | Gross Net R | Net R | MaxDD R | Loss streak |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| M15 conventional comparator | 7133 | 5902 | 1230 | 1 | 0 | 0 | 82.7% | 2943 | 2959 | 49.9% | 2.089 | 1.819 | 0.546 | 0.450 | 3221.3 | 2654.7 | 24.9 | 12 |
| M1 live-like realistic | 7133 | 4919 | 2213 | 1 | 0 | 0 | 69.0% | 1680 | 3239 | 34.2% | 1.089 | 0.936 | 0.059 | -0.047 | 289.0 | -229.0 | 305.1 | 23 |

| Comparator | WR Δ pp | Gross PF Δ | Net PF Δ | Gross Exp ΔR | Net Exp ΔR | Gross Net ΔR | Net R Δ | MaxDD ΔR | Fill-rate Δ pp |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Live-like minus M15 conventional | -15.7 | -0.999 | -0.883 | -0.487 | -0.496 | -2932.3 | -2883.7 | 280.2 | -13.8 |

## Limitations

- M1 OHLC cannot recover tick order, queue priority, partial fills, or exact millisecond latency. Full fill occurs only after the selected deterministic condition.
- Historical funding and historical exchange filter/tick-size versions are unavailable, so funding is excluded and analytical entry/SL/TP levels are not rounded using today's filters.
- Historical balance, Soft-Veto Python scores, exchange rejects, circuit-breaker trips, reconciliation state and API failures are unavailable. They affect sizing/admission in live operation but are not invented here.
- The constrained view faithfully applies the active per-symbol lifecycle visible in `liveRunner`; it does not invent a cross-symbol cap.
- Audit observation: `SymbolSignalEngine` invalidates its KeyZone cache by H1 buffer length, but that length stays at the 300-candle cap. KeyZone/Soft-Veto features can therefore become stale after the cap. This does not gate direction-matched signal eligibility or R outcomes, and RT-084 leaves the production risk path unchanged.

## Final verdict

The current trend-following strategy is not positive under the main live-like assumptions: Net PF 0.936, Net Expectancy -0.047R/trade, Net R -229.0 and MaxDD 305.1R. This is a benchmark result only and does not authorize a strategy/configuration change.

`NO STRATEGY LOGIC MODIFIED`

`NO PRODUCTION RISK LOGIC MODIFIED`

`NO LIVE ORDER LOGIC MODIFIED`
