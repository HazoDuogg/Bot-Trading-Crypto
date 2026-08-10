# Vicion Bot V3 — Baseline Registry (TICKET-160A)

Three distinctly-named baselines exist in this repository. They measure **different things** and must
never be conflated as a single "active baseline." Each is locked in here with its exact numbers, exact
semantics, and exact evidence path, re-verified from real artifacts at input commit `d1a124c`
(branch `cai-tien`).

---

## PROD_8FLAG_POST_T152

- **Trades:** 261 closed
- **Final balance:** $1505.44 (start $400)
- **Winrate:** 41.8%
- **Max Drawdown:** -25.99% (-$405.83)
- **Semantics:** the current production/live 8-flag CLI configuration (see
  `memory/project_official_backtest_config.md` for the flags), run against current code with the
  T152 same-side-duplicate-position guard active (guard merged commit `fac1351`, 2026-08-08). This is
  **current production behavior**, not a research counterfactual.
- **Cost model:** `apps/bot/scripts/backtest.ts`'s built-in backtest cost model (fees/slippage as coded
  into the main backtest engine directly, not the separate `executionCostEngine.ts` scenario harness used
  by T153B/T157/T158/T159). No explicit FEE_ONLY/LIGHT/CENTRAL/CONSERVATIVE scenario selection applies to
  this command — it is the single production-parity run.
- **Input data range:** full local OHLCV history in `data/ohlcv/` (4 symbols x 5 timeframes,
  `--skip-days=20` warm-up skip applied), i.e. `startTimestamp`/`endTimestamp` implied by the CSVs
  themselves — see `data/archive/ticket153b/ticket153b-run-manifest.json` `dataset` block for the exact
  per-file sha256/row-count/timestamp-range of the same underlying OHLCV files (this baseline reads the
  live `data/ohlcv/` files directly, not a frozen snapshot of them).
- **Command (reproduced live during TICKET-160A, exact match, zero drift):**
  ```
  npm run backtest -- --max-concurrent-positions-per-symbol=2 --momentum-direct-enabled=true \
    --momentum-direct-threshold=0.5 --skip-days=20 --momentum-direct-min-sl-percent=1.0 \
    --momentum-direct-tp-r-multiple=3.0 --risk-pool-max-pct=15 --plan-auto-selection-enabled=true
  ```
- **Used for:** parity-checking the current 8-flag production command against future changes. If this
  number ever drifts without an approved, documented production change, that is a regression signal.
- **Evidence:** re-run directly during TICKET-160A verification (see `data/ticket160a-parity-report.md`);
  also previously confirmed identical by TICKET-160 (`data/ticket160-before-after-summary.md` "Numeric
  parity" section, `data/ticket160-regression-parity-report.md` section 9).

---

## EXEC_CURRENT_PRODUCTION_CENTRAL_T153B

- **Trades:** 211 closed
- **Profit Factor:** 1.3018644097963348 (reported as PF 1.3019)
- **Net PnL:** +$460.50836737263205 (reported as +$460.5084)
- **Final equity:** $560.508367372632 (start $100 notional in the T153B execution-cost harness)
- **Max Drawdown:** $418.6270592276059 (56.4586700334848%)
- **Semantics:** current-production entry/regime/risk logic (T152 same-side guard enabled,
  `t152SameSideGuard: true` in the manifest) replayed through the separate T153B/T157/T158/T159
  execution-cost scenario harness (`executionCostEngine.ts`), CENTRAL cost scenario specifically
  (slippage 2bps/side, spread 2bps total, taker fee 0.0004, latency/funding MISSING — modeled, not
  measured). This is a cost-scenario *research instrument* applied to *current production* entry/risk
  behavior — it is NOT the same run as `PROD_8FLAG_POST_T152` (different cost model/harness, different
  starting balance convention, different CLI surface) and the two trade counts (211 vs 261) are expected
  to differ for that reason, not because either is wrong.
- **Data quality:** `DQ-B — COMPARABLE_WITH_LIMITATIONS` (per the manifest); latency and funding costs are
  `MISSING` (not modeled), spread/slippage are `ASSUMED` fixed-bps, fees are `MODELED_CONFIGURED_RATE`.
- **Input data range:** identical `data/ohlcv/` files, hashes/row-counts/timestamps recorded in
  `data/archive/ticket153b/ticket153b-run-manifest.json` `dataset` block (sha256 spot-checked against the
  live files during TICKET-160A — exact match, see `data/ticket160a-parity-report.md`).
  `startTimestamp`/`endTimestamp` for this specific run: 1770779700000 / 1786100400000 (from
  `ticket153b-central-summary.json`).
- **Evidence:** `data/archive/ticket153b/ticket153b-central-summary.json` (exact figures above),
  `data/archive/ticket153b/ticket153b-run-manifest.json` (hash `0040ec0ad76a206d141042b5d93e82b95ae62e960a358d291a38c9dae3d93535`,
  confirmed by TICKET-160A via `sha256sum`),
  `data/archive/ticket153b/ticket153b-scenario-summary.csv` (all 4 scenarios).
- **Verification method (TICKET-160A):** immutable-manifest/hash check, not a full replay (full replay is
  expensive per the ticket's own allowance) — `sha256sum` of the run-manifest and of the referenced
  `data/ohlcv/*` files matches the values recorded inside the manifest exactly.

---

## RESEARCH_OB_DISABLED_CENTRAL_T158_T159

- **Trades:** 264 closed
- **Profit Factor:** 1.3947839228431962 (reported as PF 1.3948)
- **Net PnL:** +$606.6195245715165 (reported as +$606.6195)
- **Max Drawdown:** $418.62705922760574
- **Semantics:** a **counterfactual research baseline** — same entry/regime/risk/T152 logic and same
  CENTRAL cost scenario as `EXEC_CURRENT_PRODUCTION_CENTRAL_T153B`, but with `obEnabled=false` (the T158
  OB-disabled experimental configuration). **This does NOT describe current production behavior.**
  Production's `obEnabled` default remains `true` (see `docs/active-baseline-and-artifact-index.md`
  section 0). T158's decision is SHADOW_ONLY (not merged/deployed); T159 explicitly adopted this
  OB-disabled Central population as its frozen baseline for entry-timing research, which is why the T159
  report's baseline figures are identical to T158's OB_DISABLED Central figures.
- **Input data range:** identical underlying `data/ohlcv/` dataset as T153B/T158 (same manifest chain: the
  `inputManifestHash` field inside `data/archive/ticket158/ticket158-run-manifest.json` points at the T153B
  manifest hash `0040ec0ad76a206d141042b5d93e82b95ae62e960a358d291a38c9dae3d93535`, confirmed identical by
  `sha256sum` during TICKET-160A).
- **Evidence:** `data/archive/ticket157/ticket157-ob_disabled-central-summary.json` and
  `docs/archive/ticket158/ticket158-formal-ob-disabled-portfolio-experiment-report.md` (T158 FINAL DECISION
  block: `OB_DISABLED: PF 1.3947839228431962, net 606.6195245715165, ... trades 264`),
  `data/archive/ticket158/ticket158-scenario-portfolio-comparison.csv`,
  `data/archive/ticket159/ticket159-run-manifest.json` (its `frozenBaselinePopulation` field records the
  pre-T160-move filename `data/ticket157-ob_disabled-central-ledger.csv`; current path after T160's
  reorganization is `data/archive/ticket157/ticket157-ob_disabled-central-ledger.csv`, byte-identical),
  `docs/archive/ticket159/ticket159-unified-entry-timing-optimization-report.md`.
- **Verification method (TICKET-160A):** immutable-manifest/hash check (T158 run-manifest's
  `inputManifestHash` matches the actual T153B manifest's sha256 exactly) plus cross-report numeric
  cross-check (T157's OB_DISABLED Central summary, T158's FINAL DECISION block, and T159's stated frozen
  baseline all report the identical 264/1.3947839228431962/606.6195245715165/418.62705922760574 figures) —
  not a full replay (full replay is expensive per the ticket's own allowance; T159's own report additionally
  states an independent full production-pipeline replay already reproduced 264/264 trades and the net PnL
  to the last digit).

---

## Cost/data semantics summary

| Baseline | Harness | Cost scenario | Starting balance convention | Production behavior? |
|---|---|---|---|---|
| PROD_8FLAG_POST_T152 | `apps/bot/scripts/backtest.ts` main engine | built-in (not a named scenario) | $400 | YES — current production/live config |
| EXEC_CURRENT_PRODUCTION_CENTRAL_T153B | `executionCostEngine.ts` scenario harness | CENTRAL (2bps/2bps/0.04% fee) | $100 | YES — current production entry/risk logic, replayed under a research cost-scenario harness |
| RESEARCH_OB_DISABLED_CENTRAL_T158_T159 | `executionCostEngine.ts` scenario harness | CENTRAL (2bps/2bps/0.04% fee) | $100 | NO — counterfactual (`obEnabled=false`); SHADOW_ONLY, not merged/deployed |

Maximum reconciliation error found across all three baselines during TICKET-160A verification: **0**
(exact match on every compared figure; see `data/ticket160a-parity-report.md`).
