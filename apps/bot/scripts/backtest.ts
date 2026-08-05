/**
 * TICKET-010 Phần C+D — runs the Orchestrator sequentially over real OHLCV (all 4 symbols, one
 * shared accountBalance), producing data/backtest-report-{suffix}.md + data/backtest-trades-{suffix}.csv
 * (TICKET-017 Phần C: suffix auto-derived from --macro-trend-filter/--ob-disabled-symbols so the
 * 4 A/B combinations never overwrite each other — baseline/macrofilter/obfilter/both).
 * Run from repo root: `npm run backtest -- --entry-style=SIDEWAY_STYLE --tp-plan=PLAN_A --macro-trend-filter=true --ob-disabled-symbols=XRPUSDT`
 * (requires `npm run build` + `npm run fetch-ohlcv -- --days=180` first, including 1m/1d).
 *
 * No look-ahead: at each 5m step, every timeframe is sliced to only candles already CLOSED as of
 * that step's decision time (two-pointer, same alignment technique as calibrateThresholds.ts).
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { MarketRegime, type CandleData } from '../dist/regime/types.js';
import { RegimeConfig } from '../dist/regime/config.js';
import { computeCorrelatedRiskRatio } from '../dist/regime/correlatedRisk.js';
import {
  processCandle,
  type DangerZoneDiagnostic,
  type ManipulatedDiagnostic,
  type ProcessCandleInput,
  type SetupNotFiredDiagnostic,
} from '../dist/orchestrator/orchestrator.js';
import { INITIAL_SYMBOL_STATE, type CloseTradeEvent, type OrchestratorConfig, type SymbolState } from '../dist/orchestrator/types.js';
import { DEFAULT_ENTRY_ROUTER_CONFIG } from '../dist/entry/entryRouter.js';
import type { EntryStyleForNeutral, FunnelEvent } from '../dist/entry/types.js';
import {
  DEFAULT_MOMENTUM_FILTER_CONFIG,
  DEFAULT_NEUTRAL_TRANSITION_GATE_CONFIG,
  DEFAULT_PLAN_AUTO_SELECTION_CONFIG,
  MOMENTUM_MODEL_PATH,
  MOMENTUM_BEARISH_MODEL_PATH,
} from '../dist/xgbFilter/config.js';
import type { OpenPositionRisk } from '../dist/risk/riskPool.js';
import type { TpPlan } from '../dist/risk/slTpManager.js';
import { emptyFunnelStats, fmtInt, funnelReportMarkdown, pct, STATE_PASS_REGIMES, type RegimeFunnelStats } from './entryFunnelReport.js';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'];
const OHLCV_DIR = path.resolve(process.cwd(), 'data/ohlcv');
const MODELS_DIR = path.resolve(process.cwd(), 'models');

// Bounded sliding windows — enough for every metric's own lookback (ATR_PCT_LOOKBACK_5M=300 etc.),
// but NOT the full growing history. detectRegime()/routeEntry() always recompute their indicator
// series from whatever candles they're given; feeding the full 17k+-candle history at every one
// of ~17k steps would be O(n^2) and impractically slow. A live bot would only keep a bounded
// recent window in memory anyway, so this also matches how the Orchestrator would run live.
const WINDOW_5M = 320;
const WINDOW_15M = 325;
const WINDOW_1H = 40;
const WINDOW_1M = 200;
const WINDOW_1D = 40; // >> EntryConfig.MACRO_TREND_ADX_PERIOD_1D(14), matches WINDOW_1H's margin
// TICKET-024: separate, much larger 1h window for the momentum model's emaRatioSlow (EMA 50/200) —
// intentionally NOT used for regime/entry (see ProcessCandleInput.candles1hMomentum doc comment for why).
// TICKET-106 (TODO_CONFIRM): was 250 — TICKET-104 proved emaSeries()'s SMA-seeded EMA(200) is still
// ~61% seed-weighted at 250 candles (only 50 candles of decay past the period-200 seed), making
// emaRatioSlow/momentumScore sensitive to exactly which candles land in the window. Empirically
// converges by ~400; bumped to 500 for margin. MUST stay identical to liveRunner.ts's WINDOW_1H_MOMENTUM
// — the live-vs-offline window-boundary mismatch this masked is exactly TICKET-104's root cause.
const WINDOW_1H_MOMENTUM = 500;
// TICKET-028: separate, much larger 5m window for LOW_LIQUIDITY's session-relative volume ratio —
// RegimeConfig.LOW_LIQUIDITY_SESSION_LOOKBACK_DAYS(14) * 288 candles/day + 1 for the current candle
// itself. Intentionally NOT used for regime/entry's own ATR/ADX (see ProcessCandleInput.candles5mSessionVolume doc comment for why).
const WINDOW_5M_SESSION_VOLUME = 14 * 288 + 1;

function parseArgs(): {
  entryStyleForNeutral: EntryStyleForNeutral;
  tpPlan: TpPlan;
  macroTrendFilterEnabled: boolean;
  obDisabledSymbols: string[];
  macroTrendFilterAppliesToBoxBreakout: boolean;
  momentumFilterEnabled: boolean;
  neutralTransitionEnabled: boolean;
  riskPoolMaxPct: number;
  neutralGateThreshold: number;
  mssStalenessTolerance: number;
  obBosLookback: number;
  /** TICKET-089: CLI-overridable OB-only SL buffer multiplier (EntryRouterConfig.obSlBufferAtrMultiplier)
   * — FVG/Sweep are unaffected (still use EntryConfig.SL_BUFFER_ATR_MULTIPLIER directly). Default
   * matches EntryConfig.SL_BUFFER_ATR_MULTIPLIER_OB (0.1) unchanged unless CLI overrides. */
  obSlBufferAtrMultiplier: number;
  planAutoSelectionEnabled: boolean;
  planAutoSelectionThreshold: number;
  maxConcurrentPositionsPerSymbol: number;
  momentumDirectEnabled: boolean;
  momentumDirectThreshold: number;
  momentumDirectMaxAtrPercentile: number;
  momentumDirectMinSlPercent: number;
  momentumDirectTpRMultiple: number;
  momentumDirectMaxTotalConcurrent: number;
  momentumDirectCorrelationRiskThreshold: number;
  momentumDirectCorrelationRiskMultiplier: number;
  momentumDirectCircuitBreakerLossThreshold: number;
  momentumDirectCircuitBreakerCooldownMs: number;
  /** CLI-overridable fixed risk$/lệnh (OrchestratorConfig.riskDollarOrPercent) — added to verify the
   * official baseline config against real $100 capital (risk$5) without touching the default $20/$400
   * combo the official 8-flag command relies on. Default 20 unchanged. */
  riskDollarOrPercent: number;
  /** CLI-overridable backtest starting balance, same purpose as riskDollarOrPercent above. Default
   * 400 unchanged (docs/vicion-bot-quan-ly-vi-the-v1.md Mục 1). */
  startBalance: number;
  /** TICKET-087 — CLI-overridable calendar-date trading window, same warm-up-then-trade mechanism as
   * skipDays (TICKET-061) but pinned to an absolute date instead of a day-count from the dataset's
   * start. Indicator history BEFORE dateFrom is still fed through detectRegime()/etc as normal (same
   * warm-up every backtest run already needs) — only entry/position tracking is bounded to
   * [dateFrom, dateTo]. Undefined (omitted) = unbounded, unchanged from every ticket before this one. */
  dateFrom?: string;
  dateTo?: string;
  /** CLI-overridable margin cap (OrchestratorConfig.maxMarginCap), same purpose as riskDollarOrPercent
   * above — must scale down proportionally with riskDollarOrPercent/startBalance for the real-capital
   * verification, or it stops binding at the same relative rate. Default 50 unchanged. */
  maxMarginCap: number;
  /** TICKET-061: diagnostic-only — skip this many calendar days at the start of the run (on top of
   * the existing warm-up startStep), so metrics needing longer history (e.g. macroDirection's 1D
   * ADX, TICKET-017) are already defined for every step. Default 0 — unchanged from every ticket
   * before this one unless the CLI explicitly opts in. */
  skipDays: number;
  /**
   * TICKET-098 — CLI-overridable momentum model version, 'v1' (production, default, unchanged
   * behavior) or 'v3' (TICKET-097's experimental model: same % label, +correlatedRiskRatio
   * +distanceToNearestSwingAtr features). Never wired anywhere else — only backtest.ts's own A/B
   * comparison, orchestrator.ts stays oblivious to "versions" (just reads whatever
   * OrchestratorConfig.momentumModelPath/etc points to, defaulting to xgbFilter/config.ts's v1
   * paths when omitted).
   */
  momentumModelVersion: 'v1' | 'v3';
  /**
   * TICKET-123 Variant C/D — CLI flag `--model-mode=` (or env var MODEL_MODE), 'V1' (default,
   * production behavior byte-identical to every ticket before this one) or 'V7_RAW' (TICKET-118's
   * Cách B bullish/bearish RAW — uncalibrated — ONNX exports, models/xgb_momentum_{bullish,bearish}_v7_raw.onnx).
   * Independent of momentumModelVersion above (that flag is TICKET-098's v1/v3 A/B test); kept as a
   * separate flag/field so V7_RAW composes cleanly with the OOD guard (Variant D) without touching
   * the v3 experimental path. No silent fallback: if V7_RAW is requested, orchestrator.ts's existing
   * getSchemaCached()/scoreMomentum() ONNX-session loading already throws (fs.readFileSync/
   * onnxruntime-node both throw on a missing/invalid file) rather than falling back to V1 — this
   * flag only ever POINTS at the V7_RAW files, it never wraps that load in a try/catch.
   */
  modelMode: 'V1' | 'V7_RAW';
  /**
   * TICKET-101 Việc 2 — TODO_CONFIRM (PM gợi ý 50-60%, chưa chốt số): trần TỔNG MARGIN thật đang mở
   * cùng lúc trên cả 4 coin gộp lại, dạng phần trăm THUẦN (VD 50, không phải 0.5) — chia cho 100 ở
   * đây rồi truyền tiếp dạng phân số vào OrchestratorConfig.maxTotalMarginPct, cùng convention
   * riskPoolMaxPct. undefined (mặc định, không truyền cờ) = không giới hạn, khớp mọi ticket trước.
   */
  maxTotalMarginPct?: number;
  /**
   * TICKET-122 — opt-in, default-inert OOD guard CLI flags for the Bearish (SHORT) MOMENTUM_DIRECT
   * model. `NONE` (default, or the flag omitted entirely) means OrchestratorConfig.oodGuardConfig
   * stays undefined — fully inert, byte-identical to every ticket before this one.
   */
  oodGuardMode: 'NONE' | 'HARD_REJECT' | 'SCORE_CAP' | 'RISK_REDUCTION';
  /** emaRatioSlow OOD threshold (P90/P95/P97.5 of the Bearish TRAIN split, precomputed offline — never recomputed here) — only meaningful when oodGuardMode !== 'NONE'. */
  oodGuardEmaRatioSlowThreshold: number;
  /** SCORE_CAP only. */
  oodGuardScoreCap: number;
  /** RISK_REDUCTION only. */
  oodGuardRiskReductionMultiplier: number;
  /**
   * TICKET-130 — opt-in, default-inert Neutral 5m Direction Selector CLI flag. `false` (default, or
   * the flag omitted entirely) means OrchestratorConfig.neutral5mDirectionSelectorEnabled stays
   * undefined/false — fully inert, byte-identical to every ticket before this one.
   */
  neutral5mDirectionSelectorEnabled: boolean;
  /**
   * TICKET-131 — opt-in, default-inert Neutral 5m Direction-Gated Setup Routing CLI flag. `false`
   * (default, or the flag omitted entirely) means OrchestratorConfig.neutral5mDirectionGatedRoutingEnabled
   * stays undefined/false — fully inert, byte-identical to every ticket before this one.
   */
  neutral5mDirectionGatedRoutingEnabled: boolean;
  /**
   * TICKET-138 — opt-in, default-inert Neutral 5m Conditional Override for HTF (1D macro) conflict CLI
   * flag. `'NONE'` (default, or the flag omitted entirely) means
   * OrchestratorConfig.neutralMacroConflictOverrideMode stays undefined/'NONE' — fully inert,
   * byte-identical to every ticket before this one.
   */
  neutralMacroConflictOverrideMode: 'NONE' | 'UNFILTERED' | 'CONDITIONAL_5M';
} {
  const args = process.argv.slice(2);
  const styleArg = args.find((a) => a.startsWith('--entry-style='));
  const planArg = args.find((a) => a.startsWith('--tp-plan='));
  const macroArg = args.find((a) => a.startsWith('--macro-trend-filter='));
  const obArg = args.find((a) => a.startsWith('--ob-disabled-symbols='));
  const macroBoxArg = args.find((a) => a.startsWith('--macro-trend-box-breakout='));
  const momentumArg = args.find((a) => a.startsWith('--momentum-filter='));
  const neutralArg = args.find((a) => a.startsWith('--neutral-transition-enabled='));
  const riskPoolArg = args.find((a) => a.startsWith('--risk-pool-max-pct='));
  const neutralGateArg = args.find((a) => a.startsWith('--neutral-gate-threshold='));
  const mssStalenessArg = args.find((a) => a.startsWith('--mss-staleness-tolerance='));
  const obBosLookbackArg = args.find((a) => a.startsWith('--ob-bos-lookback='));
  const obSlBufferAtrMultiplierArg = args.find((a) => a.startsWith('--ob-sl-buffer-atr-multiplier='));
  const planAutoSelectionArg = args.find((a) => a.startsWith('--plan-auto-selection-enabled='));
  const planAutoSelectionThresholdArg = args.find((a) => a.startsWith('--plan-auto-selection-threshold='));
  const maxConcurrentPositionsArg = args.find((a) => a.startsWith('--max-concurrent-positions-per-symbol='));
  const momentumDirectEnabledArg = args.find((a) => a.startsWith('--momentum-direct-enabled='));
  const momentumDirectThresholdArg = args.find((a) => a.startsWith('--momentum-direct-threshold='));
  const momentumDirectMaxAtrPercentileArg = args.find((a) => a.startsWith('--momentum-direct-max-atr-percentile='));
  const momentumDirectMinSlPercentArg = args.find((a) => a.startsWith('--momentum-direct-min-sl-percent='));
  const momentumDirectTpRMultipleArg = args.find((a) => a.startsWith('--momentum-direct-tp-r-multiple='));
  const momentumDirectMaxTotalConcurrentArg = args.find((a) => a.startsWith('--momentum-direct-max-total-concurrent='));
  const momentumDirectCorrelationRiskThresholdArg = args.find((a) => a.startsWith('--momentum-direct-correlation-risk-threshold='));
  const momentumDirectCorrelationRiskMultiplierArg = args.find((a) => a.startsWith('--momentum-direct-correlation-risk-multiplier='));
  const momentumDirectCircuitBreakerLossThresholdArg = args.find((a) => a.startsWith('--momentum-direct-circuit-breaker-loss-threshold='));
  const momentumDirectCircuitBreakerCooldownMsArg = args.find((a) => a.startsWith('--momentum-direct-circuit-breaker-cooldown-ms='));
  const riskDollarOrPercentArg = args.find((a) => a.startsWith('--risk-dollar-or-percent='));
  const startBalanceArg = args.find((a) => a.startsWith('--start-balance='));
  const dateFromArg = args.find((a) => a.startsWith('--date-from='));
  const dateToArg = args.find((a) => a.startsWith('--date-to='));
  const maxMarginCapArg = args.find((a) => a.startsWith('--max-margin-cap='));
  const skipDaysArg = args.find((a) => a.startsWith('--skip-days='));
  const momentumModelVersionArg = args.find((a) => a.startsWith('--momentum-model-version='));
  const modelModeArg = args.find((a) => a.startsWith('--model-mode='));
  const maxTotalMarginPctArg = args.find((a) => a.startsWith('--max-total-margin-pct='));
  const oodGuardModeArg = args.find((a) => a.startsWith('--ood-guard-mode='));
  const oodGuardEmaRatioSlowThresholdArg = args.find((a) => a.startsWith('--ood-guard-ema-ratio-slow-threshold='));
  const oodGuardScoreCapArg = args.find((a) => a.startsWith('--ood-guard-score-cap='));
  const oodGuardRiskReductionMultiplierArg = args.find((a) => a.startsWith('--ood-guard-risk-reduction-multiplier='));
  const neutral5mDirectionSelectorEnabledArg = args.find((a) => a.startsWith('--neutral-5m-direction-selector-enabled='));
  const neutral5mDirectionGatedRoutingEnabledArg = args.find((a) => a.startsWith('--neutral-5m-direction-gated-routing-enabled='));
  const neutralMacroConflictOverrideModeArg = args.find((a) => a.startsWith('--neutral-macro-conflict-override-mode='));
  const obValue = obArg ? obArg.split('=')[1] : '';
  return {
    entryStyleForNeutral: (styleArg ? styleArg.split('=')[1] : 'SIDEWAY_STYLE') as EntryStyleForNeutral,
    tpPlan: (planArg ? planArg.split('=')[1] : 'PLAN_A') as TpPlan,
    macroTrendFilterEnabled: macroArg ? macroArg.split('=')[1] === 'true' : false,
    obDisabledSymbols: obValue.trim() === '' ? [] : obValue.split(','),
    macroTrendFilterAppliesToBoxBreakout: macroBoxArg ? macroBoxArg.split('=')[1] === 'true' : false,
    momentumFilterEnabled: momentumArg ? momentumArg.split('=')[1] === 'true' : false,
    // TICKET-036: off by default — matches DEFAULT_NEUTRAL_TRANSITION_GATE_CONFIG.
    neutralTransitionEnabled: neutralArg ? neutralArg.split('=')[1] === 'true' : false,
    // TICKET-037: takes a plain percentage number (e.g. 10, 15), not a fraction — divided by 100
    // below. Defaults to 10 unchanged (matches risk/riskPool.ts's DEFAULT_RISK_POOL_CONFIG) when omitted.
    riskPoolMaxPct: (riskPoolArg ? Number(riskPoolArg.split('=')[1]) : 10) / 100,
    // TICKET-039: defaults to 0.55 unchanged (matches DEFAULT_NEUTRAL_TRANSITION_GATE_CONFIG) when omitted.
    neutralGateThreshold: neutralGateArg ? Number(neutralGateArg.split('=')[1]) : 0.55,
    // TICKET-040: defaults to 5 unchanged (matches EntryConfig.MSS_STALENESS_TOLERANCE_CANDLES) when omitted.
    mssStalenessTolerance: mssStalenessArg ? Number(mssStalenessArg.split('=')[1]) : 5,
    // TICKET-041: defaults to 10 unchanged (matches EntryConfig.OB_BOS_LOOKFORWARD_K) when omitted.
    obBosLookback: obBosLookbackArg ? Number(obBosLookbackArg.split('=')[1]) : 10,
    // TICKET-089: defaults to 0.1 unchanged (matches EntryConfig.SL_BUFFER_ATR_MULTIPLIER_OB) when omitted.
    obSlBufferAtrMultiplier: obSlBufferAtrMultiplierArg ? Number(obSlBufferAtrMultiplierArg.split('=')[1]) : 0.1,
    // TICKET-052: off by default — matches DEFAULT_PLAN_AUTO_SELECTION_CONFIG.
    planAutoSelectionEnabled: planAutoSelectionArg ? planAutoSelectionArg.split('=')[1] === 'true' : false,
    // TICKET-052: defaults to 0.7 unchanged (matches DEFAULT_PLAN_AUTO_SELECTION_CONFIG, TODO_CONFIRM) when omitted.
    planAutoSelectionThreshold: planAutoSelectionThresholdArg ? Number(planAutoSelectionThresholdArg.split('=')[1]) : 0.7,
    // TICKET-056: defaults to 1 unchanged (matches every ticket before this one — a symbol could
    // never hold more than 1 open position) — only the CLI may override, per PM's explicit instruction.
    maxConcurrentPositionsPerSymbol: maxConcurrentPositionsArg ? Number(maxConcurrentPositionsArg.split('=')[1]) : 1,
    // TICKET-059: off by default — matches OrchestratorConfig.momentumDirectEnabled's default.
    momentumDirectEnabled: momentumDirectEnabledArg ? momentumDirectEnabledArg.split('=')[1] === 'true' : false,
    // TICKET-059: TODO_CONFIRM, PM suggested 0.75 — default unchanged unless CLI overrides.
    momentumDirectThreshold: momentumDirectThresholdArg ? Number(momentumDirectThresholdArg.split('=')[1]) : 0.75,
    // TICKET-062: TODO_CONFIRM, PM suggested 80 — default 100 (no real-world cap) unchanged unless CLI overrides.
    momentumDirectMaxAtrPercentile: momentumDirectMaxAtrPercentileArg ? Number(momentumDirectMaxAtrPercentileArg.split('=')[1]) : 100,
    // TICKET-064: TODO_CONFIRM, PM suggested 0.5 (%) / 2.0 — defaults unchanged unless CLI overrides.
    momentumDirectMinSlPercent: momentumDirectMinSlPercentArg ? Number(momentumDirectMinSlPercentArg.split('=')[1]) : 0.5,
    momentumDirectTpRMultiple: momentumDirectTpRMultipleArg ? Number(momentumDirectTpRMultipleArg.split('=')[1]) : 2.0,
    // TICKET-068: TODO_CONFIRM, PM suggested 2 — default 999 (no real-world cap) unchanged unless CLI overrides.
    momentumDirectMaxTotalConcurrent: momentumDirectMaxTotalConcurrentArg ? Number(momentumDirectMaxTotalConcurrentArg.split('=')[1]) : 999,
    // TICKET-071 (renamed from TICKET-070's block threshold, same value): TODO_CONFIRM, PM suggested
    // 0.90 — default 999 (trigger never fires) unchanged unless CLI overrides.
    momentumDirectCorrelationRiskThreshold: momentumDirectCorrelationRiskThresholdArg ? Number(momentumDirectCorrelationRiskThresholdArg.split('=')[1]) : 999,
    // TICKET-071: TODO_CONFIRM, PM suggested 0.5 — default 1.0 (no size change) unchanged unless CLI overrides.
    momentumDirectCorrelationRiskMultiplier: momentumDirectCorrelationRiskMultiplierArg ? Number(momentumDirectCorrelationRiskMultiplierArg.split('=')[1]) : 1.0,
    // TICKET-081: TODO_CONFIRM, PM suggested 3 — default 999999 (never triggers) unchanged unless CLI overrides.
    momentumDirectCircuitBreakerLossThreshold: momentumDirectCircuitBreakerLossThresholdArg
      ? Number(momentumDirectCircuitBreakerLossThresholdArg.split('=')[1])
      : 999999,
    // TICKET-081: TODO_CONFIRM, PM suggested 7_200_000 (2h) — default 0 unchanged unless CLI overrides
    // (never reached in practice since the loss threshold above already blocks activation by default).
    momentumDirectCircuitBreakerCooldownMs: momentumDirectCircuitBreakerCooldownMsArg
      ? Number(momentumDirectCircuitBreakerCooldownMsArg.split('=')[1])
      : 0,
    // Default 20 unchanged unless CLI overrides — matches every ticket before this one exactly.
    riskDollarOrPercent: riskDollarOrPercentArg ? Number(riskDollarOrPercentArg.split('=')[1]) : 20,
    // Default 400 unchanged unless CLI overrides — matches every ticket before this one exactly.
    startBalance: startBalanceArg ? Number(startBalanceArg.split('=')[1]) : 400,
    // Default 50 unchanged unless CLI overrides — matches every ticket before this one exactly.
    maxMarginCap: maxMarginCapArg ? Number(maxMarginCapArg.split('=')[1]) : 50,
    // TICKET-087: undefined unless CLI overrides — matches every ticket before this one exactly.
    dateFrom: dateFromArg ? dateFromArg.split('=')[1] : undefined,
    dateTo: dateToArg ? dateToArg.split('=')[1] : undefined,
    // TICKET-061: default 0 unchanged from before this ticket.
    skipDays: skipDaysArg ? Number(skipDaysArg.split('=')[1]) : 0,
    // TICKET-098: default 'v1' unchanged unless CLI overrides — matches every ticket before this one exactly.
    momentumModelVersion: (momentumModelVersionArg ? momentumModelVersionArg.split('=')[1] : 'v1') as 'v1' | 'v3',
    // TICKET-123: CLI flag wins over env var wins over default 'V1'. Validated below — any other
    // string throws immediately (fail loud, never silently treated as 'V1').
    modelMode: ((): 'V1' | 'V7_RAW' => {
      const raw = modelModeArg ? modelModeArg.split('=')[1] : (process.env.MODEL_MODE ?? 'V1');
      if (raw !== 'V1' && raw !== 'V7_RAW') {
        throw new Error(`--model-mode/MODEL_MODE phải là 'V1' hoặc 'V7_RAW', nhận được: "${raw}"`);
      }
      return raw;
    })(),
    // TICKET-101 Việc 2: undefined (no cap) unless CLI overrides — matches every ticket before this one exactly.
    maxTotalMarginPct: maxTotalMarginPctArg ? Number(maxTotalMarginPctArg.split('=')[1]) / 100 : undefined,
    // TICKET-122: default 'NONE' unchanged unless CLI overrides — OrchestratorConfig.oodGuardConfig
    // stays undefined below, matching every ticket before this one exactly.
    oodGuardMode: (oodGuardModeArg ? oodGuardModeArg.split('=')[1] : 'NONE') as 'NONE' | 'HARD_REJECT' | 'SCORE_CAP' | 'RISK_REDUCTION',
    oodGuardEmaRatioSlowThreshold: oodGuardEmaRatioSlowThresholdArg ? Number(oodGuardEmaRatioSlowThresholdArg.split('=')[1]) : 0,
    oodGuardScoreCap: oodGuardScoreCapArg ? Number(oodGuardScoreCapArg.split('=')[1]) : 0,
    oodGuardRiskReductionMultiplier: oodGuardRiskReductionMultiplierArg ? Number(oodGuardRiskReductionMultiplierArg.split('=')[1]) : 1.0,
    // TICKET-130: off by default — matches OrchestratorConfig.neutral5mDirectionSelectorEnabled's default.
    neutral5mDirectionSelectorEnabled: neutral5mDirectionSelectorEnabledArg ? neutral5mDirectionSelectorEnabledArg.split('=')[1] === 'true' : false,
    // TICKET-131: off by default — matches OrchestratorConfig.neutral5mDirectionGatedRoutingEnabled's default.
    neutral5mDirectionGatedRoutingEnabled: neutral5mDirectionGatedRoutingEnabledArg ? neutral5mDirectionGatedRoutingEnabledArg.split('=')[1] === 'true' : false,
    // TICKET-138: 'NONE' by default — matches OrchestratorConfig.neutralMacroConflictOverrideMode's default.
    neutralMacroConflictOverrideMode: (neutralMacroConflictOverrideModeArg ? neutralMacroConflictOverrideModeArg.split('=')[1] : 'NONE') as
      | 'NONE'
      | 'UNFILTERED'
      | 'CONDITIONAL_5M',
  };
}

/** TICKET-017/018/024/036/052 Phần C: output filenames auto-derived from which filters are active, so the A/B combinations never overwrite each other. */
function outputSuffix(
  macroTrendFilterEnabled: boolean,
  obDisabledSymbols: string[],
  macroTrendFilterAppliesToBoxBreakout: boolean,
  momentumFilterEnabled: boolean,
  neutralTransitionEnabled: boolean,
  planAutoSelectionEnabled: boolean,
  maxConcurrentPositionsPerSymbol: number,
  momentumDirectEnabled: boolean,
): string {
  const macro = macroTrendFilterEnabled;
  const ob = obDisabledSymbols.length > 0;
  let base: string;
  if (macro && ob) base = 'both';
  else if (macro) base = 'macrofilter';
  else if (ob) base = 'obfilter';
  else base = 'baseline';
  if (macroTrendFilterAppliesToBoxBreakout) base += '-with-boxfilter';
  if (momentumFilterEnabled) base += '-momentum';
  if (neutralTransitionEnabled) base += '-neutral';
  if (planAutoSelectionEnabled) base += '-planauto';
  // TICKET-056: default (1) unchanged from before this ticket — only append when CLI overrides it.
  if (maxConcurrentPositionsPerSymbol !== 1) base += `-maxpos${maxConcurrentPositionsPerSymbol}`;
  if (momentumDirectEnabled) base += '-momentumdirect';
  return base;
}

function readCsv(filePath: string): CandleData[] {
  const lines = readFileSync(filePath, 'utf-8').trim().split('\n');
  return lines.slice(1).map((line) => {
    const [timestampUtc, , open, high, low, close, volume] = line.split(',');
    return {
      timestamp: Number(timestampUtc),
      open: Number(open),
      high: Number(high),
      low: Number(low),
      close: Number(close),
      volume: Number(volume),
    };
  });
}

interface SymbolData {
  candles5m: CandleData[];
  candles15m: CandleData[];
  candles1h: CandleData[];
  candles1m: CandleData[];
  candles1d: CandleData[];
  ptr15m: number;
  ptr1h: number;
  ptr1m: number;
  ptr1d: number;
  state: SymbolState;
}

/** Two-pointer: advances `ptr` to the latest candle already CLOSED (open+interval <= decisionTime), never looks ahead. */
function closedWindow(candles: CandleData[], ptr: number, intervalMs: number, decisionTime: number, windowSize: number): { window: CandleData[]; ptr: number } {
  let p = ptr;
  while (p + 1 < candles.length && candles[p + 1].timestamp + intervalMs <= decisionTime) p++;
  if (p < 0) return { window: [], ptr: p };
  const start = Math.max(0, p - windowSize + 1);
  return { window: candles.slice(start, p + 1), ptr: p };
}

function loadSymbolData(symbol: string): SymbolData {
  return {
    candles5m: readCsv(path.join(OHLCV_DIR, `${symbol}_5m.csv`)),
    candles15m: readCsv(path.join(OHLCV_DIR, `${symbol}_15m.csv`)),
    candles1h: readCsv(path.join(OHLCV_DIR, `${symbol}_1h.csv`)),
    candles1m: readCsv(path.join(OHLCV_DIR, `${symbol}_1m.csv`)),
    candles1d: readCsv(path.join(OHLCV_DIR, `${symbol}_1d.csv`)),
    ptr15m: -1,
    ptr1h: -1,
    ptr1m: -1,
    ptr1d: -1,
    state: INITIAL_SYMBOL_STATE,
  };
}

interface GroupStats {
  count: number;
  wins: number;
  pnl: number;
}

function groupBy(trades: CloseTradeEvent[], keyFn: (t: CloseTradeEvent) => string): Record<string, GroupStats> {
  const result: Record<string, GroupStats> = {};
  for (const t of trades) {
    const key = keyFn(t);
    if (!result[key]) result[key] = { count: 0, wins: 0, pnl: 0 };
    result[key].count++;
    result[key].pnl += t.pnlUsd;
    if (t.pnlUsd > 0) result[key].wins++;
  }
  return result;
}

function statsTable(title: string, stats: Record<string, GroupStats>, sortChronological = false): string {
  const entries = Object.entries(stats).sort((a, b) => (sortChronological ? a[0].localeCompare(b[0]) : b[1].pnl - a[1].pnl));
  const rows = entries.map(
    ([key, s]) => `| ${key} | ${s.count} | ${((s.wins / s.count) * 100).toFixed(1)}% | ${s.pnl >= 0 ? '+' : ''}${s.pnl.toFixed(2)} |`,
  );
  return [`### ${title}`, '', '| | Số lệnh | Winrate | PNL ($) |', '|---|---|---|---|', ...rows, ''].join('\n');
}

// TICKET-027 — diagnostic log only, separate file from backtest-report/trades. Formats one entry per
// fresh MANIPULATED confirmation (see orchestrator.ts's onManipulatedConfirmed callback).
function formatManipulatedDiagnostic(d: ManipulatedDiagnostic): string {
  const candleLines = d.lookbackWindow.map(
    (c) => `    ${new Date(c.timestamp).toISOString()} open=${c.open} high=${c.high} low=${c.low} close=${c.close} volume=${c.volume}`,
  );
  return [
    `[MANIPULATED] symbol=${d.symbol} timestamp=${new Date(d.timestamp).toISOString()} upperSweepCount=${d.upperSweepCount} lowerSweepCount=${d.lowerSweepCount} volumeZScore5m=${d.volumeZScore5m}`,
    `  lookbackWindow (${d.lookbackWindow.length} nến gần nhất):`,
    ...candleLines,
  ].join('\n');
}

// TICKET-033 — diagnostic log only, separate file from backtest-report/trades. Formats one entry per
// fresh DANGER_ZONE confirmation (see orchestrator.ts's onDangerZoneConfirmed callback). Same pattern as TICKET-027.
function formatDangerZoneDiagnostic(d: DangerZoneDiagnostic): string {
  return `[DANGER_ZONE] symbol=${d.symbol} timestamp=${new Date(d.timestamp).toISOString()} atrPercentile5m=${d.atrPercentile5m}\n  volumeZScore5m=${d.volumeZScore5m}`;
}

function tradesCsv(trades: CloseTradeEvent[]): string {
  const header = 'symbol,side,regime,setupType,tpPlan,entryTimestamp,entryPrice,exitTimestamp,exitPrice,exitReason,pnlUsd,pnlPct,riskMultiplierApplied,accountBalanceAfter';
  const rows = trades.map((t) =>
    [t.symbol, t.side, t.regime, t.setupType, t.tpPlan, t.entryTimestamp, t.entryPrice, t.exitTimestamp, t.exitPrice, t.exitReason, t.pnlUsd, t.pnlPct, t.riskMultiplier, t.accountBalanceAfter].join(','),
  );
  return [header, ...rows].join('\n') + '\n';
}

async function main(): Promise<void> {
  const {
    entryStyleForNeutral,
    tpPlan,
    macroTrendFilterEnabled,
    obDisabledSymbols,
    macroTrendFilterAppliesToBoxBreakout,
    momentumFilterEnabled,
    neutralTransitionEnabled,
    riskPoolMaxPct,
    neutralGateThreshold,
    mssStalenessTolerance,
    obBosLookback,
    obSlBufferAtrMultiplier,
    planAutoSelectionEnabled,
    planAutoSelectionThreshold,
    maxConcurrentPositionsPerSymbol,
    momentumDirectEnabled,
    momentumDirectThreshold,
    momentumDirectMaxAtrPercentile,
    momentumDirectMinSlPercent,
    momentumDirectTpRMultiple,
    momentumDirectMaxTotalConcurrent,
    momentumDirectCorrelationRiskThreshold,
    momentumDirectCorrelationRiskMultiplier,
    momentumDirectCircuitBreakerLossThreshold,
    momentumDirectCircuitBreakerCooldownMs,
    riskDollarOrPercent,
    startBalance,
    maxMarginCap,
    dateFrom,
    dateTo,
    skipDays,
    momentumModelVersion,
    modelMode,
    maxTotalMarginPct,
    oodGuardMode,
    oodGuardEmaRatioSlowThreshold,
    oodGuardScoreCap,
    oodGuardRiskReductionMultiplier,
    neutral5mDirectionSelectorEnabled,
    neutral5mDirectionGatedRoutingEnabled,
    neutralMacroConflictOverrideMode,
  } = parseArgs();
  console.log(
    `Backtest — entryStyleForNeutral=${entryStyleForNeutral}, tpPlan=${tpPlan}, macroTrendFilterEnabled=${macroTrendFilterEnabled}, obDisabledSymbols=[${obDisabledSymbols.join(',')}], macroTrendFilterAppliesToBoxBreakout=${macroTrendFilterAppliesToBoxBreakout}, momentumFilterEnabled=${momentumFilterEnabled}, neutralTransitionEnabled=${neutralTransitionEnabled}, riskPoolMaxPct=${riskPoolMaxPct}, neutralGateThreshold=${neutralGateThreshold}, mssStalenessTolerance=${mssStalenessTolerance}, obBosLookback=${obBosLookback}, obSlBufferAtrMultiplier=${obSlBufferAtrMultiplier}, planAutoSelectionEnabled=${planAutoSelectionEnabled}, planAutoSelectionThreshold=${planAutoSelectionThreshold}, maxConcurrentPositionsPerSymbol=${maxConcurrentPositionsPerSymbol}, momentumDirectEnabled=${momentumDirectEnabled}, momentumDirectThreshold=${momentumDirectThreshold}, momentumDirectMaxAtrPercentile=${momentumDirectMaxAtrPercentile}, momentumDirectMinSlPercent=${momentumDirectMinSlPercent}, momentumDirectTpRMultiple=${momentumDirectTpRMultiple}, momentumDirectMaxTotalConcurrent=${momentumDirectMaxTotalConcurrent}, momentumDirectCorrelationRiskThreshold=${momentumDirectCorrelationRiskThreshold}, momentumDirectCorrelationRiskMultiplier=${momentumDirectCorrelationRiskMultiplier}, momentumDirectCircuitBreakerLossThreshold=${momentumDirectCircuitBreakerLossThreshold}, momentumDirectCircuitBreakerCooldownMs=${momentumDirectCircuitBreakerCooldownMs}, riskDollarOrPercent=${riskDollarOrPercent}, startBalance=${startBalance}, maxMarginCap=${maxMarginCap}, dateFrom=${dateFrom ?? '(không giới hạn)'}, dateTo=${dateTo ?? '(không giới hạn)'}, skipDays=${skipDays}, momentumModelVersion=${momentumModelVersion}, modelMode=${modelMode}, maxTotalMarginPct=${maxTotalMarginPct !== undefined ? `${(maxTotalMarginPct * 100).toFixed(1)}%` : '(không giới hạn)'}, oodGuardMode=${oodGuardMode}, oodGuardEmaRatioSlowThreshold=${oodGuardEmaRatioSlowThreshold}, oodGuardScoreCap=${oodGuardScoreCap}, oodGuardRiskReductionMultiplier=${oodGuardRiskReductionMultiplier}, neutral5mDirectionSelectorEnabled=${neutral5mDirectionSelectorEnabled}, neutral5mDirectionGatedRoutingEnabled=${neutral5mDirectionGatedRoutingEnabled}, neutralMacroConflictOverrideMode=${neutralMacroConflictOverrideMode}`,
  );
  console.log('Đọc CSV (5m/15m/1h/1m/1d x 4 coin)...');

  const symbolsData: Record<string, SymbolData> = {};
  for (const symbol of SYMBOLS) symbolsData[symbol] = loadSymbolData(symbol);

  const config: OrchestratorConfig = {
    entryRouterConfig: {
      ...DEFAULT_ENTRY_ROUTER_CONFIG,
      entryStyleForNeutral,
      macroTrendFilterEnabled,
      obDisabledSymbols,
      macroTrendFilterAppliesToBoxBreakout,
      mssStalenessToleranceCandles: mssStalenessTolerance, // TICKET-040: CLI-overridable A/B testing — default (5) unchanged from before this ticket.
      obBosLookforwardK: obBosLookback, // TICKET-041: CLI-overridable A/B testing — default (10) unchanged from before this ticket.
      obSlBufferAtrMultiplier, // TICKET-089: CLI-overridable A/B testing — default (0.1) unchanged from before this ticket, FVG/Sweep unaffected.
    },
    tpPlan,
    takerFeeRate: 0.0004, // TODO_CONFIRM per docs Mục 8 — Trader chưa cung cấp số thật theo VIP tier
    riskDollarOrPercent, // CLI-overridable — default (20) unchanged from before this ticket.
    maxMarginCap, // CLI-overridable — default (50) unchanged from before this ticket.
    leverage: 30,
    riskPoolMaxPct, // TICKET-037: CLI-overridable A/B testing — default (10 -> 0.1) unchanged from before this ticket.
    isLowConfidenceOrLowLiquidity: false,
    momentumFilterConfig: { ...DEFAULT_MOMENTUM_FILTER_CONFIG, momentumFilterEnabled },
    neutralTransitionGateConfig: {
      ...DEFAULT_NEUTRAL_TRANSITION_GATE_CONFIG,
      neutralTransitionTradingEnabled: neutralTransitionEnabled,
      neutralTransitionMomentumGateThreshold: neutralGateThreshold, // TICKET-039: CLI-overridable A/B testing — default (0.55) unchanged from before this ticket.
    },
    planAutoSelectionConfig: {
      ...DEFAULT_PLAN_AUTO_SELECTION_CONFIG,
      planAutoSelectionEnabled, // TICKET-052: CLI-overridable A/B testing — default (false) unchanged from before this ticket.
      planAutoSelectionMomentumThreshold: planAutoSelectionThreshold, // TICKET-052: TODO_CONFIRM, default 0.7 unchanged unless CLI overrides.
    },
    maxConcurrentPositionsPerSymbol, // TICKET-056: CLI-overridable A/B testing — default (1) unchanged from before this ticket.
    momentumDirectEnabled, // TICKET-059: CLI-overridable A/B testing — default (false) unchanged from before this ticket.
    momentumDirectThreshold, // TICKET-059: TODO_CONFIRM, default 0.75 unchanged unless CLI overrides.
    momentumDirectMaxAtrPercentile, // TICKET-062: TODO_CONFIRM, default 100 (no real-world cap) unchanged unless CLI overrides.
    momentumDirectMinSlPercent, // TICKET-064: TODO_CONFIRM, default 0.5 unless CLI overrides.
    momentumDirectTpRMultiple, // TICKET-064: TODO_CONFIRM, default 2.0 unless CLI overrides.
    momentumDirectMaxTotalConcurrent, // TICKET-068: TODO_CONFIRM, default 999 (no real-world cap) unchanged unless CLI overrides.
    momentumDirectCorrelationRiskThreshold, // TICKET-071: TODO_CONFIRM, default 999 (trigger never fires) unchanged unless CLI overrides.
    momentumDirectCorrelationRiskMultiplier, // TICKET-071: TODO_CONFIRM, default 1.0 (no size change) unchanged unless CLI overrides.
    momentumDirectCircuitBreakerLossThreshold, // TICKET-081: TODO_CONFIRM, default 999999 (never triggers) unchanged unless CLI overrides.
    momentumDirectCircuitBreakerCooldownMs, // TICKET-081: TODO_CONFIRM, default 0 unchanged unless CLI overrides.
    maxTotalMarginPct, // TICKET-101 Việc 2: TODO_CONFIRM, undefined (no cap) unless CLI overrides.
    // TICKET-122: undefined for oodGuardMode='NONE' (default) — orchestrator.ts's OOD guard code
    // stays fully inert, matching every ticket before this one exactly.
    ...(oodGuardMode !== 'NONE'
      ? {
          oodGuardConfig: {
            emaRatioSlowThreshold: oodGuardEmaRatioSlowThreshold,
            mode: oodGuardMode,
            scoreCapValue: oodGuardScoreCap,
            riskReductionMultiplier: oodGuardRiskReductionMultiplier,
          },
        }
      : {}),
    // TICKET-098: undefined for 'v1' (default) — orchestrator.ts falls back to xgbFilter/config.ts's
    // production v1 paths unchanged. 'v3' points at TICKET-097's experimental model files.
    ...(momentumModelVersion === 'v3'
      ? {
          momentumModelPath: path.join(MODELS_DIR, 'xgb_momentum_v3_bullish_experimental.onnx'),
          momentumSchemaPath: path.join(MODELS_DIR, 'xgb_momentum_v3_bullish_experimental_feature_schema.json'),
          momentumBearishModelPath: path.join(MODELS_DIR, 'xgb_momentum_v3_bearish_experimental.onnx'),
          momentumBearishSchemaPath: path.join(MODELS_DIR, 'xgb_momentum_v3_bearish_experimental_feature_schema.json'),
        }
      : {}),
    // TICKET-123 Variant C/D: undefined for modelMode='V1' (default) — orchestrator.ts falls back to
    // xgbFilter/config.ts's production v1 paths unchanged. 'V7_RAW' points at TICKET-118's Cách B
    // bullish/bearish RAW (uncalibrated) ONNX exports. Takes precedence over the v3 block above if
    // both were somehow requested (spread order: this object literal wins since it's listed last).
    ...(modelMode === 'V7_RAW'
      ? {
          momentumModelPath: path.join(MODELS_DIR, 'xgb_momentum_bullish_v7_raw.onnx'),
          momentumSchemaPath: path.join(MODELS_DIR, 'xgb_momentum_bullish_v7_raw_feature_schema.json'),
          momentumBearishModelPath: path.join(MODELS_DIR, 'xgb_momentum_bearish_v7_raw.onnx'),
          momentumBearishSchemaPath: path.join(MODELS_DIR, 'xgb_momentum_bearish_v7_raw_feature_schema.json'),
        }
      : {}),
    // TICKET-130: false (default) omits the field entirely -> undefined, orchestrator.ts's
    // tryMomentumDirect() never even calls computeDirection5m() — fully inert, matching every ticket
    // before this one exactly.
    ...(neutral5mDirectionSelectorEnabled ? { neutral5mDirectionSelectorEnabled: true } : {}),
    // TICKET-131: false (default) omits the field entirely -> undefined, orchestrator.ts's
    // tryOpenNewPosition() never even calls computeDirection5mRelaxed() — fully inert, matching every
    // ticket before this one exactly. Never sets/touches neutralTransitionGateConfig.neutralTransitionTradingEnabled.
    ...(neutral5mDirectionGatedRoutingEnabled ? { neutral5mDirectionGatedRoutingEnabled: true } : {}),
    // TICKET-138: 'NONE' (default) omits the field entirely -> undefined, orchestrator.ts's
    // tryMomentumDirect() macro-alignment check fires exactly as before this ticket — fully inert.
    ...(neutralMacroConflictOverrideMode !== 'NONE' ? { neutralMacroConflictOverrideMode } : {}),
  };
  // TICKET-123: fail-loud proof-of-model-in-use for the report — check file existence explicitly
  // here (in addition to orchestrator.ts's own throw-on-load-failure) so a missing V7_RAW artifact
  // is caught at startup, before any candle is processed, with a clear message.
  if (modelMode === 'V7_RAW') {
    for (const p of [
      config.momentumModelPath,
      config.momentumSchemaPath,
      config.momentumBearishModelPath,
      config.momentumBearishSchemaPath,
    ]) {
      if (p === undefined || !existsSync(p)) {
        throw new Error(`MODEL_MODE=V7_RAW nhưng không tìm thấy file model/schema: ${p}`);
      }
    }
    console.log(
      `MODEL_MODE=V7_RAW — dùng model: bullish=${config.momentumModelPath}, bullishSchema=${config.momentumSchemaPath}, bearish=${config.momentumBearishModelPath}, bearishSchema=${config.momentumBearishSchemaPath}`,
    );
  } else {
    console.log(`MODEL_MODE=V1 — dùng model production mặc định (${MOMENTUM_MODEL_PATH}, ${MOMENTUM_BEARISH_MODEL_PATH}), KHÔNG dùng V7_RAW.`);
  }

  let accountBalance = startBalance;
  // TICKET-056: Max Drawdown — the "cost" of allowing concentrated multi-position risk, tracked
  // alongside PNL/winrate so a PNL increase can't hide a bigger drawdown behind it.
  let peakBalance = startBalance;
  let maxDrawdownPct = 0;
  let maxDrawdownUsd = 0;
  const trades: CloseTradeEvent[] = [];
  // TICKET-036: SKIPPED events now have 2 distinct reasons — kept separate so this summary line
  // never falsely blames "risk pool" for what's actually the Momentum Gate rejecting NEUTRAL_TRANSITION.
  let riskPoolSkippedCount = 0;
  let neutralGateRejectedCount = 0;

  // TICKET-122 — diagnostic-only accumulator: every SHORT MOMENTUM_DIRECT gate evaluation this run
  // produced (via onMomentumGateEvaluation, TICKET-109's existing pass-through callback), so the
  // guard's "candidates affected" count and OOD-group-vs-non-OOD-group winrate can be computed
  // offline (joined against data/all-candidates-with-outcomes.csv by symbol+timestamp+side) without
  // any new plumbing inside orchestrator.ts itself. Never read by any decision logic.
  const shortMomentumDirectEvaluations: { symbol: string; timestamp: number; score: number; passed: boolean; oodFlagged: boolean }[] = [];

  // TICKET-130 — diagnostic-only accumulator: every NEUTRAL_TRANSITION MOMENTUM_DIRECT gate
  // evaluation (both LONG and SHORT), same pass-through-callback pattern as TICKET-122's
  // shortMomentumDirectEvaluations above. Only meaningful when neutral5mDirectionSelectorEnabled is
  // true (direction5m/rejectedByDirectionSelector stay undefined/false otherwise) — used offline by
  // ticket130GenerateReport.ts, joined against data/all-candidates-fully-enriched.csv by
  // symbol+timestamp+side. Never read by any decision logic.
  const neutralDirectionSelectorEvaluations: {
    symbol: string;
    timestamp: number;
    side: 'LONG' | 'SHORT';
    score: number;
    passed: boolean;
    direction5m: 'LONG' | 'SHORT' | 'NONE' | undefined;
    rejectedByDirectionSelector: boolean;
  }[] = [];

  // TICKET-131 — diagnostic-only accumulator: every NEUTRAL_TRANSITION gate evaluation touched by the
  // new Direction-Gated Routing (both the routing-decision-only rows for rejected candidates, score=0,
  // and the real gateScore rows for candidates the routing let through), same pass-through-callback
  // pattern as TICKET-130's neutralDirectionSelectorEvaluations above. Only meaningful when
  // neutral5mDirectionGatedRoutingEnabled is true. Never read by any decision logic.
  const neutral5mGatedRoutingEvaluations: {
    symbol: string;
    timestamp: number;
    side: 'LONG' | 'SHORT';
    setupType: 'OB' | 'FVG' | 'BOX_BREAKOUT' | 'SWEEP' | 'MOMENTUM_DIRECT';
    score: number;
    passed: boolean;
    direction5mGatedRouting: 'LONG' | 'SHORT' | 'NONE' | undefined;
    neutral5mRoutingAccepted: boolean | undefined;
    structuralBreakDiagnostic5m: 'LONG' | 'SHORT' | 'NONE' | undefined;
  }[] = [];
  // TICKET-138 — diagnostic-only accumulator: every NEUTRAL_TRANSITION MOMENTUM_DIRECT gate
  // evaluation where this side actually conflicted with the 1D macro direction (macroConflict===true),
  // same pass-through-callback pattern as TICKET-122/130/131 above. Populated on EVERY run where such
  // a conflict occurs, regardless of neutralMacroConflictOverrideMode (evaluateMacroConflictOverride()
  // in orchestrator.ts always computes macroConflict/is5mConfirmed once regime===NEUTRAL_TRANSITION,
  // independent of mode) — lets the V0 baseline run itself report the conflict rate and what
  // CONDITIONAL_5M would have decided. Never read by any decision logic.
  const macroConflictEvaluations: {
    symbol: string;
    timestamp: number;
    side: 'LONG' | 'SHORT';
    score: number;
    passed: boolean;
    macroConflict5mConfirmed: boolean | undefined;
    macroConflictOverridden: boolean;
  }[] = [];
  const manipulatedLogLines: string[] = []; // TICKET-027
  const dangerZoneLogLines: string[] = []; // TICKET-033

  // TICKET-055 — TEMPORARY verification counters (not required to keep long-term): breaks down every
  // SetupNotFiredDiagnostic by its adxDirection1h value, to verify TICKET-054's claim with real data
  // instead of trusting the code-reading alone.
  let setupNotFiredUndefinedCount = 0;
  let setupNotFiredFlatCount = 0;
  let setupNotFiredOtherCount = 0; // should stay 0 if TICKET-054's explanation is complete

  // TICKET-042 — Entry Funnel Analytics accumulators. Pure counting, derived from data
  // processCandle() already produces (regimeState + OrchestratorEvent + the optional
  // onFunnelEvent callback) — never influences any decision above.
  let totalStepsEvaluated = 0;
  const stateCounts: Record<string, number> = {};
  const funnelStats: Record<string, RegimeFunnelStats> = {};
  for (const regime of STATE_PASS_REGIMES) funnelStats[regime] = emptyFunnelStats();

  const rawTotalSteps = Math.min(...SYMBOLS.map((s) => symbolsData[s].candles5m.length));
  // startStep must guarantee enough REAL TIME has elapsed for every timeframe's window to be full,
  // not just the 5m one — 325 15m candles takes 3.4 real days (975 5m-candle-equivalents), which
  // dominates over the 5m window's own 320-candle (26.7h) requirement.
  // TICKET-061: skipDays lets a diagnostic run additionally skip N calendar days on top of the
  // usual warm-up margin — e.g. so 1D-history-dependent metrics (macroDirection, TICKET-017) are
  // already defined from step 0 onward. 288 = number of 5m candles per day. Default 0 -> unchanged.
  const warmupStartStep = Math.max(WINDOW_5M - 1, WINDOW_15M * 3, WINDOW_1H * 12) + 5 + skipDays * 288; // +5 safety margin

  // TICKET-087 — dateFrom/dateTo bound the TRADING window (entry attempts + trade log) to a specific
  // calendar range, while still feeding every OLDER candle through detectRegime()/etc as normal so
  // hysteresis/indicator history is warmed up exactly like every backtest run already needs — same
  // "warm up, then trade" mechanism as skipDays above, just pinned to an absolute date instead of a
  // day-count from the dataset's start. Uses BTCUSDT's own 5m timestamps as the reference axis (all
  // 4 symbols' 5m series are aligned 1:1 by construction — same fetchOhlcv.ts run for all of them).
  const referenceCandles = symbolsData.BTCUSDT.candles5m;
  const dateFromMs = dateFrom ? Date.parse(`${dateFrom}T00:00:00.000Z`) : undefined;
  const dateToExclusiveMs = dateTo ? Date.parse(`${dateTo}T00:00:00.000Z`) + 24 * 60 * 60_000 : undefined; // exclusive upper bound, covers the whole dateTo calendar day
  const dateFromStep = dateFromMs !== undefined ? referenceCandles.findIndex((c) => c.timestamp >= dateFromMs) : 0;
  const dateToStepExclusive = dateToExclusiveMs !== undefined ? referenceCandles.findIndex((c) => c.timestamp >= dateToExclusiveMs) : rawTotalSteps;

  const startStep = Math.max(warmupStartStep, dateFromStep < 0 ? rawTotalSteps : dateFromStep);
  const totalSteps = dateToStepExclusive < 0 ? rawTotalSteps : Math.min(rawTotalSteps, dateToStepExclusive);

  console.log(`Chạy ${totalSteps - startStep} bước x ${SYMBOLS.length} coin (từ nến 5m #${startStep})...`);

  for (let step = startStep; step < totalSteps; step++) {
    // TICKET-056 Phần C: sum ALL of a symbol's currently open positions (was a single value assuming
    // at most 1) — the risk pool check below now needs the total across every open position, not
    // just "whichever one" a symbol happened to have.
    // TICKET-101 Việc 1: seeded fresh each step from state ENTERING the step, then kept live-updated
    // (mutated in place, see below) as each symbol in this step's own loop opens/closes — no longer a
    // pure step-start snapshot.
    const openRiskBySymbol: Record<string, number> = {};
    // TICKET-101 Việc 2: same live-updated-within-step pattern as openRiskBySymbol above, but tracks
    // real margin$ (marginRequired) instead of risk$ — a SEPARATE, independent cap.
    const openMarginBySymbol: Record<string, number> = {};
    for (const symbol of SYMBOLS) {
      const totalRisk = symbolsData[symbol].state.openPositions.reduce((sum, entry) => sum + entry.meta.actualRiskDollar, 0);
      if (totalRisk > 0) openRiskBySymbol[symbol] = totalRisk;
      const totalMargin = symbolsData[symbol].state.openPositions.reduce((sum, entry) => sum + entry.meta.marginRequired, 0);
      if (totalMargin > 0) openMarginBySymbol[symbol] = totalMargin;
    }

    // TICKET-068: total setupType='MOMENTUM_DIRECT' open positions across ALL 4 symbols, same
    // one-step-lag convention as openRiskBySymbol above (computed from state entering this step,
    // before any of this step's own opens/closes) — fed into every symbol's ProcessCandleInput below.
    const momentumDirectOpenPositionsTotal = SYMBOLS.reduce(
      (sum, symbol) => sum + symbolsData[symbol].state.openPositions.filter((entry) => entry.meta.setupType === 'MOMENTUM_DIRECT').length,
      0,
    );

    // TICKET-070: per-position (symbol + side) detail of every currently open MOMENTUM_DIRECT
    // position across ALL 4 symbols, same one-step-lag convention as above.
    const momentumDirectOpenPositions: Array<{ symbol: string; side: 'LONG' | 'SHORT' }> = SYMBOLS.flatMap((symbol) =>
      symbolsData[symbol].state.openPositions
        .filter((entry) => entry.meta.setupType === 'MOMENTUM_DIRECT')
        .map((entry) => ({ symbol, side: entry.position.side })),
    );

    // TICKET-030: cross-symbol correlation needs all 4 symbols' aligned 1H windows BEFORE any
    // processCandle() call this step — computed ONCE here, then the same value is fed into every
    // symbol's input below. Pearson correlation over a fixed trailing window (unlike Wilder ATR/ADX)
    // has no recursive-seed dependency on how far back the window starts, so reusing WINDOW_1H(40)
    // — already >= CORRELATED_RISK_WINDOW_CANDLES(30)+1 — is safe; no dedicated larger window needed.
    const w1hBySymbol: Record<string, CandleData[]> = {};
    for (const symbol of SYMBOLS) {
      const sd = symbolsData[symbol];
      const decisionTime = sd.candles5m[step].timestamp + 5 * 60_000;
      const w1h = closedWindow(sd.candles1h, sd.ptr1h, 60 * 60_000, decisionTime, WINDOW_1H);
      sd.ptr1h = w1h.ptr;
      w1hBySymbol[symbol] = w1h.window;
    }
    const correlatedRiskRatioSeries = computeCorrelatedRiskRatio(w1hBySymbol, RegimeConfig.CORRELATED_RISK_WINDOW_CANDLES, 'BTCUSDT');
    const correlatedRiskRatio = correlatedRiskRatioSeries[correlatedRiskRatioSeries.length - 1];

    for (const symbol of SYMBOLS) {
      const sd = symbolsData[symbol];
      const currentCandle = sd.candles5m[step];
      const decisionTime = currentCandle.timestamp + 5 * 60_000;

      const window5m = sd.candles5m.slice(Math.max(0, step - WINDOW_5M + 1), step + 1);
      const windowSessionVolume5m = sd.candles5m.slice(Math.max(0, step - WINDOW_5M_SESSION_VOLUME + 1), step + 1);
      const w15 = closedWindow(sd.candles15m, sd.ptr15m, 15 * 60_000, decisionTime, WINDOW_15M);
      sd.ptr15m = w15.ptr;
      // TICKET-024: same closed-candle pointer (sd.ptr1h, already advanced in the pre-pass above),
      // just a longer slice — momentum's EMA(200) needs far more 1h history than regime/entry's own
      // WINDOW_1H(40). closedWindow's ptr advancement doesn't depend on windowSize, so recomputing
      // from the already-advanced sd.ptr1h here is safe/idempotent.
      const w1hMomentum = closedWindow(sd.candles1h, sd.ptr1h, 60 * 60_000, decisionTime, WINDOW_1H_MOMENTUM);
      const w1m = closedWindow(sd.candles1m, sd.ptr1m, 60_000, decisionTime, WINDOW_1M);
      sd.ptr1m = w1m.ptr;
      const w1d = closedWindow(sd.candles1d, sd.ptr1d, 24 * 60 * 60_000, decisionTime, WINDOW_1D);
      sd.ptr1d = w1d.ptr;

      // TICKET-056 Phần C: was filtered to `s !== symbol` (this symbol could never have an open
      // position of its own when tried before this ticket) — now includes THIS symbol's own
      // already-open position(s) too, so the risk pool check never under-counts concentrated risk.
      const allOpenPositionsRisk: OpenPositionRisk[] = SYMBOLS.filter((s) => openRiskBySymbol[s] !== undefined).map((s) => ({
        id: s,
        actualRiskDollar: openRiskBySymbol[s],
      }));
      // TICKET-101 Việc 2: single aggregate across ALL 4 symbols (not a per-symbol breakdown like
      // allOpenPositionsRisk above) — wouldExceedMaxTotalMargin() only ever needs the total.
      const totalOpenMarginDollar = Object.values(openMarginBySymbol).reduce((sum, m) => sum + m, 0);

      const input: ProcessCandleInput = {
        symbol,
        candles5m: window5m,
        candles15m: w15.window,
        candles1h: w1hBySymbol[symbol],
        candles1m: w1m.window,
        candles1d: w1d.window,
        candles1hMomentum: w1hMomentum.window,
        candles5mSessionVolume: windowSessionVolume5m,
        correlatedRiskRatio,
        totalOpenMarginDollar,
        accountBalance,
        allOpenPositionsRisk,
        momentumDirectOpenPositionsTotal,
        momentumDirectOpenPositions,
      };

      // TICKET-042: per-call buffer — processCandle() runs synchronously for this one symbol/step,
      // so every event pushed here belongs to the single confirmed regime read off the result below.
      const funnelEventsThisStep: FunnelEvent[] = [];

      const result = await processCandle(
        input,
        sd.state,
        config,
        (d) => manipulatedLogLines.push(formatManipulatedDiagnostic(d)),
        (d) => dangerZoneLogLines.push(formatDangerZoneDiagnostic(d)),
        (_symbol, _timestamp, event) => funnelEventsThisStep.push(event),
        // TICKET-055 — TEMPORARY verification-only counter, see declaration above.
        (d: SetupNotFiredDiagnostic) => {
          if (d.adxDirection1h === undefined) setupNotFiredUndefinedCount++;
          else if (d.adxDirection1h === 'FLAT') setupNotFiredFlatCount++;
          else setupNotFiredOtherCount++;
        },
        undefined, // onRegimeMetrics — not needed by this diagnostic
        // TICKET-122/130 — collect gate evaluations for offline analysis (OOD guard + Neutral 5m
        // Direction Selector respectively).
        (evaluation) => {
          if (evaluation.gateType === 'MOMENTUM_DIRECT' && evaluation.side === 'SHORT') {
            shortMomentumDirectEvaluations.push({
              symbol: evaluation.symbol,
              timestamp: evaluation.timestamp,
              score: evaluation.score,
              passed: evaluation.passed,
              oodFlagged: evaluation.oodFlagged === true,
            });
          }
          // TICKET-130: only ever non-empty when neutral5mDirectionSelectorEnabled=true (otherwise
          // evaluation.regime===NEUTRAL_TRANSITION rows exist but direction5m/rejectedByDirectionSelector
          // stay undefined/false — filtered out here since they're not useful diagnostic rows).
          if (evaluation.gateType === 'MOMENTUM_DIRECT' && evaluation.regime === MarketRegime.NEUTRAL_TRANSITION && neutral5mDirectionSelectorEnabled) {
            neutralDirectionSelectorEvaluations.push({
              symbol: evaluation.symbol,
              timestamp: evaluation.timestamp,
              side: evaluation.side,
              score: evaluation.score,
              passed: evaluation.passed,
              direction5m: evaluation.direction5m,
              rejectedByDirectionSelector: evaluation.rejectedByDirectionSelector === true,
            });
          }
          // TICKET-131: gateType='NEUTRAL_TRANSITION' rows carrying direction5mGatedRouting !==
          // undefined only ever exist when neutral5mDirectionGatedRoutingEnabled=true — filtered here
          // for the same reason as the TICKET-130 block above.
          if (evaluation.gateType === 'NEUTRAL_TRANSITION' && evaluation.direction5mGatedRouting !== undefined) {
            neutral5mGatedRoutingEvaluations.push({
              symbol: evaluation.symbol,
              timestamp: evaluation.timestamp,
              side: evaluation.side,
              setupType: evaluation.setupType,
              score: evaluation.score,
              passed: evaluation.passed,
              direction5mGatedRouting: evaluation.direction5mGatedRouting,
              neutral5mRoutingAccepted: evaluation.neutral5mRoutingAccepted,
              structuralBreakDiagnostic5m: evaluation.structuralBreakDiagnostic5m,
            });
          }
          // TICKET-138 — see macroConflictEvaluations declaration above.
          if (evaluation.gateType === 'MOMENTUM_DIRECT' && evaluation.macroConflict === true) {
            macroConflictEvaluations.push({
              symbol: evaluation.symbol,
              timestamp: evaluation.timestamp,
              side: evaluation.side,
              score: evaluation.score,
              passed: evaluation.passed,
              macroConflict5mConfirmed: evaluation.macroConflict5mConfirmed,
              macroConflictOverridden: evaluation.macroConflictOverridden === true,
            });
          }
        },
      );
      sd.state = result.symbolState;
      accountBalance = result.accountBalance;

      // TICKET-101 Việc 1 — BUG FIX: openRiskBySymbol was a snapshot taken ONCE before this step's
      // per-symbol loop (the old "one-step-lag convention"), so if symbol A opened a NEW position
      // earlier in THIS SAME step, symbol B's risk-pool check later in the same loop still saw the
      // pre-step total — under-counting real concentrated risk within a single step. Refresh
      // immediately after each symbol's own processCandle() so the NEXT symbol in this step's loop
      // sees this symbol's up-to-date total.
      const newTotalRisk = sd.state.openPositions.reduce((sum, entry) => sum + entry.meta.actualRiskDollar, 0);
      if (newTotalRisk > 0) openRiskBySymbol[symbol] = newTotalRisk;
      else delete openRiskBySymbol[symbol];
      const newTotalMargin = sd.state.openPositions.reduce((sum, entry) => sum + entry.meta.marginRequired, 0);
      if (newTotalMargin > 0) openMarginBySymbol[symbol] = newTotalMargin;
      else delete openMarginBySymbol[symbol];

      totalStepsEvaluated++;
      const confirmedRegime = result.symbolState.regimeState.previousRegime;
      if (confirmedRegime !== null) {
        stateCounts[confirmedRegime] = (stateCounts[confirmedRegime] ?? 0) + 1;
      }
      const stats = confirmedRegime !== null ? funnelStats[confirmedRegime] : undefined;
      if (stats) {
        for (const event of funnelEventsThisStep) {
          // TICKET-043/044: MSS-fail breakdown — counted regardless of the passed/continue branch
          // below, since these are exactly the passed=false MSS events (all 4 possible reasons).
          if (event.stage === 'MSS' && !event.passed && event.reason) {
            stats.mssFailReasons[event.reason] = (stats.mssFailReasons[event.reason] ?? 0) + 1;
            if (event.reason === 'MSS_TIMEOUT' && event.candlesLate !== undefined) {
              stats.mssTimeoutCandlesLate.push(event.candlesLate);
            }
          }
          // TICKET-053: BREAKOUT-fail breakdown — counted regardless of the passed/continue branch
          // below, same as the MSS block above. Includes every reason (e.g. MACRO_TREND_OPPOSITE),
          // not just the 3 detector reasons — the report's own total-matches-actual row flags it if
          // any reason outside the known 3 ever contributes a nonzero count.
          if (event.stage === 'BREAKOUT' && !event.passed && event.reason) {
            stats.breakoutFailReasons[event.reason] = (stats.breakoutFailReasons[event.reason] ?? 0) + 1;
          }
          // TICKET-054 Phần A: SETUP-fail breakdown, same pattern.
          if (event.stage === 'SETUP' && !event.passed && event.reason) {
            stats.setupFailReasons[event.reason] = (stats.setupFailReasons[event.reason] ?? 0) + 1;
          }
          // TICKET-054 Phần B: MACRO-fail split by side — not a new reason, just an extra dimension.
          if (event.stage === 'MACRO' && !event.passed && event.side) {
            stats.macroFailBySide[event.side]++;
          }
          if (!event.passed) continue;
          if (event.stage === 'SETUP') stats.setupPass++;
          else if (event.stage === 'MACRO') stats.macroPass++;
          else if (event.stage === 'MSS') stats.mssPass++;
          else if (event.stage === 'BREAKOUT') stats.breakoutPass++;
        }
        for (const event of result.events) {
          if (event.type === 'OPEN') stats.opens++;
          else if (event.type === 'SKIPPED' && event.reason === 'RISK_POOL_EXCEEDED') stats.riskPoolSkip++;
        }
      }

      // TICKET-056: was a single nullable `result.event` — now a list, since one candle can produce
      // multiple events (e.g. one or more CLOSEs plus an OPEN/SKIPPED) when a symbol holds more than
      // one concurrent position.
      for (const event of result.events) {
        if (event.type === 'CLOSE') trades.push(event);
        else if (event.type === 'SKIPPED') {
          if (event.reason === 'RISK_POOL_EXCEEDED') riskPoolSkippedCount++;
          else neutralGateRejectedCount++;
        }
      }

      // TICKET-056: Max Drawdown — tracked on the shared equity curve (accountBalance updates
      // sequentially across all 4 symbols within a step, same as everywhere else in this loop).
      if (accountBalance > peakBalance) peakBalance = accountBalance;
      const drawdownUsd = peakBalance - accountBalance;
      const drawdownPct = peakBalance > 0 ? (drawdownUsd / peakBalance) * 100 : 0;
      if (drawdownPct > maxDrawdownPct) {
        maxDrawdownPct = drawdownPct;
        maxDrawdownUsd = drawdownUsd;
      }
    }

    const progressStep = step - startStep;
    if (progressStep % 2000 === 0) {
      console.log(
        `  bước ${progressStep}/${totalSteps - startStep} — balance=$${accountBalance.toFixed(2)}, trades=${trades.length}, riskPoolSkipped=${riskPoolSkippedCount}, neutralGateRejected=${neutralGateRejectedCount}...`,
      );
    }
  }

  console.log(
    `Xong. ${trades.length} lệnh đóng, ${riskPoolSkippedCount} lệnh bị bỏ qua (risk pool đầy), ${neutralGateRejectedCount} lệnh bị Momentum Gate từ chối (NEUTRAL_TRANSITION), balance cuối=$${accountBalance.toFixed(2)}`,
  );

  // TICKET-055 — TEMPORARY verification report (không lưu file riêng, chỉ in ra console).
  const setupNotFiredTotal = setupNotFiredUndefinedCount + setupNotFiredFlatCount + setupNotFiredOtherCount;
  console.log(`\nTrong ${fmtInt(setupNotFiredTotal)} case SETUP FAIL không phân loại được lý do (TICKET-055):`);
  console.log(`- adxDirection1h = undefined: ${fmtInt(setupNotFiredUndefinedCount)} case`);
  console.log(`- adxDirection1h = 'FLAT': ${fmtInt(setupNotFiredFlatCount)} case`);
  console.log(
    `- Tổng 2 loại trên: ${fmtInt(setupNotFiredUndefinedCount + setupNotFiredFlatCount)} / ${fmtInt(setupNotFiredTotal)} (${pct(setupNotFiredUndefinedCount + setupNotFiredFlatCount, setupNotFiredTotal)})`,
  );
  console.log(
    `- CÒN LẠI (không phải undefined/FLAT, nhưng vẫn không bắn FunnelEvent): ${fmtInt(setupNotFiredOtherCount)} case${setupNotFiredOtherCount > 0 ? ' — CẦN ĐIỀU TRA THÊM, có nhánh return sớm khác chưa biết tới!' : ''}`,
  );

  // TICKET-027 — điều tra riêng, không trộn vào backtest-report.md/backtest-trades.csv.
  const manipulatedLogPath = path.resolve(process.cwd(), 'data/manipulated-log.txt');
  writeFileSync(manipulatedLogPath, manipulatedLogLines.join('\n\n') + '\n');
  console.log(`→ ${manipulatedLogPath} (${manipulatedLogLines.length} lần MANIPULATED được xác nhận mới)`);

  // TICKET-033 — điều tra riêng, không trộn vào backtest-report.md/backtest-trades.csv.
  const dangerZoneLogPath = path.resolve(process.cwd(), 'data/danger-zone-log.txt');
  writeFileSync(dangerZoneLogPath, dangerZoneLogLines.join('\n\n') + '\n');
  console.log(`→ ${dangerZoneLogPath} (${dangerZoneLogLines.length} lần DANGER_ZONE được xác nhận mới)`);

  // TICKET-042 — công cụ dùng lại được (không phải log điều tra 1 lần), ghi riêng file của nó.
  const entryFunnelReportPath = path.resolve(process.cwd(), 'data/entry-funnel-report.md');
  writeFileSync(entryFunnelReportPath, funnelReportMarkdown(totalStepsEvaluated, stateCounts, funnelStats, neutralGateRejectedCount, entryStyleForNeutral));
  console.log(`→ ${entryFunnelReportPath}`);

  // TICKET-030: CORRELATED_RISK has no CLI on/off flag (unconditionally wired in, same pattern as
  // MANIPULATED/LOW_LIQUIDITY) — "-correlated" appended so this run's report/trades never overwrite
  // the pre-TICKET-030 both-momentum files (PM explicitly wants the $468.49 baseline preserved for comparison).
  const suffix =
    outputSuffix(
      macroTrendFilterEnabled,
      obDisabledSymbols,
      macroTrendFilterAppliesToBoxBreakout,
      momentumFilterEnabled,
      neutralTransitionEnabled,
      planAutoSelectionEnabled,
      maxConcurrentPositionsPerSymbol,
      momentumDirectEnabled,
    ) +
    '-correlated' +
    // TICKET-122: only appended when the guard is actually active, so every run before this ticket
    // (and the baseline run with oodGuardMode=NONE) keeps its exact pre-existing filename.
    (oodGuardMode !== 'NONE' ? `-ood${oodGuardMode.toLowerCase().replace(/_/g, '')}-${oodGuardEmaRatioSlowThreshold}` : '') +
    // TICKET-130: only appended when the selector is actually active, so every run before this
    // ticket (and Variant A's own neutral5mDirectionSelectorEnabled=false run) keeps its exact
    // pre-existing filename.
    (neutral5mDirectionSelectorEnabled ? '-neutral5mselector' : '') +
    // TICKET-131: only appended when the new routing is actually active, so every run before this
    // ticket keeps its exact pre-existing filename.
    (neutral5mDirectionGatedRoutingEnabled ? '-neutral5mgatedrouting' : '') +
    // TICKET-138: only appended when the override is actually active, so every run before this
    // ticket (and the NONE-mode baseline run) keeps its exact pre-existing filename.
    (neutralMacroConflictOverrideMode !== 'NONE' ? `-macroconflict${neutralMacroConflictOverrideMode.toLowerCase().replace(/_/g, '')}` : '');
  const tradesPath = path.resolve(process.cwd(), `data/backtest-trades-${suffix}.csv`);
  writeFileSync(tradesPath, tradesCsv(trades));
  console.log(`→ ${tradesPath}`);

  // TICKET-122 — diagnostic-only OOD guard evaluation log (never influences trades/report above).
  if (oodGuardMode !== 'NONE') {
    const oodDiagPath = path.resolve(process.cwd(), `data/ticket122-ood-diagnostics-${suffix}.csv`);
    const oodHeader = 'symbol,timestamp,score,passed,oodFlagged';
    const oodRows = shortMomentumDirectEvaluations.map((e) => [e.symbol, e.timestamp, e.score, e.passed, e.oodFlagged].join(','));
    writeFileSync(oodDiagPath, [oodHeader, ...oodRows].join('\n') + '\n');
    const oodFlaggedCount = shortMomentumDirectEvaluations.filter((e) => e.oodFlagged).length;
    console.log(`→ ${oodDiagPath} (${shortMomentumDirectEvaluations.length} SHORT MOMENTUM_DIRECT evaluations, ${oodFlaggedCount} OOD-flagged)`);
  }

  // TICKET-130 — diagnostic-only Neutral 5m Direction Selector evaluation log (never influences
  // trades/report above), consumed offline by ticket130GenerateReport.ts.
  if (neutral5mDirectionSelectorEnabled) {
    const neutralDiagPath = path.resolve(process.cwd(), `data/ticket130-neutral5m-diagnostics-${suffix}.csv`);
    const neutralHeader = 'symbol,timestamp,side,score,passed,direction5m,rejectedByDirectionSelector';
    const neutralRows = neutralDirectionSelectorEvaluations.map((e) =>
      [e.symbol, e.timestamp, e.side, e.score, e.passed, e.direction5m ?? '', e.rejectedByDirectionSelector].join(','),
    );
    writeFileSync(neutralDiagPath, [neutralHeader, ...neutralRows].join('\n') + '\n');
    const rejectedCount = neutralDirectionSelectorEvaluations.filter((e) => e.rejectedByDirectionSelector).length;
    console.log(`→ ${neutralDiagPath} (${neutralDirectionSelectorEvaluations.length} NEUTRAL_TRANSITION MOMENTUM_DIRECT evaluations, ${rejectedCount} rejected by the selector)`);
  }

  // TICKET-131 — diagnostic-only Neutral 5m Direction-Gated Routing evaluation log (never influences
  // trades/report above), consumed offline to build data/ticket131-neutral-5m-direction-gated-routing-report.md.
  if (neutral5mDirectionGatedRoutingEnabled) {
    const routingDiagPath = path.resolve(process.cwd(), `data/ticket131-neutral5m-gated-routing-diagnostics-${suffix}.csv`);
    const routingHeader = 'symbol,timestamp,side,setupType,score,passed,direction5mGatedRouting,neutral5mRoutingAccepted,structuralBreakDiagnostic5m';
    const routingRows = neutral5mGatedRoutingEvaluations.map((e) =>
      [
        e.symbol,
        e.timestamp,
        e.side,
        e.setupType,
        e.score,
        e.passed,
        e.direction5mGatedRouting ?? '',
        e.neutral5mRoutingAccepted ?? '',
        e.structuralBreakDiagnostic5m ?? '',
      ].join(','),
    );
    writeFileSync(routingDiagPath, [routingHeader, ...routingRows].join('\n') + '\n');
    const noneBlockedCount = neutral5mGatedRoutingEvaluations.filter((e) => e.direction5mGatedRouting === 'NONE').length;
    const sideMismatchBlockedCount = neutral5mGatedRoutingEvaluations.filter(
      (e) => e.direction5mGatedRouting !== 'NONE' && e.direction5mGatedRouting !== e.side && e.neutral5mRoutingAccepted === false,
    ).length;
    const acceptedCount = neutral5mGatedRoutingEvaluations.filter((e) => e.neutral5mRoutingAccepted === true).length;
    console.log(
      `→ ${routingDiagPath} (${neutral5mGatedRoutingEvaluations.length} candidates seen, ${noneBlockedCount} blocked by direction5m=NONE, ${sideMismatchBlockedCount} blocked by side mismatch, ${acceptedCount} accepted through to the AI gate)`,
    );
  }

  // TICKET-138 — diagnostic-only Neutral Macro Conflict Override evaluation log (never influences
  // trades/report above), consumed offline to build data/ticket138-neutral-5m-conditional-override.md.
  // Written on EVERY run (macroConflictEvaluations is populated regardless of
  // neutralMacroConflictOverrideMode — see the field's doc comment in orchestrator.ts) so the V0
  // baseline run itself can report the macro-conflict rate and what CONDITIONAL_5M would have decided.
  {
    const macroConflictDiagPath = path.resolve(process.cwd(), `data/ticket138-macro-conflict-diagnostics-${suffix}.csv`);
    const macroConflictHeader = 'symbol,timestamp,side,score,passed,macroConflict5mConfirmed,macroConflictOverridden';
    const macroConflictRows = macroConflictEvaluations.map((e) =>
      [e.symbol, e.timestamp, e.side, e.score, e.passed, e.macroConflict5mConfirmed ?? '', e.macroConflictOverridden].join(','),
    );
    writeFileSync(macroConflictDiagPath, [macroConflictHeader, ...macroConflictRows].join('\n') + '\n');
    const confirmedCount = macroConflictEvaluations.filter((e) => e.macroConflict5mConfirmed === true).length;
    const overriddenCount = macroConflictEvaluations.filter((e) => e.macroConflictOverridden).length;
    console.log(
      `→ ${macroConflictDiagPath} (${macroConflictEvaluations.length} NEUTRAL_TRANSITION MOMENTUM_DIRECT candidates with a macro conflict, ${confirmedCount} 5M_CONFIRMED, ${overriddenCount} actually overridden this run)`,
    );
  }

  const totalTrades = trades.length;
  const wins = trades.filter((t) => t.pnlUsd > 0).length;
  const winrate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
  const totalPnl = trades.reduce((sum, t) => sum + t.pnlUsd, 0);

  const report = [
    '# Backtest Report — TICKET-010',
    '',
    `Sinh tự động từ \`npm run backtest -- --entry-style=${entryStyleForNeutral} --tp-plan=${tpPlan} --macro-trend-filter=${macroTrendFilterEnabled} --ob-disabled-symbols=${obDisabledSymbols.join(',')} --macro-trend-box-breakout=${macroTrendFilterAppliesToBoxBreakout} --momentum-filter=${momentumFilterEnabled}\` — dữ liệu thật ${new Date().toISOString()}.`,
    '',
    `- Vốn ban đầu: $${startBalance}, vốn cuối: $${accountBalance.toFixed(2)}`,
    `- Tổng số lệnh đóng: ${totalTrades}`,
    `- Winrate: ${winrate.toFixed(1)}%`,
    `- Tổng PNL: ${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)} USD`,
    `- PNL trung bình/lệnh: ${totalTrades > 0 ? (totalPnl / totalTrades >= 0 ? '+' : '') + (totalPnl / totalTrades).toFixed(2) : '0.00'} USD (TICKET-052)`,
    `- Max Drawdown: -${maxDrawdownPct.toFixed(2)}% (-$${maxDrawdownUsd.toFixed(2)}) (TICKET-056)`,
    `- Số lệnh bị bỏ qua vì risk pool đầy: ${riskPoolSkippedCount}`,
    `- Số lệnh bị Momentum Gate từ chối (NEUTRAL_TRANSITION, TICKET-036): ${neutralGateRejectedCount}`,
    '',
    statsTable('PNL theo symbol', groupBy(trades, (t) => t.symbol)),
    statsTable('PNL theo regime', groupBy(trades, (t) => t.regime)),
    statsTable('PNL theo setupType', groupBy(trades, (t) => t.setupType)),
    statsTable('PNL theo exitReason', groupBy(trades, (t) => t.exitReason)),
    statsTable(
      'PNL theo tháng',
      groupBy(trades, (t) => new Date(t.exitTimestamp).toISOString().slice(0, 7)),
      true,
    ),
    '',
    '## Cấu hình đã dùng',
    '',
    `- Position sizing: DynamicRMarginSizer, riskDollarOrPercent=${riskDollarOrPercent} (CLI-overridable, default 20), maxMarginCap=${maxMarginCap} (CLI-overridable, default 50), leverage=30`,
    `- tpPlan: ${tpPlan}`,
    `- entryStyleForNeutral: ${entryStyleForNeutral}`,
    `- macroTrendFilterEnabled: ${macroTrendFilterEnabled} (TICKET-017 Phần A)`,
    `- obDisabledSymbols: [${obDisabledSymbols.join(',')}] (TICKET-017 Phần B)`,
    `- macroTrendFilterAppliesToBoxBreakout: ${macroTrendFilterAppliesToBoxBreakout} (TICKET-018)`,
    `- momentumFilterEnabled: ${momentumFilterEnabled} (TICKET-024, thresholds: low=${config.momentumFilterConfig.momentumLowThreshold} high=${config.momentumFilterConfig.momentumHighThreshold} lowMultiplier=${config.momentumFilterConfig.momentumLowMultiplier})`,
    `- neutralTransitionEnabled: ${neutralTransitionEnabled} (TICKET-036, hard Momentum Gate, threshold=${config.neutralTransitionGateConfig.neutralTransitionMomentumGateThreshold})`,
    `- riskPoolMaxPct: ${(riskPoolMaxPct * 100).toFixed(0)}% (TICKET-037, CLI-overridable, default 10%)`,
    `- mssStalenessToleranceCandles: ${config.entryRouterConfig.mssStalenessToleranceCandles} (TICKET-040, CLI-overridable, default 5)`,
    `- obBosLookforwardK: ${config.entryRouterConfig.obBosLookforwardK} (TICKET-041, CLI-overridable, default 10)`,
    `- obSlBufferAtrMultiplier: ${config.entryRouterConfig.obSlBufferAtrMultiplier} (TICKET-089, TODO_CONFIRM, CLI-overridable, default 0.1, chỉ áp dụng cho OB — FVG/Sweep vẫn dùng EntryConfig.SL_BUFFER_ATR_MULTIPLIER)`,
    `- maxTotalMarginPct: ${config.maxTotalMarginPct !== undefined ? `${(config.maxTotalMarginPct * 100).toFixed(1)}%` : '(không giới hạn)'} (TICKET-101 Việc 2, TODO_CONFIRM, CLI-overridable, default không giới hạn — trần TỔNG MARGIN thật đang mở trên cả 4 coin, độc lập với Risk Pool)`,
    `- maxConcurrentPositionsPerSymbol: ${config.maxConcurrentPositionsPerSymbol} (TICKET-056, CLI-overridable, default 1)`,
    `- momentumDirectEnabled: ${momentumDirectEnabled} (TICKET-059, AI momentum score dùng thẳng làm tín hiệu vào lệnh, song song với cascade OB/FVG/Sweep/Breakout, threshold=${momentumDirectThreshold})`,
    `- momentumDirectMaxAtrPercentile: ${momentumDirectMaxAtrPercentile} (TICKET-062, TODO_CONFIRM, CLI-overridable, default 100 = không giới hạn)`,
    `- momentumDirectMinSlPercent: ${momentumDirectMinSlPercent}% (TICKET-064 Phần A, TODO_CONFIRM, CLI-overridable, sàn tối thiểu khoảng cách SL — pha loãng phí)`,
    `- momentumDirectTpRMultiple: ${momentumDirectTpRMultiple}× R (TICKET-064 Phần B, TODO_CONFIRM, CLI-overridable — thay thế TP cố định 0.5% cũ)`,
    `- momentumDirectMaxTotalConcurrent: ${momentumDirectMaxTotalConcurrent} (TICKET-068, TODO_CONFIRM, CLI-overridable, default 999 = không giới hạn, giới hạn tổng vị thế MOMENTUM_DIRECT toàn hệ thống, song song với maxConcurrentPositionsPerSymbol)`,
    `- momentumDirectCorrelationRiskThreshold: ${momentumDirectCorrelationRiskThreshold} (TICKET-071, TODO_CONFIRM, CLI-overridable, default 999 = trigger không bao giờ kích hoạt, điều kiện kết hợp: correlatedRiskRatio cao + đã có lệnh cùng chiều khác coin)`,
    `- momentumDirectCorrelationRiskMultiplier: ${momentumDirectCorrelationRiskMultiplier} (TICKET-071, TODO_CONFIRM, CLI-overridable, default 1.0 = không đổi size, nhân vào riskMultiplier khi trigger kích hoạt — thay thế cơ chế chặn hẳn của TICKET-070)`,
    `- momentumDirectCircuitBreakerLossThreshold: ${momentumDirectCircuitBreakerLossThreshold} (TICKET-081, TODO_CONFIRM, CLI-overridable, default 999999 = không bao giờ kích hoạt — tạm dừng MOMENTUM_DIRECT cho đúng symbol+side sau N lần thua SL liên tiếp)`,
    `- momentumDirectCircuitBreakerCooldownMs: ${momentumDirectCircuitBreakerCooldownMs}ms (TICKET-081, TODO_CONFIRM, CLI-overridable, default 0 — thời gian tạm dừng sau khi cầu dao kích hoạt, reset khi có 1 lệnh thắng)`,
    `- oodGuardMode: ${oodGuardMode} (TICKET-122, TODO_CONFIRM, CLI-overridable, default NONE = tắt hẳn — guard OOD cho model SHORT MOMENTUM_DIRECT dựa trên emaRatioSlow, threshold=${oodGuardEmaRatioSlowThreshold}, scoreCap=${oodGuardScoreCap}, riskReductionMultiplier=${oodGuardRiskReductionMultiplier})`,
    `- neutral5mDirectionSelectorEnabled: ${neutral5mDirectionSelectorEnabled} (TICKET-130, veto-only 3/3 selector cho tryMomentumDirect(), FAIL — không dùng lại rule này trong TICKET-131)`,
    `- neutral5mDirectionGatedRoutingEnabled: ${neutral5mDirectionGatedRoutingEnabled} (TICKET-131, relaxed 2/2 EMA+DI routing cho OB/FVG/SWEEP/BOX_BREAKOUT trong NEUTRAL_TRANSITION khi neutralTransitionTradingEnabled=false — không tự bật Neutral, chỉ mở thêm 1 đường đi riêng khi direction5m đúng side)`,
    `- planAutoSelectionEnabled: ${planAutoSelectionEnabled} (TICKET-052, AI-driven Plan A/B selection, TREND only, threshold=${config.planAutoSelectionConfig.planAutoSelectionMomentumThreshold})`,
    `- Runner trailing: ATR (2.5×ATR), không dùng Structure trailing`,
    `- takerFeeRate: 0.0004 (TODO_CONFIRM — Trader chưa cung cấp số thật)`,
    `- Quy tắc SL/TP cùng nến: SL chạm trước`,
    `- Khớp lệnh tại entryPrice do Tầng 2 tính, không mô phỏng slippage/độ trễ`,
    '',
    `Chi tiết từng lệnh: \`data/backtest-trades-${suffix}.csv\`.`,
  ].join('\n');

  const reportPath = path.resolve(process.cwd(), `data/backtest-report-${suffix}.md`);
  writeFileSync(reportPath, report);
  console.log(`→ ${reportPath}`);
}

main().catch((err) => {
  console.error('backtest failed:', err);
  process.exit(1);
});
