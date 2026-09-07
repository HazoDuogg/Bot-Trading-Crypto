import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Candle } from '../engine/noTradeZone/types.js';
import { computeAtr } from '../engine/noTradeZone/atr.js';
import { computeMeanReversionSignals } from '../../core/entry/meanReversionSignal.js';
import { createMeanReversionTradePlan, MEAN_REVERSION_TIME_STOP_M5_CANDLES } from '../../core/risk/meanReversionTradePlan.js';
import type { TradePlan } from '../../core/risk/tradePlan.js';
import { simulateLimitFill } from '../engine/limitFillSimulation.js';
import {
  BINANCE_USDM_VIP0_BNB_DISCOUNT_MAKER_FEE_RATE,
  BINANCE_USDM_VIP0_BNB_DISCOUNT_TAKER_FEE_RATE,
  DEFAULT_ADVERSE_SLIPPAGE_RATE,
  calculateFundingCost,
  type FundingRateEvent,
} from '../engine/costModel.js';
import { DEFAULT_COIN_BACKTEST_CONFIG } from './runNukidaBacktest.js';
import { SYNTHETIC_HALF_SPREAD_USD, SYNTHETIC_HALF_SPREAD_SOURCE } from '../../config/syntheticSpread.js';

// TICKET-04X-S: end-to-end mean-reversion backtest (regime -> signal -> fill -> exit -> real PnL)
// over the full 3-year BTC dataset. This is an OHLC + synthetic-spread SIMULATION, not a replay of
// real post-only order-book fills: entry/TP prices are synthesized as `close +/- H` (H locked once
// in config/syntheticSpread.ts from real bookTicker data, TICKET-04X-S Step 0), and TICKET-04X-Q
// already measured this OHLC-fill-simulation approach against real tick data on 3 stress weeks and
// found it materially optimistic — ~14% of real fills never show up in OHLC simulation, and where
// both agree on a fill, OHLC simulation is ~17x slower to reach it than reality. Every fill/no-fill
// count in this file inherits that same known bias; see `knownBiasWarning` in the output file.
//
// KNOWN DEVIATIONS FROM THE TICKET TEXT, FLAGGED AND AGREED BEFORE WRITING THIS FILE:
// 1. Fee/slippage are computed manually from costModel.ts's raw MAKER/TAKER fee-rate and
//    slippage-rate constants, NOT via calculateExecutionCosts() as the ticket literally says.
//    calculateExecutionCosts() bakes in its own OHLC-range spread proxy (SPREAD_PROXY_M1_RANGE_
//    FRACTION) on every trade regardless of exit reason — a leftover from before real spread data
//    existed. Since this backtest already prices the REAL spread by baking H directly into entry/
//    TP prices, calling that function unmodified would double-count spread cost. Bypassing its body
//    (while still reusing its underlying rate constants) avoids that double count.
// 2. config/syntheticSpread.ts is a TS module, not syntheticSpread.json — every other locked
//    constant in this codebase (BREAKEVEN_*, MEAN_REVERSION_*, BINANCE_USDM_VIP0_*) is a plain
//    exported TS const, not a JSON file; the ticket said "config/syntheticSpread.json (hoặc tương
//    tự)", and a TS module is the "tương tự" alternative that matches every existing precedent.
const M15_MS = 15 * 60 * 1000;
const M5_MS = 5 * 60 * 1000;
const ATR_PERIOD = 14;
const ENTRY_TTL_M1_CANDLES = 5;
const ENTRY_FILL_TICK_BUFFER_N = 1; // locked in TICKET-04X-M
const RISK_BUDGET_USD = 3; // matches MEAN_REVERSION_TP_R_MULTIPLE=8/3's own $8-on-$3 convention
const TARGET_NET_PROFIT_USD = 8;
const { tickSize: TICK_SIZE, lotSize: LOT_SIZE, leverage: LEVERAGE } = DEFAULT_COIN_BACKTEST_CONFIG.BTCUSDT;

type ExitReason = 'TAKE_PROFIT' | 'STOP_LOSS' | 'AMBIGUOUS_FORCED_LOSS' | 'TIME_STOP';
type NonTradeReason = 'EXPIRED' | 'TRADE_PLAN_REJECTED' | 'NO_EXIT_DATA';

interface CostBreakdown {
  grossUsd: number;
  entryFeeUsd: number;
  exitFeeUsd: number;
  slippageUsd: number;
  fundingUsd: number;
  fundingEventsApplied: number;
  netUsd: number;
  netR: number;
}

interface TradeRecord {
  m5Index: number;
  direction: 'LONG' | 'SHORT';
  m5CloseTime: number;
  signalCloseC: number;
  limitPrice: number;
  outcome: ExitReason | NonTradeReason;
  entry?: {
    fillTimestamp: number;
    fillPrice: number;
  };
  tradePlan?: TradePlan;
  exit?: {
    timestamp: number;
    price: number;
  };
  costs?: CostBreakdown;
}

async function loadCsv(csvPath: string): Promise<Candle[]> {
  const rows = (await readFile(csvPath, 'utf8')).trim().split(/\r?\n/u).slice(1);
  return rows.map((row) => {
    const [openTime, open, high, low, close, volume] = row.split(',').map(Number);
    return { openTime, open, high, low, close, volume } satisfies Candle;
  });
}

async function loadFundingEvents(csvPath: string): Promise<FundingRateEvent[]> {
  const rows = (await readFile(csvPath, 'utf8')).trim().split(/\r?\n/u).slice(1);
  return rows.map((row) => {
    const [fundingTime, fundingRate, markPrice] = row.split(',');
    return { fundingTime: Number(fundingTime), fundingRate: Number(fundingRate), markPrice: Number(markPrice) };
  });
}

// Lower-bound binary search: first index with openTime >= timestamp.
function firstIndexAtOrAfter(candles: readonly Candle[], timestamp: number): number {
  let left = 0;
  let right = candles.length;
  while (left < right) {
    const mid = (left + right) >>> 1;
    if (candles[mid].openTime < timestamp) left = mid + 1;
    else right = mid;
  }
  return left;
}

function computeCosts(input: {
  direction: 'LONG' | 'SHORT';
  positionSize: number;
  entryFillPrice: number;
  entryFillTimestamp: number;
  exitReason: ExitReason;
  exitPrice: number;
  exitTimestamp: number;
  riskPerUnit: number;
  fundingEvents: readonly FundingRateEvent[];
}): CostBreakdown {
  const sign = input.direction === 'LONG' ? 1 : -1;
  const grossUsd = sign * (input.exitPrice - input.entryFillPrice) * input.positionSize;

  const entryFeeUsd = input.entryFillPrice * input.positionSize * BINANCE_USDM_VIP0_BNB_DISCOUNT_MAKER_FEE_RATE;
  const isTakeProfit = input.exitReason === 'TAKE_PROFIT';
  const exitFeeRate = isTakeProfit ? BINANCE_USDM_VIP0_BNB_DISCOUNT_MAKER_FEE_RATE : BINANCE_USDM_VIP0_BNB_DISCOUNT_TAKER_FEE_RATE;
  const exitFeeUsd = input.exitPrice * input.positionSize * exitFeeRate;
  // TIME_STOP's exit price already had H + slippage baked in at the price level (see
  // buildTimeStopExitPrice below) — adding a second additive slippageUsd term here would double
  // count. SL/AMBIGUOUS_FORCED_LOSS exit at the untouched stopLoss price level, so their slippage
  // is charged here as an additive cost, matching calculateExecutionCosts()'s own STOP_LOSS
  // convention (just computed manually to avoid that function's stale spread-proxy term).
  const slippageUsd =
    input.exitReason === 'STOP_LOSS' || input.exitReason === 'AMBIGUOUS_FORCED_LOSS'
      ? input.exitPrice * input.positionSize * DEFAULT_ADVERSE_SLIPPAGE_RATE
      : 0;

  const funding = calculateFundingCost({
    direction: input.direction === 'LONG' ? 'BULL' : 'BEAR',
    positionSize: input.positionSize,
    entryFillTime: input.entryFillTimestamp,
    exitTime: input.exitTimestamp,
    fundingEvents: input.fundingEvents,
  });

  const netUsd = grossUsd - entryFeeUsd - exitFeeUsd - slippageUsd - funding.fundingUsd;
  const riskUsd = input.riskPerUnit * input.positionSize;
  return {
    grossUsd,
    entryFeeUsd,
    exitFeeUsd,
    slippageUsd,
    fundingUsd: funding.fundingUsd,
    fundingEventsApplied: funding.eventsApplied,
    netUsd,
    netR: netUsd / riskUsd,
  };
}

// TICKET-04X-S Step 2: TP solved exactly so net-of-maker-fee profit equals TARGET_NET_PROFIT_USD,
// replacing the old MEAN_REVERSION_TP_R_MULTIPLE=8/3 approximation with the same $8-on-$3 target,
// now exact after fees (algebra in the ticket text; verified by hand before implementing).
function solveExactTakeProfit(direction: 'LONG' | 'SHORT', entryFillPrice: number, positionSize: number): number {
  const fee = BINANCE_USDM_VIP0_BNB_DISCOUNT_MAKER_FEE_RATE;
  if (direction === 'LONG') {
    return (TARGET_NET_PROFIT_USD + positionSize * entryFillPrice * (1 + fee)) / (positionSize * (1 - fee));
  }
  return (positionSize * entryFillPrice * (1 - fee) - TARGET_NET_PROFIT_USD) / (positionSize * (1 + fee));
}

async function main(): Promise<void> {
  const dataDirectory = fileURLToPath(new URL('../../data/', import.meta.url));
  const reportsDirectory = fileURLToPath(new URL('../../reports/', import.meta.url));

  console.info('Loading CSVs...');
  const m15Candles = await loadCsv(resolve(dataDirectory, 'BTCUSDT_15m_3y.csv'));
  const m5Candles = await loadCsv(resolve(dataDirectory, 'BTCUSDT_5m_3y.csv'));
  const m1Candles = await loadCsv(resolve(dataDirectory, 'BTCUSDT_rt094_1m.csv'));
  const fundingEvents = await loadFundingEvents(resolve(dataDirectory, 'BTCUSDT_funding_3y.csv'));
  console.info(`  M15=${m15Candles.length} M5=${m5Candles.length} M1=${m1Candles.length} funding=${fundingEvents.length}`);

  console.info(`Synthetic half-spread H = ${SYNTHETIC_HALF_SPREAD_USD} (${SYNTHETIC_HALF_SPREAD_SOURCE.method})`);

  const signals = computeMeanReversionSignals(m15Candles, m5Candles, M15_MS, M5_MS);
  const atrSeries = computeAtr(m5Candles, ATR_PERIOD); // atrSeries[k] -> m5Candles[k + ATR_PERIOD]

  const trades: TradeRecord[] = [];
  let processed = 0;

  for (let i = 0; i < m5Candles.length; i += 1) {
    const signal = signals[i];
    if (signal.signal === 'NONE') continue;
    processed += 1;

    const direction = signal.signal;
    const m5CloseTime = m5Candles[i].openTime + M5_MS;
    const C = m5Candles[i].close;
    const limitPrice = direction === 'LONG' ? C - SYNTHETIC_HALF_SPREAD_USD : C + SYNTHETIC_HALF_SPREAD_USD;

    const record: TradeRecord = { m5Index: i, direction, m5CloseTime, signalCloseC: C, limitPrice, outcome: 'EXPIRED' };

    const windowStart = firstIndexAtOrAfter(m1Candles, m5CloseTime);
    const entryWindow = m1Candles.slice(windowStart, windowStart + ENTRY_TTL_M1_CANDLES);
    if (entryWindow.length === 0) {
      record.outcome = 'NO_EXIT_DATA'; // ran off the end of the dataset before even an entry window existed
      trades.push(record);
      continue;
    }

    const fill = simulateLimitFill({
      limitPrice,
      direction: direction === 'LONG' ? 'BULL' : 'BEAR',
      m1Candles: entryWindow,
      tickSize: TICK_SIZE,
      n: ENTRY_FILL_TICK_BUFFER_N,
    });
    if (!fill.filled) {
      record.outcome = 'EXPIRED';
      trades.push(record);
      continue;
    }

    const entryFillPrice = fill.fillPrice!;
    const entryFillIndex = windowStart + fill.filledAtIndex!;
    const entryFillTimestamp = fill.filledAtTimestamp!;
    record.entry = { fillTimestamp: entryFillTimestamp, fillPrice: entryFillPrice };

    const atr14 = i >= ATR_PERIOD ? atrSeries[i - ATR_PERIOD] : undefined;
    if (atr14 === undefined) {
      // Should not happen: signal!=NONE implies zScore!=null implies i>=ZSCORE_LOOKBACK(20)>ATR_PERIOD(14).
      record.outcome = 'TRADE_PLAN_REJECTED';
      trades.push(record);
      continue;
    }

    const rawPlan = createMeanReversionTradePlan({
      signal: direction,
      entryPrice: entryFillPrice,
      atr14,
      riskBudgetUsd: RISK_BUDGET_USD,
      leverage: LEVERAGE,
      tickSize: TICK_SIZE,
      lotSize: LOT_SIZE,
    });
    if (rawPlan === null) {
      record.outcome = 'TRADE_PLAN_REJECTED'; // SL floor not cleared, or position rounds to 0 lots
      trades.push(record);
      continue;
    }

    const exactTakeProfit = solveExactTakeProfit(direction, entryFillPrice, rawPlan.positionSize);
    if (!Number.isFinite(exactTakeProfit) || exactTakeProfit <= 0 || (direction === 'SHORT' && exactTakeProfit >= entryFillPrice)) {
      record.outcome = 'TRADE_PLAN_REJECTED'; // degenerate TP solve (should not occur at this risk budget)
      trades.push(record);
      continue;
    }
    const tradePlan: TradePlan = { ...rawPlan, takeProfit: exactTakeProfit };
    record.tradePlan = tradePlan;

    const timeStopDeadline = entryFillTimestamp + MEAN_REVERSION_TIME_STOP_M5_CANDLES * M5_MS;
    // Reversed-direction convention for the TP leg: a LONG position's take-profit is a SELL limit
    // resting ABOVE price (fills once high pushes N ticks past it) -- that is simulateLimitFill's
    // 'BEAR' behavior, even though the position itself is LONG. Symmetric for SHORT/'BULL'. This is
    // exactly the kind of sign flip that went wrong once before (the SL-floor fix in TICKET-04X-P)
    // -- flagged here deliberately, not left implicit.
    const tpFillDirection = direction === 'LONG' ? 'BEAR' : 'BULL';

    let exitReason: ExitReason | 'NO_EXIT_DATA' | null = null;
    let exitPrice = 0;
    let exitTimestamp = 0;

    for (let j = entryFillIndex + 1; j < m1Candles.length; j += 1) {
      const candle = m1Candles[j];
      if (candle.openTime > timeStopDeadline) {
        exitReason = 'TIME_STOP';
        exitTimestamp = candle.openTime;
        // Time-stop closes at a taker market order: crosses the synthetic spread (H, adverse) plus
        // the standard adverse-taker-slippage rate, both baked into the exit price itself (unlike
        // SL, which already has a well-defined stop price level and is costed via an additive
        // slippageUsd term instead -- see computeCosts' comment).
        exitPrice =
          direction === 'LONG'
            ? (candle.open - SYNTHETIC_HALF_SPREAD_USD) * (1 - DEFAULT_ADVERSE_SLIPPAGE_RATE)
            : (candle.open + SYNTHETIC_HALF_SPREAD_USD) * (1 + DEFAULT_ADVERSE_SLIPPAGE_RATE);
        break;
      }

      const tpFilled = simulateLimitFill({
        limitPrice: tradePlan.takeProfit,
        direction: tpFillDirection,
        m1Candles: [candle],
        tickSize: TICK_SIZE,
        n: ENTRY_FILL_TICK_BUFFER_N,
      }).filled;
      const slFilled = direction === 'LONG' ? candle.low <= tradePlan.stopLoss : candle.high >= tradePlan.stopLoss;

      if (tpFilled && slFilled) {
        exitReason = 'AMBIGUOUS_FORCED_LOSS';
        exitPrice = tradePlan.stopLoss;
        exitTimestamp = candle.openTime;
        break;
      }
      if (slFilled) {
        exitReason = 'STOP_LOSS';
        exitPrice = tradePlan.stopLoss;
        exitTimestamp = candle.openTime;
        break;
      }
      if (tpFilled) {
        exitReason = 'TAKE_PROFIT';
        exitPrice = tradePlan.takeProfit;
        exitTimestamp = candle.openTime;
        break;
      }
    }

    if (exitReason === null) {
      record.outcome = 'NO_EXIT_DATA'; // ran off the end of the 3y dataset before TP/SL/time-stop
      trades.push(record);
      continue;
    }

    record.outcome = exitReason;
    record.exit = { timestamp: exitTimestamp, price: exitPrice };
    record.costs = computeCosts({
      direction,
      positionSize: tradePlan.positionSize,
      entryFillPrice,
      entryFillTimestamp,
      exitReason,
      exitPrice,
      exitTimestamp,
      riskPerUnit: tradePlan.riskPerUnit,
      fundingEvents,
    });
    trades.push(record);

    if (processed % 2000 === 0) console.info(`  processed ${processed} signals (${trades.length} trade records so far)...`);
  }

  console.info(`\nDone. ${processed} signals total, ${trades.length} trade records.`);

  // --- Summary ---
  const pnlBearing = trades.filter((t): t is TradeRecord & { costs: CostBreakdown } => t.costs !== undefined);
  const sortedByExit = [...pnlBearing].sort((a, b) => a.exit!.timestamp - b.exit!.timestamp);

  let equityUsd = 0;
  let peakUsd = 0;
  let maxDrawdownUsd = 0;
  let equityR = 0;
  let peakR = 0;
  let maxDrawdownR = 0;
  for (const t of sortedByExit) {
    equityUsd += t.costs.netUsd;
    peakUsd = Math.max(peakUsd, equityUsd);
    maxDrawdownUsd = Math.max(maxDrawdownUsd, peakUsd - equityUsd);
    equityR += t.costs.netR;
    peakR = Math.max(peakR, equityR);
    maxDrawdownR = Math.max(maxDrawdownR, peakR - equityR);
  }

  const wins = pnlBearing.filter((t) => t.costs.netUsd > 0);
  const losses = pnlBearing.filter((t) => t.costs.netUsd <= 0);
  const totalNetUsd = pnlBearing.reduce((sum, t) => sum + t.costs.netUsd, 0);
  const totalNetR = pnlBearing.reduce((sum, t) => sum + t.costs.netR, 0);

  function byReason(reason: ExitReason | NonTradeReason) {
    const subset = trades.filter((t) => t.outcome === reason);
    const withCosts = subset.filter((t): t is TradeRecord & { costs: CostBreakdown } => t.costs !== undefined);
    return {
      count: subset.length,
      totalNetUsd: withCosts.reduce((sum, t) => sum + t.costs.netUsd, 0),
      totalNetR: withCosts.reduce((sum, t) => sum + t.costs.netR, 0),
    };
  }

  const summary = {
    totalSignals: processed,
    totalTradeRecords: trades.length,
    pnlBearingTrades: pnlBearing.length,
    winRate: pnlBearing.length === 0 ? null : wins.length / pnlBearing.length,
    totalNetUsd,
    totalNetR,
    avgWinUsd: wins.length === 0 ? null : wins.reduce((s, t) => s + t.costs.netUsd, 0) / wins.length,
    avgLossUsd: losses.length === 0 ? null : losses.reduce((s, t) => s + t.costs.netUsd, 0) / losses.length,
    maxDrawdownUsd,
    maxDrawdownR,
    byExitReason: {
      TAKE_PROFIT: byReason('TAKE_PROFIT'),
      STOP_LOSS: byReason('STOP_LOSS'),
      AMBIGUOUS_FORCED_LOSS: byReason('AMBIGUOUS_FORCED_LOSS'),
      TIME_STOP: byReason('TIME_STOP'),
      EXPIRED: byReason('EXPIRED'),
      TRADE_PLAN_REJECTED: byReason('TRADE_PLAN_REJECTED'),
      NO_EXIT_DATA: byReason('NO_EXIT_DATA'),
    },
  };

  console.info('\n########## SUMMARY ##########');
  console.info(JSON.stringify(summary, null, 2));

  const output = {
    warning:
      'day la mo phong OHLC + spread gia lap (khong phai post-only that), da biet thien lech ~14% bo sot fill / ~17x cham hon thuc te ' +
      'theo TICKET-04X-Q (bookTicker vs OHLC fill comparison). H va cac nguong khong duoc chinh lai sau khi thay PnL.',
    knownBiasWarning:
      'TICKET-04X-Q do OHLC-only fill simulation tren 3 tuan bookTicker that: OHLC_MISSED_OPPORTUNITY=14.02% (bo sot fill that co xay ra), ' +
      'OHLC_OPTIMISTIC=0.34%; khi ca hai cung fill, OHLC cham hon that ~17x (median 0.997min vs 0.057min). Moi con so fill/no-fill trong file ' +
      'nay ke thua dung thien lech do, khong duoc coi la ty le fill that.',
    syntheticHalfSpread: { usd: SYNTHETIC_HALF_SPREAD_USD, source: SYNTHETIC_HALF_SPREAD_SOURCE },
    generatedAt: new Date().toISOString(),
    executionAssumptions: {
      riskBudgetUsd: RISK_BUDGET_USD,
      targetNetProfitUsd: TARGET_NET_PROFIT_USD,
      entryFillTtlM1Candles: ENTRY_TTL_M1_CANDLES,
      entryFillTickBufferN: ENTRY_FILL_TICK_BUFFER_N,
      timeStopM5Candles: MEAN_REVERSION_TIME_STOP_M5_CANDLES,
      makerFeeRate: BINANCE_USDM_VIP0_BNB_DISCOUNT_MAKER_FEE_RATE,
      takerFeeRate: BINANCE_USDM_VIP0_BNB_DISCOUNT_TAKER_FEE_RATE,
      adverseSlippageRate: DEFAULT_ADVERSE_SLIPPAGE_RATE,
      tickSize: TICK_SIZE,
      lotSize: LOT_SIZE,
      leverage: LEVERAGE,
      costModelDeviation:
        'Fee/slippage computed manually from raw costModel.ts rate constants, NOT via calculateExecutionCosts() -- that function bakes in ' +
        'its own OHLC-range spread proxy (SPREAD_PROXY_M1_RANGE_FRACTION) which would double-count spread on top of this backtest\'s real ' +
        'H-based entry/TP pricing. Agreed with user before implementation.',
    },
    summary,
    trades,
  };

  const outputPath = resolve(reportsDirectory, 'nukida-04x-s-mean-reversion-backtest.json');
  await writeFile(outputPath, JSON.stringify(output, null, 2), 'utf8');
  console.info(`\nOutput: ${outputPath}`);
}

await main();
