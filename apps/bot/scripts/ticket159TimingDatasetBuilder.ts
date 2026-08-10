/**
 * TICKET-159 Step 1 — Unified MOMENTUM_DIRECT timing dataset (READ-ONLY research script).
 *
 * Reruns the frozen OB-disabled Central replay (via ticket150's runReplay/buildBaselineConfig,
 * unchanged) to recover each MOMENTUM_DIRECT trade's full ClosedTrade record (including slPrice,
 * which the ticket157 ledger CSV does not export). For each trade this computes:
 *   - decision-time features (frozen trigger, entry extension, structural boundary, available
 *     reward, candle shape, consecutive-direction run, concurrent same-side exposure) using only
 *     5m candles with timestamp <= entryTimestamp (the decision candle itself), and
 *   - post-entry outcome features (MFE/MAE, time-to-R milestones, realized R) using only 1m
 *     candles strictly after entryTimestamp up to and including exitTimestamp.
 *
 * Anti-leakage invariant: no feature ever reads a candle later than its own decision or outcome
 * window boundary. Same-candle conflicting-level touches (a single 1m candle whose range contains
 * both the SL and a TP/R milestone) are flagged `sameCandleAmbiguous` rather than ordered by guess.
 */
import { writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { buildBaselineConfig, runReplay, makeFillModel, type ClosedTrade } from './ticket150BacktestExecutionRealismAudit.js';
import { detectSwingPoints, latestSwingPointBefore } from '../dist/entry/detectors/swingPoints.js';
import { wilderATRSeries } from '../dist/regime/indicators.js';
import { RegimeConfig } from '../dist/regime/config.js';
import { EntryConfig } from '../dist/entry/config.js';
import type { CandleData } from '../dist/regime/types.js';

const OHLCV_DIR = path.resolve(process.cwd(), 'data/ohlcv');
const OUT_DIR = path.resolve(process.cwd(), 'data');
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'];

function readCsv(filePath: string): CandleData[] {
  const lines = readFileSync(filePath, 'utf-8').trim().split('\n');
  return lines.slice(1).map((line: string) => {
    const [timestampUtc, , open, high, low, close, volume] = line.split(',');
    return { timestamp: Number(timestampUtc), open: Number(open), high: Number(high), low: Number(low), close: Number(close), volume: Number(volume) };
  });
}

interface SymbolSeries {
  candles5m: CandleData[];
  candles1m: CandleData[];
}

function loadAllSymbols(): Record<string, SymbolSeries> {
  const out: Record<string, SymbolSeries> = {};
  for (const symbol of SYMBOLS) {
    out[symbol] = {
      candles5m: readCsv(path.join(OHLCV_DIR, `${symbol}_5m.csv`)),
      candles1m: readCsv(path.join(OHLCV_DIR, `${symbol}_1m.csv`)),
    };
  }
  return out;
}

/** Decision-time slice: every 5m candle whose timestamp is <= the decision candle's own timestamp. */
function decisionWindow5m(candles5m: CandleData[], entryTimestamp: number): { window: CandleData[]; index: number } {
  const index = candles5m.findIndex((c) => c.timestamp === entryTimestamp);
  if (index < 0) return { window: [], index: -1 };
  return { window: candles5m.slice(0, index + 1), index };
}

interface DecisionFeatures {
  triggerLevel: number | null;
  triggerTimestamp: number | null;
  atr14: number | null;
  extensionAtr: number | null;
  bodyRange: number;
  wickRatio: number;
  consecutiveDirectionalCandles: number;
  shortWindowReturnAtr: number | null;
  structuralBoundary: number | null;
  availableRewardR: number | null;
  plannedRiskR: number;
  plannedTpR: number;
  concurrentSameSideCount: number;
  concurrentSymbolCount: number;
}

/** Frozen decision-time geometry, computed only from candles up to and including the decision candle. */
function computeDecisionFeatures(
  candles5mUpToDecision: CandleData[],
  side: 'LONG' | 'SHORT',
  entryPrice: number,
  slPrice: number,
  tpRMultiple: number,
  concurrentSameSideCount: number,
  concurrentSymbolCount: number,
): DecisionFeatures {
  const decisionIndex = candles5mUpToDecision.length - 1;
  const decisionCandle = candles5mUpToDecision[decisionIndex];
  const range = decisionCandle.high - decisionCandle.low;
  const body = Math.abs(decisionCandle.close - decisionCandle.open);
  const wickRatio = range > 0 ? 1 - body / range : 0;

  const atrSeries = wilderATRSeries(candles5mUpToDecision, RegimeConfig.ATR_PERIOD_5M);
  const atr14 = atrSeries[atrSeries.length - 1] ?? null;

  const swings = detectSwingPoints(candles5mUpToDecision, EntryConfig.FRACTAL_N);
  const trigger = latestSwingPointBefore(swings, side === 'LONG' ? 'HIGH' : 'LOW', decisionIndex);
  const extensionAtr =
    trigger !== null && atr14 !== null && atr14 > 0
      ? (side === 'LONG' ? entryPrice - trigger.price : trigger.price - entryPrice) / atr14
      : null;

  const forwardBoundaries = swings
    .filter((point) => point.index < decisionIndex && (side === 'LONG' ? point.type === 'HIGH' && point.price > entryPrice : point.type === 'LOW' && point.price < entryPrice))
    .map((point) => point.price);
  const structuralBoundary = forwardBoundaries.length === 0 ? null : side === 'LONG' ? Math.min(...forwardBoundaries) : Math.max(...forwardBoundaries);
  const plannedRiskR = Math.abs(entryPrice - slPrice);
  const reward = structuralBoundary === null ? null : side === 'LONG' ? structuralBoundary - entryPrice : entryPrice - structuralBoundary;
  const availableRewardR = plannedRiskR > 0 && reward !== null ? reward / plannedRiskR : null;

  // Consecutive same-direction closed candles ending at the decision candle (direction = close vs open).
  let consecutiveDirectionalCandles = 0;
  for (let i = decisionIndex; i >= 0; i--) {
    const candle = candles5mUpToDecision[i];
    const isDirectional = side === 'LONG' ? candle.close > candle.open : candle.close < candle.open;
    if (!isDirectional) break;
    consecutiveDirectionalCandles++;
  }

  const lookback = 6;
  const startIndex = Math.max(0, decisionIndex - lookback);
  const shortWindowReturnAtr =
    atr14 !== null && atr14 > 0 ? (decisionCandle.close - candles5mUpToDecision[startIndex].close) / atr14 : null;

  return {
    triggerLevel: trigger?.price ?? null,
    triggerTimestamp: trigger !== null ? candles5mUpToDecision[trigger.index].timestamp : null,
    atr14,
    extensionAtr,
    bodyRange: range > 0 ? body / range : 0,
    wickRatio,
    consecutiveDirectionalCandles,
    shortWindowReturnAtr,
    structuralBoundary,
    availableRewardR,
    plannedRiskR,
    plannedTpR: tpRMultiple,
    concurrentSameSideCount,
    concurrentSymbolCount,
  };
}

interface OutcomeFeatures {
  mfeR: number;
  maeR: number;
  mfeAtr: number | null;
  maeAtr: number | null;
  timeToR025Min: number | null;
  timeToR050Min: number | null;
  timeToR1Min: number | null;
  timeToExitMin: number;
  favorableFirst: boolean | null;
  adverseFirst: boolean | null;
  sameCandleAmbiguous: boolean;
  immediatePullbackDepthR: number;
  realizedR: number;
  mfeCaptureRatio: number | null;
}

/** Post-entry excursion computed only from 1m candles strictly after entryTimestamp, up to exitTimestamp. */
function computeOutcomeFeatures(
  candles1m: CandleData[],
  side: 'LONG' | 'SHORT',
  entryPrice: number,
  slPrice: number,
  entryTimestamp: number,
  exitTimestamp: number,
  netExitPrice: number,
  plannedRiskR: number,
): OutcomeFeatures {
  const window = candles1m.filter((c) => c.timestamp > entryTimestamp && c.timestamp <= exitTimestamp);
  const risk = plannedRiskR > 0 ? plannedRiskR : Math.abs(entryPrice - slPrice) || 1;

  let mfe = 0; // best favorable excursion, price units
  let mae = 0; // worst adverse excursion, price units
  let timeToR025: number | null = null;
  let timeToR050: number | null = null;
  let timeToR1: number | null = null;
  let sameCandleAmbiguous = false;
  let firstTouchDirection: 'FAVORABLE' | 'ADVERSE' | null = null;
  let immediatePullbackDepth = 0;

  for (const candle of window) {
    const favorableExtreme = side === 'LONG' ? candle.high - entryPrice : entryPrice - candle.low;
    const adverseExtreme = side === 'LONG' ? entryPrice - candle.low : candle.high - entryPrice;
    mfe = Math.max(mfe, favorableExtreme);
    mae = Math.max(mae, adverseExtreme);

    // Same-candle ambiguity: one candle's range covers both a meaningfully favorable AND a
    // meaningfully adverse excursion (>= 0.25R each) — intrabar ordering cannot be resolved from
    // OHLC alone, so do not guess which one happened first.
    if (favorableExtreme >= 0.25 * risk && adverseExtreme >= 0.25 * risk) sameCandleAmbiguous = true;

    if (firstTouchDirection === null) {
      const touchesFavorable = favorableExtreme >= 0.25 * risk;
      const touchesAdverse = adverseExtreme >= 0.25 * risk;
      if (touchesFavorable && !touchesAdverse) firstTouchDirection = 'FAVORABLE';
      else if (touchesAdverse && !touchesFavorable) firstTouchDirection = 'ADVERSE';
      // if both/neither touch this candle, leave unresolved and let a later candle decide
    }

    const minutesElapsed = (candle.timestamp - entryTimestamp) / 60_000;
    if (timeToR025 === null && favorableExtreme >= 0.25 * risk) timeToR025 = minutesElapsed;
    if (timeToR050 === null && favorableExtreme >= 0.5 * risk) timeToR050 = minutesElapsed;
    if (timeToR1 === null && favorableExtreme >= 1.0 * risk) timeToR1 = minutesElapsed;
  }

  // Immediate pullback depth: adverse excursion within the first 3 closed 1m candles after entry.
  const immediateWindow = window.slice(0, 3);
  for (const candle of immediateWindow) {
    const adverseExtreme = side === 'LONG' ? entryPrice - candle.low : candle.high - entryPrice;
    immediatePullbackDepth = Math.max(immediatePullbackDepth, adverseExtreme);
  }

  const realizedPriceMove = side === 'LONG' ? netExitPrice - entryPrice : entryPrice - netExitPrice;
  const realizedR = risk > 0 ? realizedPriceMove / risk : 0;
  const mfeR = risk > 0 ? mfe / risk : 0;
  const maeR = risk > 0 ? mae / risk : 0;

  return {
    mfeR,
    maeR,
    mfeAtr: null, // filled by caller once decision-time atr14 is known
    maeAtr: null,
    timeToR025Min: timeToR025,
    timeToR050Min: timeToR050,
    timeToR1Min: timeToR1,
    timeToExitMin: (exitTimestamp - entryTimestamp) / 60_000,
    favorableFirst: sameCandleAmbiguous ? null : firstTouchDirection === 'FAVORABLE' ? true : firstTouchDirection === 'ADVERSE' ? false : null,
    adverseFirst: sameCandleAmbiguous ? null : firstTouchDirection === 'ADVERSE' ? true : firstTouchDirection === 'FAVORABLE' ? false : null,
    sameCandleAmbiguous,
    immediatePullbackDepthR: risk > 0 ? immediatePullbackDepth / risk : 0,
    realizedR,
    mfeCaptureRatio: mfeR > 0 ? realizedR / mfeR : null,
  };
}

function csv(rows: Record<string, unknown>[]): string {
  const headers = Object.keys(rows[0] ?? {});
  const escape = (value: unknown) => {
    const text = value === null || value === undefined ? '' : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [headers.join(','), ...rows.map((row) => headers.map((header) => escape(row[header])).join(','))].join('\n') + '\n';
}

async function main() {
  // OB-disabled recipe copied verbatim from ticket157RunVariantScenario.ts's own OB_DISABLED branch
  // (obDisabledSymbols, not obEnabled:false) — this is the exact recipe that produced the frozen
  // 264-trade/139-MOMENTUM_DIRECT population being reproduced here.
  const cfg = { ...buildBaselineConfig(), sameSideDuplicateGuardEnabled: true };
  cfg.entryRouterConfig = { ...cfg.entryRouterConfig, obDisabledSymbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'] };
  // The frozen 264-trade population is specifically the CENTRAL cost/fill scenario (2bps slippage +
  // 2bps spread) — full path-dependent simulation means account-balance/sizing gates cascade from
  // fill price, so a fee-only (fillModel=null) replay produces a DIFFERENT trade set (confirmed by a
  // first attempt: 268 trades/145 MOMENTUM_DIRECT instead of 264/139). Must match ticket157's own
  // OB_DISABLED-CENTRAL recipe exactly: same fill model label pattern, same 57_833 stop checkpoint.
  const fillModel = makeFillModel('OB_DISABLED-CENTRAL', 2 / 10_000, 2 / 10_000);
  const replay = await runReplay(cfg, fillModel, 57_833);

  const slippedPnl = (t: ClosedTrade) => replay.slippedPnlByEntryTs.get(`${t.symbol}|${t.entryTimestamp}`) ?? t.pnlUsdTheoretical;
  const reproducedTrades = replay.trades.length;
  const reproducedNetPnlCentral = replay.trades.reduce((sum, t) => sum + slippedPnl(t), 0);
  console.log(`Reproduced replay: ${reproducedTrades} trades (frozen ledger has 264), net PnL (Central cost) = ${reproducedNetPnlCentral} (frozen = 606.6195245715165).`);

  const momentumTrades = replay.trades.filter((t: ClosedTrade) => t.setupType === 'MOMENTUM_DIRECT');
  console.log(`MOMENTUM_DIRECT trades: ${momentumTrades.length} (frozen ledger has 139)`);

  const seriesBySymbol = loadAllSymbols();
  const rows: Record<string, unknown>[] = [];

  for (const trade of momentumTrades) {
    const series = seriesBySymbol[trade.symbol];
    const { window: decisionCandles } = decisionWindow5m(series.candles5m, trade.entryTimestamp);
    if (decisionCandles.length === 0) continue;

    const concurrentSameSide = momentumTrades.filter(
      (other) =>
        other !== trade &&
        other.side === trade.side &&
        other.symbol !== trade.symbol &&
        other.entryTimestamp <= trade.entryTimestamp &&
        other.exitTimestamp > trade.entryTimestamp,
    ).length;
    const concurrentAny = replay.trades.filter(
      (other) => other !== trade && other.entryTimestamp <= trade.entryTimestamp && other.exitTimestamp > trade.entryTimestamp,
    ).length;

    const decisionFeatures = computeDecisionFeatures(
      decisionCandles,
      trade.side,
      trade.entryPriceTheoretical,
      trade.slPrice,
      trade.side === 'LONG' ? 3.0 : 3.0, // momentumDirectTpRMultiple, frozen baseline config value
      concurrentSameSide,
      concurrentAny,
    );
    const outcomeFeatures = computeOutcomeFeatures(
      series.candles1m,
      trade.side,
      trade.entryPriceTheoretical,
      trade.slPrice,
      trade.entryTimestamp,
      trade.exitTimestamp,
      trade.exitPriceTheoretical,
      decisionFeatures.plannedRiskR,
    );
    if (decisionFeatures.atr14 !== null && decisionFeatures.atr14 > 0) {
      outcomeFeatures.mfeAtr = (outcomeFeatures.mfeR * decisionFeatures.plannedRiskR) / decisionFeatures.atr14;
      outcomeFeatures.maeAtr = (outcomeFeatures.maeR * decisionFeatures.plannedRiskR) / decisionFeatures.atr14;
    }

    rows.push({
      orderId: `${trade.symbol}-${trade.entryTimestamp}`,
      symbol: trade.symbol,
      side: trade.side,
      regime: trade.regime,
      entryTimestamp: trade.entryTimestamp,
      exitTimestamp: trade.exitTimestamp,
      entryPrice: trade.entryPriceTheoretical,
      exitPrice: trade.exitPriceTheoretical,
      exitReason: trade.exitReason,
      slPrice: trade.slPrice,
      ...decisionFeatures,
      ...outcomeFeatures,
      realizedPnlTheoretical: trade.pnlUsdTheoretical,
      realizedPnlCentralCost: slippedPnl(trade),
    });
  }

  writeFileSync(path.join(OUT_DIR, 'ticket159-timing-dataset.csv'), csv(rows));

  const ambiguousCount = rows.filter((r) => r.sameCandleAmbiguous).length;
  console.log(`Wrote ${rows.length} MOMENTUM_DIRECT timing rows. Same-candle-ambiguous: ${ambiguousCount}.`);

  writeFileSync(
    path.join(OUT_DIR, 'ticket159-reproduction-check.json'),
    JSON.stringify(
      {
        reproducedTrades,
        expectedTrades: 264,
        tradeCountMatches: reproducedTrades === 264,
        momentumDirectTrades: momentumTrades.length,
        expectedMomentumDirectTrades: 139,
        momentumDirectCountMatches: momentumTrades.length === 139,
        expectedNetPnlCentral: 606.6195245715165,
        netPnlMatches: Math.abs(reproducedNetPnlCentral - 606.6195245715165) < 0.01,
        reproducedNetPnlCentral,
      },
      null,
      2,
    ) + '\n',
  );
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
