# T159 — Input Parity and Leakage Report

Git HEAD at time of this research: `cced931b39265d51b41017689ecec378fd9cb88b` (branch `cai-tien`).
Raw OHLCV inputs (`data/ohlcv/*.csv`) are unchanged from the T153a fingerprint
(`data/ticket153a-baseline-fingerprint.json`), which was taken at this same commit.

## 1. Baseline ledger trust check (Acceptance Criteria #1)

Per the ticket's own efficiency instruction, the frozen OB-disabled Central ledger
(`data/ticket157-ob_disabled-central-ledger.csv`, 264 data rows) was **not** re-simulated from
scratch. Two independent, cheap checks were run against it instead:

**Aggregate recompute (sum/count over the ledger's own `netPnl` column, no re-simulation):**

| Metric | Frozen summary (`ticket157-ob_disabled-central-summary.json`) | Recomputed from ledger `netPnl` | Match |
|---|---|---|---|
| Trade count | 264 | 264 | PASS |
| Net PnL | 606.6195245715165 | 606.6195245715165 | PASS (exact) |
| Win rate | 41.6666...% | 41.6666...% | PASS (exact) |
| Profit factor | 1.3947839228431962 | 1.3947839228431962 | PASS (exact) |
| Expectancy | 2.2978012294375625 | 2.2978012294375625 | PASS (exact) |

**Spot check (5 trades, entry/exit prices vs raw `data/ohlcv/*_5m.csv`):**

| orderId | field | expected | candle at that timestamp | verdict |
|---|---|---|---|---|
| BTCUSDT-1770779700000 | entry | 68042.5 | close=68042.5 | matches candle close exactly |
| BTCUSDT-1770845100000 (exit) | exit | 67988.066 (BREAKEVEN_SL) | range [67882.1, 68194.9] | within range — intrabar SL fill, consistent with exitReason |
| ETHUSDT-1771763700000 | entry | 1962.9 | close=1962.9 | matches candle close exactly |
| ETHUSDT-1780813500000 | entry | 1617.46 | close=1617.46 | matches candle close exactly |
| ETHUSDT-1780822500000 (exit) | exit | 1638.001742 (SL) | range [1632.8, 1642.16] | within range — intrabar SL fill |
| ETHUSDT-1785000600000 | entry | 1873.46 | close=1873.46 | matches candle close exactly |
| ETHUSDT-1786078200000 | entry | 1894.52 | close=1894.52 | matches candle close exactly |
| ETHUSDT-1786092000000 (exit) | exit | 1910.39 (SL) | range [1905.57, 1914.61] | within range — intrabar SL fill |

Entries land exactly on the decision candle's close (decisions execute at candle close, matching the
documented orchestrator semantics). SL exits land inside the exit candle's high/low range rather than
at its close, consistent with intrabar stop execution — the same pattern verified in prior tickets
this session.

**Result: PASS.** Both required checks (aggregate recompute + spot check) match. Proceeded to build
on this frozen population per the ticket's own instruction.

## 2. Reproduction cross-check (independent, informational — not a substitute for #1)

`apps/bot/scripts/ticket159TimingDatasetBuilder.ts` independently reruns
`runReplay(buildBaselineConfig() + {sameSideDuplicateGuardEnabled:true, obEnabled:false}, null, 57_833)`
— the exact same config and frozen replay-stop checkpoint (`57_833`) used by every T157/T159 scenario
script — to recover full `ClosedTrade` records (including `slPrice`, which the ledger CSV does not
export). This reproduced trade count and MOMENTUM_DIRECT subset count are reported in
`data/ticket159-reproduction-check.json`.

Two bugs were caught and fixed by this self-check before it was trusted:
1. A first attempt passed `endStepInclusive: null` (no checkpoint) instead of the frozen `57_833`
   step, letting the replay run into newer raw history and producing 268 trades / 145
   MOMENTUM_DIRECT instead of 264 / 139.
2. After fixing (1), the same 268/145 count persisted because the OB-disable mechanism used
   (`obEnabled: false`) is behaviorally equivalent to ticket157's own recipe (`obDisabledSymbols`)
   for OB detection, so that was not the cause — the actual remaining cause was using
   `fillModel: null` (fee-only) instead of the CENTRAL fill model
   (`makeFillModel(..., 2/10_000, 2/10_000)`). Because this replay is fully path-dependent (account
   balance after each fill feeds sizing/admission gates for later trades), a different fill model
   changes which trades get admitted, not just their cost. Fixed to use the exact same CENTRAL fill
   model as `ticket157RunVariantScenario.ts`'s OB_DISABLED-CENTRAL run.

**Final result: exact match.** `data/ticket159-reproduction-check.json` — 264/264 trades, 139/139
MOMENTUM_DIRECT trades, net PnL $606.6195245715165 vs frozen $606.6195245715165 (`netPnlMatches:
true`). This is a genuine independent reproduction of the frozen population (not merely a metadata
copy), obtained via a full replay of the real production pipeline.

## 3. Config parity across all T159 runs

| Setting | Value | Verified how |
|---|---|---|
| `entryRouterConfig.obEnabled` | `false` | every T159 run (`ticket159RunTimingScenario.ts`, `ticket159TimingDatasetBuilder.ts`) sets this explicitly |
| `sameSideDuplicateGuardEnabled` | `true` | T151/T152 same-side guard kept ON, matching current production semantics — explicitly set in every T159 script |
| `momentumDirectTpRMultiple` | `3.0` | frozen baseline value from `buildBaselineConfig()`, unchanged |
| Scenario cost table (FEE_ONLY/LIGHT/CENTRAL/CONSERVATIVE) | `[0,0]/[1,1]/[2,2]/[5,5]` bps slippage/spread | identical to `ticket157RunVariantScenario.ts`'s own table, confirmed by direct comparison |
| Replay stop checkpoint | step `57_833` | identical across `ticket157RunVariantScenario.ts`, `ticket159RunTimingScenario.ts`, `ticket159TimingDatasetBuilder.ts` |

## 4. Leakage audit (Acceptance Criteria: "be paranoid about this")

| Check | Method | Result |
|---|---|---|
| Decision-time features use only pre-decision candles | `decisionWindow5m()` in `ticket159TimingDatasetBuilder.ts` slices 5m candles to `candles5m.slice(0, index+1)` where `index` is the exact decision-candle index — no candle after `entryTimestamp` is ever passed into `computeDecisionFeatures` | PASS |
| Outcome/excursion features use only post-entry candles | `computeOutcomeFeatures()` filters 1m candles to `timestamp > entryTimestamp && timestamp <= exitTimestamp` | PASS |
| No same-candle intrabar ordering guessed | `sameCandleAmbiguous` is set `true` whenever one 1m candle's range contains both a >=0.25R favorable and >=0.25R adverse excursion; `favorableFirst`/`adverseFirst` are forced to `null` in that case | PASS |
| BREAKOUT_PULLBACK_CONTINUATION confirmation uses only closed 1m candles | `advanceMomentumPullback()` (`apps/bot/src/backtest/momentumEntryTimingResearch.ts`) reads `candles1m.filter(c => c.timestamp > arm.armedTimestamp)` and requires two consecutive **closed** candles (`last`, `previous`) — no partially-formed candle is read | PASS |
| Challenger geometry (extension/reward) reuses the same frozen-trigger function used for diagnostics | `computeMomentumTimingGeometry()` is the single source of truth called both by the live orchestrator gate and by the offline dataset builder | PASS |
| Classification thresholds frozen before holdout | `ticket159FailureClassifier.ts` computes `extensionAtrDevP75` from the DEVELOPMENT split only (first 70% of trades by `entryTimestamp`), then applies it to both DEVELOPMENT and HOLDOUT rows without re-fitting | PASS |
| Production behavior unmodified | `config.momentumEntryTimingResearch` defaults to `undefined` in `OrchestratorConfig`; when absent, `tryOpenNewPosition()` falls through to the original `tryMomentumDirect()` call unconditionally (see `apps/bot/src/orchestrator/orchestrator.ts` diff) | PASS |

## 5. Known limitation carried over from this ticket's pre-existing partial work

The `momentumEntryTimingResearch.ts` module and its orchestrator wiring, plus the 8 challenger
scenario replays (`ticket159-overextension_guard-*` / `ticket159-breakout_pullback_continuation-*`),
were already present in the working tree before this pass (an interrupted prior attempt at this same
ticket). Those 8 scenario summaries were spot-checked for internal consistency (cost-table match,
config-hash presence, monotonic cost ordering FEE_ONLY >= LIGHT >= CENTRAL >= CONSERVATIVE net PnL)
and found consistent; they were not re-run from scratch in this pass because the outcome (both
challengers fail the coverage/PF/net-PnL gates in every scenario, by a wide margin) is unambiguous
and re-running would not change the decision. The genuinely new work in this pass is the Step 1
timing dataset, Step 2 failure classification, and this parity/leakage documentation, which the
pre-existing consolidation script had explicitly left incomplete (see its own `evidenceQuality: 'DQ-C
... because excursion callback was not persisted'` note in the prior `ticket159-run-manifest.json`).
