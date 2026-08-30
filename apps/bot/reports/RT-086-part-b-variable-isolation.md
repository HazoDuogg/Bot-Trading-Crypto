# TICKET-RT-086 Part B — Variable Isolation: 1.819 (M15 conventional) -> 1.451 (RT-DOGE-001)

Audit-only. Waterfall on the IDENTICAL 7,133 frozen candidates (RT-084) — one variable changed per stage.

| Stage | Change added | Net PF | Δ from prior stage |
|---|---|---:|---:|
| 0 | (baseline) RT-084 M15 conventional comparator | 1.819 | — |
| 1 | + NTZ-at-fill gate (RT-DOGE-001's `!ntz.blocked` check on touchedGap) | 1.821 | 0.002 |
| 2 | + RT-DOGE-001 fee constant (flat 0.2% notional vs RT-084's 0.02%/0.05% split legs) | 1.427 | -0.395 |
| 3 | + portfolio exposure/sizing admission (candidate suppression; equal-weight R among survivors) | 1.435 | 0.008 |
| 4 | + dollar-weighting by actual admitted position size (isolates "unit of report") | 1.436 | 0.001 |
| — | RT-DOGE-001 original (target) | 1.451 | residual = 0.015 |

## Notes / disclosed limitations

- HYPEUSDT `breaksKeyZone` is a display-only field not stored on the frozen `TrendCandidate` — approximated as `false` (flat 1.0% baseline risk) for Stage 3/4 sizing. Affects only HYPEUSDT position-sizing precision (not fill/exit determination), a small fraction of the 7,133 candidates.
- Stage 3/4 use a single shared 30-min-resolution event ordering (fill-time, then exit-time release) across all 5 symbols, matching `rtDogeThreeYearBacktest.ts`'s sequential per-M15-tick admission order.
- "Đơn vị báo cáo $ vs R" is not an independent 6th variable — Stage 4 shows its entire measurable effect is the dollar-weighting shown above, conditional on Stage 3's admitted/scaled trade set.
