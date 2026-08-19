/**
 * TICKET-G6R-CP3H — Step 4 (ticket Section K): the ONE authorized forensic replay.
 *
 * Diagnostic evidence capture ONLY. Does NOT change the CP3 verdict, does NOT run CP4/5/6, does NOT
 * touch production, does NOT run candidate Central, and does NOT create a canonical
 * data/g6r-runs/g6r-cp3-shadow-candidates.csv (this script never writes that filename).
 *
 * Reuses the SAME baseline config/cost/dataset/STOP_STEP as the canonical CP3 runner
 * (buildBaselineConfig()/makeFillModel()/runReplay() from ticket150BacktestExecutionRealismAudit.ts,
 * identical wiring pattern to g6rCheckpoint3Replay.ts) — this is a NEW, separate script, not a
 * modification of that file. Attaches ONLY observer-only hooks (onBeforeProcessCandle/onStepContext),
 * never blockEntry or anything that can alter a decision.
 *
 * Population captured (wider than the canonical 105-row actionable population, per ticket Section K):
 *   1. Every actionable shadow candidate (FVG/Sweep) — same selection the canonical CP3 rule
 *      produces — with FULL SL/timestamp telemetry (rawSlPrice/atr/bufferAmount/candlesFromEnd),
 *      which the canonical run never persisted (only the final buffered slPrice was ever recorded).
 *   2. Every OB-primary evaluation whose OWN MSS confirms (production's own admitted-candidate path)
 *      — captured here as setupType='OB' telemetry rows. These were NEVER persisted anywhere before
 *      (the canonical G6ShadowOpportunityAnalyzer only builds a FrozenShadowEvent for the FALLBACK
 *      path; an OB-primary confirm short-circuits with no persisted row at all).
 * Evaluations whose MSS attempt did not confirm (NOT_FOUND/STALE/NO_ATR — no entryPrice/slPrice
 * exists at all) are NOT included in this per-candidate geometry ledger, because geometry is
 * structurally inapplicable without an entry price. This is disclosed explicitly in the final
 * report's "remaining unknowns" section, not silently omitted.
 *
 * rawSlPrice recovery: StageEvaluation (g6rShadowAnalyzer.ts) does not expose rawSlPrice/atr/buffer
 * on its return type. This script re-derives them by calling the SAME real production detector
 * functions (detectOrderBlock/detectFairValueGap/detectLiquiditySweep/wilderATRSeries) a second time
 * with the identical (candles5m, direction) arguments the analyzer itself used — never a
 * reimplementation of their pattern-matching logic, just a second real call to recover a value the
 * analyzer computed internally but did not return. Deterministic pure functions of the same inputs
 * are guaranteed to return the same zone, so this cannot silently diverge from what the analyzer used.
 *
 * Output: data/g6r-runs/g6r-cp3h-shadow-forensic-ledger.csv, data/g6r-runs/g6r-cp3h-classification.csv,
 * data/g6r-runs/g6r-cp3h-summary.json, data/g6r-runs/g6r-cp3h-replay-trades.json (for Step 5 parity).
 * Execution record (with the EXTERNALLY OBSERVED process exit code) is written by the wrapper that
 * spawns this script as a genuine child process, per ticket Section K — this script itself never
 * self-reports an exit code.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildBaselineConfig, makeFillModel, runReplay, type ReplayVariantHooks } from './ticket150BacktestExecutionRealismAudit.js';
import { MarketRegime, type CandleData } from '../dist/regime/types.js';
import { evaluationId, candidateKey as makeCandidateKey } from './g6rFullPathFunnel.js';
import { wilderDIDirectionSeries, wilderATRSeries, lastDefined } from '../dist/regime/indicators.js';
import { EntryConfig } from '../dist/entry/config.js';
import { RegimeConfig } from '../dist/regime/config.js';
import { detectOrderBlock } from '../dist/entry/detectors/orderBlock.js';
import { detectFairValueGap } from '../dist/entry/detectors/fairValueGap.js';
import { detectLiquiditySweep } from '../dist/entry/detectors/liquiditySweep.js';
import { parseLedgerCsvRequiringEvaluationId, validateEvaluationIdSchema } from './g6rCsvParser.js';
import {
  createG6ShadowOpportunityAnalyzer,
  FutureCandleViolationError,
  FIVE_MINUTES_MS,
  ONE_DAY_MS,
  type G6ShadowObservation,
  type DecisionFeatureProvenance,
} from './g6rShadowAnalyzer.js';
import { assembleForensicRow, writeForensicLedgerCsv, writeClassificationCsv, validateForensicPopulation, summarizeCombinedClassification, type ForensicTelemetryRow, type ClassificationRow, type ForensicShadowEventLike } from './g6rCp3hForensicSchema.js';

const STOP_STEP = 57833; // same as the canonical CP3 runner
const OUT_DIR = path.resolve(process.cwd(), 'data/g6r-runs');
const REPO_ROOT = process.cwd();

function sha256File(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}
function sha256Text(text: string): string {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

const REGISTRATION_DOC_PATH = path.resolve(REPO_ROOT, 'data/g6-root-cause-and-candidate-registration.md');
const analyzerSourceHash = sha256File(path.resolve(REPO_ROOT, 'apps/bot/scripts/g6rShadowAnalyzer.ts'));
const registrationDocumentSha256 = sha256File(REGISTRATION_DOC_PATH);

// ============================== Forensic collection state ==============================

const regimeByStep = new Map<string, { regime: MarketRegime; evaluationTimestamp: number; adxDirection1h: 'UP' | 'DOWN' | 'FLAT' | undefined }>();
const forensicRows: ForensicTelemetryRow[] = [];
let futureCandleViolationsCaught = 0;
const futureCandleViolationSamples: Array<{ evaluationId: string; array: string; candleIndex: number; candleTimestamp: number }> = [];
let obPrimaryEvaluations = 0;
let obPrimaryConfirmedRows = 0;
let fallbackActionableRows = 0;
let fallbackRawSlRecoveryFailures = 0;

const analyzer = createG6ShadowOpportunityAnalyzer();
const lookup = (symbol: string, timestamp: number): string => `${symbol}|${timestamp}`;

/** Same real production wilderATRSeries call + period evaluateStage() uses internally — recovers the ATR value it computed but did not return. */
function computeAtr(candles5m: readonly CandleData[]): number {
  const atr = lastDefined(wilderATRSeries(candles5m as CandleData[], RegimeConfig.ATR_PERIOD_5M));
  return atr === undefined ? NaN : atr;
}

function computeCandlesFromEnd(sourceTimestamp: number, mssConfirmedIndex: number | null, candlesMss: readonly CandleData[]): number {
  if (mssConfirmedIndex === null) return NaN;
  const window = candlesMss.filter((c) => c.timestamp >= sourceTimestamp);
  return window.length - 1 - mssConfirmedIndex;
}

function buildProvenance(args: {
  detector5mMaxTimestamp: number;
  mssMaxTimestampRead: number;
  mssMaxAvailableAt: number;
  mssConfirmationTimestamp: number;
  stalenessReferenceTimestamp: number;
  atr5mMaxTimestamp: number;
  macroInputMaxTimestamp: number;
  evaluationCutoffExclusive: number;
}): DecisionFeatureProvenance {
  const detector5mMaxAvailableAt = args.detector5mMaxTimestamp + FIVE_MINUTES_MS;
  const atr5mMaxAvailableAt = args.atr5mMaxTimestamp + FIVE_MINUTES_MS;
  const macroInputMaxAvailableAt = args.macroInputMaxTimestamp + ONE_DAY_MS;
  return {
    detector5mMaxTimestamp: args.detector5mMaxTimestamp,
    detector5mMaxAvailableAt,
    mssMaxTimestampRead: args.mssMaxTimestampRead,
    mssMaxAvailableAt: args.mssMaxAvailableAt,
    mssConfirmationTimestamp: args.mssConfirmationTimestamp,
    stalenessReferenceTimestamp: args.stalenessReferenceTimestamp,
    atr5mMaxTimestamp: args.atr5mMaxTimestamp,
    atr5mMaxAvailableAt,
    macroInputMaxTimestamp: args.macroInputMaxTimestamp,
    macroInputMaxAvailableAt,
    evaluationCutoffExclusive: args.evaluationCutoffExclusive,
    maxRawFeatureTimestamp: Math.max(args.detector5mMaxTimestamp, args.mssMaxTimestampRead, args.atr5mMaxTimestamp, args.macroInputMaxTimestamp),
    maxFeatureAvailableAt: Math.max(detector5mMaxAvailableAt, args.mssMaxAvailableAt, atr5mMaxAvailableAt, macroInputMaxAvailableAt),
  };
}

const hooks: ReplayVariantHooks = {
  onStepContext: (ctx) =>
    regimeByStep.set(lookup(ctx.symbol, ctx.timestamp), { regime: ctx.regime, evaluationTimestamp: ctx.timestamp, adxDirection1h: ctx.adxDirection1h }),
  onBeforeProcessCandle: (ctx) => {
    const shadow = regimeByStep.get(lookup(ctx.symbol, ctx.timestamp));
    if (!shadow) return;
    const cfg = ctx.config.entryRouterConfig;
    const trendStyle = shadow.regime === MarketRegime.TREND_RIDER || (shadow.regime === MarketRegime.NEUTRAL_TRANSITION && cfg.entryStyleForNeutral === 'TREND_STYLE');
    if (!trendStyle) return;

    const candles5m = ctx.input.candles5m;
    const candlesMss = ctx.input.candles1m;
    const macroInputCandles1d = ctx.input.candles1d;
    const now = candles5m[candles5m.length - 1]?.timestamp;
    const evaluationCutoffExclusive = now !== undefined ? now + FIVE_MINUTES_MS : ctx.timestamp + FIVE_MINUTES_MS;
    const id = evaluationId(ctx.symbol, ctx.timestamp, shadow.regime, 0);

    const macroSeries = wilderDIDirectionSeries(macroInputCandles1d, EntryConfig.MACRO_TREND_ADX_PERIOD_1D);
    const macroDirection = macroSeries.length > 0 ? macroSeries[macroSeries.length - 1] : undefined;
    const macroInputMaxTimestamp = macroInputCandles1d.length > 0 ? macroInputCandles1d[macroInputCandles1d.length - 1].timestamp : ctx.timestamp;
    const detector5mMaxTimestamp = candles5m.length > 0 ? candles5m[candles5m.length - 1].timestamp : ctx.timestamp;

    let observation: G6ShadowObservation;
    try {
      observation = analyzer.observeDecision(
        {
          symbol: ctx.symbol,
          candles5m,
          candlesMss,
          macroInputCandles1d,
          adxDirection1h: shadow.adxDirection1h,
          obEnabled: cfg.obEnabled !== false,
          obDisabledSymbols: cfg.obDisabledSymbols,
          obBosLookforwardK: cfg.obBosLookforwardK,
          obSlBufferAtrMultiplier: cfg.obSlBufferAtrMultiplier,
          macroTrendFilterEnabled: cfg.macroTrendFilterEnabled,
          macroDirection,
          evaluationCutoffExclusive,
        },
        { evaluationId: id, regime: shadow.regime, evaluationTimestamp: ctx.timestamp },
      );
    } catch (e) {
      if (e instanceof FutureCandleViolationError) {
        futureCandleViolationsCaught++;
        futureCandleViolationSamples.push({ evaluationId: id, array: e.array, candleIndex: e.candleIndex, candleTimestamp: e.candleTimestamp });
        return; // rejected before ever being evaluated — cannot influence the forensic population
      }
      throw e;
    }

    if (!observation.primaryObFound || observation.blockedByMacroFilter) return;
    obPrimaryEvaluations++;

    const direction: 'BULLISH' | 'BEARISH' = shadow.adxDirection1h === 'UP' ? 'BULLISH' : 'BEARISH';
    const side: 'LONG' | 'SHORT' = direction === 'BULLISH' ? 'LONG' : 'SHORT';

    // ---- (1) OB-primary confirmed (production's own admitted-candidate path) — never persisted before. ----
    const primary = observation.primary;
    if (primary?.mssConfirmed && primary.entryPrice !== null && primary.slPrice !== null && primary.sourceTimestamp !== null && primary.mssConfirmedIndex !== null && primary.mssConfirmationTimestamp !== null && primary.provenancePartial) {
      const ob = cfg.obEnabled !== false ? detectOrderBlock(candles5m as CandleData[], direction, { fractalN: EntryConfig.FRACTAL_N, lookforwardK: cfg.obBosLookforwardK }) : null;
      if (ob) {
        const rawSlPrice = direction === 'BULLISH' ? ob.low : ob.high;
        const atr = computeAtr(candles5m);
        const bufferAmount = atr * cfg.obSlBufferAtrMultiplier;
        const candlesFromEnd = computeCandlesFromEnd(primary.sourceTimestamp, primary.mssConfirmedIndex, candlesMss);
        const p = primary.provenancePartial;
        const atr5mMaxTimestamp = p.atr5mMaxTimestamp ?? detector5mMaxTimestamp;
        const cKey = makeCandidateKey(ctx.symbol, side, 'OB', primary.mssConfirmationTimestamp, primary.sourceTimestamp);
        const slDistance = Math.abs(primary.entryPrice - primary.slPrice);
        // TICKET-G6R-CP3HR2 Task 4: typed as ForensicShadowEventLike (setupType: ForensicSetupType =
        // 'OB'|'FVG'|'SWEEP'), NOT FrozenShadowEvent (setupType: 'FVG'|'SWEEP' only) — so setupType:
        // 'OB' is a direct, safely-typed literal here, never a disguised/cast value. This event is
        // never written to the canonical g6r-cp3-shadow-candidates.csv ledger, only into this
        // module's own CP3H-only forensic row via assembleForensicRow(), which accepts
        // ForensicShadowEventLike directly.
        const event: ForensicShadowEventLike = {
          candidateKey: cKey,
          evaluationId: id,
          symbol: ctx.symbol,
          side,
          regime: shadow.regime,
          setupType: 'OB',
          sourceTimestamp: primary.sourceTimestamp,
          evaluationTimestamp: ctx.timestamp,
          decisionTimestamp: primary.mssConfirmationTimestamp,
          entryPrice: primary.entryPrice,
          slPrice: primary.slPrice,
          slDistance,
          provenance: buildProvenance({
            detector5mMaxTimestamp,
            mssMaxTimestampRead: p.mssMaxTimestampRead,
            mssMaxAvailableAt: p.mssMaxAvailableAt,
            mssConfirmationTimestamp: primary.mssConfirmationTimestamp,
            stalenessReferenceTimestamp: p.stalenessReferenceTimestamp,
            atr5mMaxTimestamp,
            macroInputMaxTimestamp,
            evaluationCutoffExclusive,
          }),
        };
        forensicRows.push(
          assembleForensicRow({
            event,
            rawSlPrice,
            atr,
            bufferAmount,
            candlesFromEnd,
            mssConfirmed: true,
            mssFailReason: null,
            primaryObFound: true,
            blockedByMacroFilter: false,
            registrationDocumentSha256,
            analyzerSourceHash,
            evaluationIdSchemaValid: validateEvaluationIdSchema(id),
            candidateKeySchemaValid: cKey === makeCandidateKey(ctx.symbol, side, 'OB', event.decisionTimestamp, event.sourceTimestamp),
          }),
        );
        obPrimaryConfirmedRows++;
      }
    }

    // ---- (2) Fallback actionable candidate (canonical CP3's own population: FVG or SWEEP). ----
    if (observation.actionableShadowEvent) {
      const ev = observation.actionableShadowEvent;
      let rawSlPrice = NaN;
      let stage = observation.fvgFallback;
      if (ev.setupType === 'FVG') {
        const fvg = detectFairValueGap(candles5m as CandleData[], direction);
        if (fvg) rawSlPrice = direction === 'BULLISH' ? fvg.bottom : fvg.top;
        stage = observation.fvgFallback;
      } else {
        const sweep = detectLiquiditySweep(candles5m as CandleData[], direction, { fractalN: EntryConfig.FRACTAL_N, wickRatioThreshold: EntryConfig.LIQUIDITY_SWEEP_WICK_RATIO_THRESHOLD });
        if (sweep) {
          const sweepCandle = candles5m[sweep.candleIndex];
          rawSlPrice = direction === 'BULLISH' ? sweepCandle.low : sweepCandle.high;
        }
        stage = observation.sweepFallback;
      }
      if (!Number.isFinite(rawSlPrice) || !stage || stage.mssConfirmedIndex === null) {
        fallbackRawSlRecoveryFailures++;
      } else {
        const atr = computeAtr(candles5m);
        const bufferAmount = atr * EntryConfig.SL_BUFFER_ATR_MULTIPLIER;
        const candlesFromEnd = computeCandlesFromEnd(ev.sourceTimestamp, stage.mssConfirmedIndex, candlesMss);
        forensicRows.push(
          assembleForensicRow({
            event: ev,
            rawSlPrice,
            atr,
            bufferAmount,
            candlesFromEnd,
            mssConfirmed: true,
            mssFailReason: null,
            primaryObFound: true,
            blockedByMacroFilter: false,
            registrationDocumentSha256,
            analyzerSourceHash,
            evaluationIdSchemaValid: validateEvaluationIdSchema(id),
            candidateKeySchemaValid: ev.candidateKey === makeCandidateKey(ev.symbol, ev.side, ev.setupType, ev.decisionTimestamp, ev.sourceTimestamp),
          }),
        );
        fallbackActionableRows++;
      }
    }
  },
};

async function main(): Promise<void> {
  const config = { ...buildBaselineConfig(), sameSideDuplicateGuardEnabled: true };
  const replayResult = await runReplay(config, makeFillModel('CENTRAL', 2 / 10000, 2 / 10000), STOP_STEP, hooks);

  // ---- CP2 join set ----
  const cp2EvaluationsRaw = readFileSync(path.resolve(REPO_ROOT, 'data/g6r-runs/g6r-cp2-evaluations.csv'), 'utf8');
  const cp2Parsed = parseLedgerCsvRequiringEvaluationId(cp2EvaluationsRaw);
  const cp2EvaluationIds = new Set(cp2Parsed.rows.map((r) => r.evaluationId));

  const populationResult = validateForensicPopulation(forensicRows, cp2EvaluationIds);
  const combinedBreakdown = summarizeCombinedClassification(forensicRows);

  mkdirSync(OUT_DIR, { recursive: true });
  const ledgerCsv = writeForensicLedgerCsv(forensicRows);
  writeFileSync(path.join(OUT_DIR, 'g6r-cp3h-shadow-forensic-ledger.csv'), ledgerCsv);

  const classificationRows: ClassificationRow[] = forensicRows.map((r) => ({ candidateKey: r.candidateKey, evaluationId: r.evaluationId, timestampClass: r.timestampClass, geometryClass: r.geometryClass, combinedClass: r.combinedClass }));
  writeFileSync(path.join(OUT_DIR, 'g6r-cp3h-classification.csv'), writeClassificationCsv(classificationRows));

  const summary = {
    status: populationResult.valid ? 'FORENSIC_COMPLETE' : 'FORENSIC_INVALID',
    stopStep: STOP_STEP,
    tradesInReplay: replayResult.trades.length,
    obPrimaryEvaluations,
    obPrimaryConfirmedRows,
    fallbackActionableRows,
    fallbackRawSlRecoveryFailures,
    futureCandleViolationsCaught,
    futureCandleViolationSamples: futureCandleViolationSamples.slice(0, 20),
    totalForensicRows: forensicRows.length,
    populationValidation: populationResult,
    combinedBreakdown,
    ledgerCsvSha256: sha256Text(ledgerCsv),
    analyzerSourceHash,
    registrationDocumentSha256,
  };
  writeFileSync(path.join(OUT_DIR, 'g6r-cp3h-summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify({ status: summary.status, totalForensicRows: forensicRows.length, obPrimaryConfirmedRows, fallbackActionableRows, fallbackRawSlRecoveryFailures }, null, 2));

  const tradesForParity = replayResult.trades.map((t) => ({ entryTimestamp: t.entryTimestamp, symbol: t.symbol, side: t.side }));
  writeFileSync(path.join(OUT_DIR, 'g6r-cp3h-replay-trades.json'), JSON.stringify(tradesForParity) + '\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
