# Pine archive manifest

Archived 2026-10-09 during the `chore/restructure` reorganization. Full disk
copy of the pre-archive `pine/` directory is backed up at
`D:\pine_backup_20261009.zip` (these scripts were only ever saved to disk,
never saved as named scripts inside TradingView, so this zip plus git history
is the only copy).

Kept live in `pine/` (not archived): `tjl_btcusdt_v2_longshort.pine`,
`tjl_btcusdt_v2c_atrbuffer.pine`, `tjl_btcusdt_v2e_fixedtp.pine`,
`tjl_btcusdt_v2f_trendgate.pine` — these four map directly to the configs
currently running in the live `TjlForwardScanner` task (v2, v2c, v2e, v2f).

| File | Role | Locked result | Reason archived |
|---|---|---|---|
| `tjl_btcusdt_v1.pine` | Earliest TJL prototype: Long-only, ported 1:1 from the original shell scanner (`tjl_btcusdt_scanner.sh`), chandelier ATR trailing exit added as this script's own addition. | Superseded, no final metrics recorded here. | Superseded by `v2_longshort`, which added the Short side and kept the same Long logic. |
| `tjl_btcusdt_v2b_short_confirm.pine` | Short-side experiment #1: requires the intraday-breakdown condition to hold on two consecutive closed bars (2-bar confirmation) instead of one, vs. the v2 baseline (28 trades, 32.1% win, PF ~0.42). | Not locked in. | Rejected Short-side variant — the ATR-buffer fix in `v2c` was chosen instead as the working Short-side solution. |
| `tjl_btcusdt_v2d_trendstrength.pine` | Short-side experiment #3: adds a minimum-distance-below-SMA200 requirement on top of v2c's buffer fix (v2c baseline: Short 18 trades, 50.0% win, PF 0.79). | Not locked in. | Rejected — the project's eventual Short-side gate direction was v2f's Daily pivot-structure + SMA50-slope state gate, not this minimum-distance tweak. |
| `tjl_btcusdt_v3_trendzone.pine` | Fundamentally different methodology: runs entirely on the Daily chart, requires trend structure (HH/HL or LH/LL pivots) + SMA50 slope + zone/reaction-candle confluence to align, vs. v1/v2's 15m breakout approach. | Not adopted. | Listed explicitly among rejected approaches (see `docs/decisions.md`) — the project continued with the v2-family breakout+gate lineage (culminating in v2f) rather than this zone/reaction methodology. |
| `tjl_btcusdt_smc_v1.pine` | Phase 1 of a from-scratch Smart Money Concepts (SMC) rebuild: zone + discount/premium + liquidity-sweep entries, fixed R:R exit. | Per the script's own header: Long PF rose monotonically with R:R (up to 1.26 at RR5.0, 14 trades), but all 6 Short trades lost. | Rejected methodology overall (see `docs/decisions.md`) — superseded by Phase 2 (`smc_v2`), and the SMC approach as a whole was not adopted; the project continued with the TJL breakout family. |
| `tjl_btcusdt_smc_v2.pine` | Phase 2: adds the same trend-structure + SMA-slope filter used elsewhere in the project (HH/HL or LH/LL pivots + SMA slope) to SMC v1's Short side. | Not recorded as locked in; superseded before a final locked result was reached. | Rejected methodology overall (see `docs/decisions.md`) — the SMC line of work was not continued past this point. |

No files had an undeterminable role — all six headers were clear enough to
classify directly from their own in-file documentation plus prior session
context (no guessing was required).
