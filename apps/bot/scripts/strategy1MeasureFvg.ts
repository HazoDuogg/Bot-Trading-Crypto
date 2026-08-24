import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { checkNoTradeZone } from '../src/noTradeZone/noTradeZone.js';
import type { Candle } from '../src/noTradeZone/types.js';
import { classifyTrendH1 } from '../src/trend/trendH1.js';
import { detectFvg, DEFAULT_FVG_CONFIG } from '../src/entry/fvg.js';
import type { Direction } from '../src/entry/types.js';
import { calculatePositionSize } from '../src/positionSizing/positionSizing.js';
import { DEFAULT_MAX_MARGIN_PCT } from '../src/positionSizing/types.js';

// TICKET-RT-027: FVG (Fair Value Gap) as an independent entry signal, per the "Casper SMC" video —
// with the "US session open" liquidity-window part STRIPPED OUT entirely (doesn't apply to 24/7
// crypto). Deliberately NOT integrated with Chien Luoc 1's Pin Bar/Engulfing/findKeyZones/
// structuralSlTp/Stochastic/Fibonacci — a fully separate module/script to compare against, per
// ticket instruction. M15 only (M5 already shown to be fee-dominated all day). H1 trend filter
// (classifyTrendH1, unmodified) still applies; findKeyZones is NOT used — a fresh FVG is itself the
// "strong impulse" signal per the video, no additional "at a proven zone" gate is applied.
//
// TODO_CONFIRM placeholders (video's 16-trade/30-day 81% winrate sample is explicitly too small to
// anchor on, per ticket — not used as an expectation baseline):
//   DEFAULT_FVG_CONFIG.minCandle2BodyRatio = 0.6 — see src/entry/fvg.ts, not backtest-chosen.
//   MAX_WAIT_CANDLES = 20 (M15 candles = 5 hours) — how long an unfilled FVG limit stays live before
//     being cancelled; arbitrary, same "don't wait forever" reasoning as RT-022's retest timeout, not
//     re-derived here.
//   TARGET_R_MULTIPLE = 1.5 — the LOWER end of the video's stated 1.5-2.0 range, per ticket
//     instruction ("chọn cận dưới"), not backtest-chosen. RT-027 doesn't sweep this — flagged for a
//     follow-up sweep only if this base version shows a positive signal.
//
// Only ONE pending (unfilled) FVG is tracked per symbol at a time — if a fresh FVG appears while an
// earlier one is still waiting to fill, the new one REPLACES the old wait (most recent wins), same
// overlap-handling choice as RT-022's wait-for-retest state machine, for the same reason: the ticket
// doesn't specify how to handle overlapping setups.

const H1_MS = 60 * 60 * 1000;
const M15_MS = 15 * 60 * 1000;

const MAX_WAIT_CANDLES = 20;
const TARGET_R_MULTIPLE = 1.5;
const EMA_PERIOD_H1 = 200;

const FEE_PCT_SUM = 0.05 + 0.05 + 0.05 + 0.05;

const BALANCE = 500;
const RISK_PCT = 0.01;
const RISK_USD = BALANCE * RISK_PCT;
const LEVERAGE: Record<string, number> = {
  BTCUSDT: 20,
  ETHUSDT: 20,
  SOLUSDT: 10,
  HYPEUSDT: 10,
  XRPUSDT: 10,
};

async function readCsv(filePath: string): Promise<Candle[]> {
  const raw = await readFile(filePath, 'utf8');
  const lines = raw.trim().split('\n').slice(1);
  return lines.map((line) => {
    const [openTime, open, high, low, close, volume] = line.split(',');
    return {
      openTime: Number(openTime),
      open: Number(open),
      high: Number(high),
      low: Number(low),
      close: Number(close),
      volume: Number(volume),
    };
  });
}

type Outcome = 'TP' | 'SL' | 'STILL_OPEN';

interface PendingFvg {
  direction: Direction;
  gapLow: number;
  gapHigh: number;
  invalidationPrice: number;
  fvgIndex: number; // index of candle3
  waitCount: number;
}

interface Trade {
  symbol: string;
  direction: Direction;
  entryPrice: number;
  slPrice: number;
  tpPrice: number;
  qty: number;
  notional: number;
  outcome: Outcome;
}

function scanOutcome(m15All: Candle[], entryIndex: number, direction: Direction, slPrice: number, tpPrice: number): Outcome {
  for (let j = entryIndex + 1; j < m15All.length; j++) {
    const candle = m15All[j];
    const slTouched = direction === 'LONG' ? candle.low <= slPrice : candle.high >= slPrice;
    const tpTouched = direction === 'LONG' ? candle.high >= tpPrice : candle.low <= tpPrice;
    if (slTouched) return 'SL';
    if (tpTouched) return 'TP';
  }
  return 'STILL_OPEN';
}

interface SymbolResult {
  fvgCount: number;
  filledCount: number;
  trades: Trade[];
}

async function findTrades(symbol: string, dataDir: string): Promise<SymbolResult> {
  const h1All = await readCsv(path.join(dataDir, `${symbol}_1h.csv`));
  const m15All = await readCsv(path.join(dataDir, `${symbol}_15m.csv`));
  const leverage = LEVERAGE[symbol];

  let h1Cursor = 0;
  let fvgCount = 0;
  let filledCount = 0;
  const trades: Trade[] = [];
  let pending: PendingFvg | null = null;

  for (let i = 2; i < m15All.length; i++) {
    const m15CloseTime = m15All[i].openTime + M15_MS;
    while (h1Cursor < h1All.length && h1All[h1Cursor].openTime + H1_MS <= m15CloseTime) h1Cursor++;
    if (h1Cursor === 0) continue;

    const h1Window = h1All.slice(0, h1Cursor);
    const m15Window = m15All.slice(0, i + 1);
    const closePrice = h1Window[h1Window.length - 1].close;

    const ntz = checkNoTradeZone({
      nowMs: m15CloseTime,
      bid: closePrice,
      ask: closePrice,
      h1Candles: h1Window,
      m15Candles: m15Window,
    });

    // --- 1) advance a pending (unfilled) FVG wait, every M15 candle ---
    if (pending) {
      pending.waitCount++;
      const candle = m15All[i];
      const touchedGap = candle.low <= pending.gapHigh && candle.high >= pending.gapLow;

      if (touchedGap && !ntz.blocked) {
        const entryPrice = pending.direction === 'LONG' ? pending.gapLow : pending.gapHigh;
        const slPrice = pending.invalidationPrice;
        const slDistance = Math.abs(entryPrice - slPrice);

        if (slDistance > 0) {
          const tpPrice = pending.direction === 'LONG' ? entryPrice + TARGET_R_MULTIPLE * slDistance : entryPrice - TARGET_R_MULTIPLE * slDistance;
          const sizing = calculatePositionSize({
            balance: BALANCE,
            riskUsd: RISK_USD,
            entryPrice,
            slPrice,
            leverage,
            maxMarginPct: DEFAULT_MAX_MARGIN_PCT,
          });
          if (sizing) {
            filledCount++;
            const outcome = scanOutcome(m15All, i, pending.direction, slPrice, tpPrice);
            trades.push({
              symbol,
              direction: pending.direction,
              entryPrice,
              slPrice,
              tpPrice,
              qty: sizing.qty,
              notional: sizing.notional,
              outcome,
            });
          }
        }
        pending = null;
      } else if (pending.waitCount >= MAX_WAIT_CANDLES) {
        pending = null; // timeout, unfilled — not counted as a trade
      }
    }

    if (ntz.blocked) continue;

    const trend = classifyTrendH1(h1Window, EMA_PERIOD_H1);
    if (trend === null) continue;
    const trendDirection: Direction = trend === 'UPTREND' ? 'LONG' : 'SHORT';

    // --- 2) check for a fresh FVG at this candle (candle1=i-2, candle2=i-1, candle3=i) ---
    const fvg = detectFvg(m15All[i - 2], m15All[i - 1], m15All[i], DEFAULT_FVG_CONFIG);
    if (fvg.isFvg && fvg.direction === trendDirection && fvg.gapLow !== undefined && fvg.gapHigh !== undefined && fvg.invalidationPrice !== undefined) {
      fvgCount++;
      pending = {
        direction: fvg.direction,
        gapLow: fvg.gapLow,
        gapHigh: fvg.gapHigh,
        invalidationPrice: fvg.invalidationPrice,
        fvgIndex: i,
        waitCount: 0,
      };
    }
  }

  return { fvgCount, filledCount, trades };
}

function directedDelta(direction: Direction, entryPrice: number, exitPrice: number): number {
  return direction === 'LONG' ? exitPrice - entryPrice : entryPrice - exitPrice;
}

function computePnl(t: Trade): number {
  if (t.outcome === 'STILL_OPEN') return 0;
  const costDollars = (t.notional * FEE_PCT_SUM) / 100;
  const exitPrice = t.outcome === 'TP' ? t.tpPrice : t.slPrice;
  return t.qty * directedDelta(t.direction, t.entryPrice, exitPrice) - costDollars;
}

async function main() {
  const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'HYPEUSDT', 'XRPUSDT'];
  const dataDir = path.resolve(process.cwd(), 'apps/bot/data');

  let totalFvg = 0;
  let totalFilled = 0;
  let allTrades: Trade[] = [];
  let spanDays = 0;

  for (const symbol of symbols) {
    const m15All = await readCsv(path.join(dataDir, `${symbol}_15m.csv`));
    if (spanDays === 0) spanDays = (m15All[m15All.length - 1].openTime - m15All[0].openTime) / (24 * 60 * 60 * 1000);

    const result = await findTrades(symbol, dataDir);
    console.log(`${symbol}: ${result.fvgCount} FVG tim thay, ${result.filledCount} da fill (${result.fvgCount > 0 ? ((result.filledCount / result.fvgCount) * 100).toFixed(1) : '0.0'}% fill rate)`);
    totalFvg += result.fvgCount;
    totalFilled += result.filledCount;
    allTrades = allTrades.concat(result.trades);
  }

  console.log(`\nTong: ${totalFvg} FVG, ${totalFilled} da fill (${totalFvg > 0 ? ((totalFilled / totalFvg) * 100).toFixed(1) : '0.0'}% fill rate)`);

  const decidable = allTrades.filter((t) => t.outcome !== 'STILL_OPEN');
  const tp = allTrades.filter((t) => t.outcome === 'TP').length;
  const sl = allTrades.filter((t) => t.outcome === 'SL').length;
  const open = allTrades.filter((t) => t.outcome === 'STILL_OPEN').length;

  let pnl = 0;
  let wins = 0;
  let losses = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  for (const t of decidable) {
    const p = computePnl(t);
    pnl += p;
    if (p > 0) {
      wins++;
      grossProfit += p;
    } else if (p < 0) {
      losses++;
      grossLoss += Math.abs(p);
    }
  }
  const decided = wins + losses;
  const winRate = decided > 0 ? (wins / decided) * 100 : 0;
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
  const tradesPerDayPerCoin = spanDays > 0 ? allTrades.length / spanDays / symbols.length : 0;

  console.log(`\n=== Ket qua sau khi fill (n=${allTrades.length}, ${tradesPerDayPerCoin.toFixed(3)} lenh/ngay/coin, ${spanDays.toFixed(1)} ngay x ${symbols.length} coin) ===`);
  console.log(`  TP: ${tp} (${allTrades.length > 0 ? ((tp / allTrades.length) * 100).toFixed(1) : '0.0'}%)`);
  console.log(`  SL: ${sl} (${allTrades.length > 0 ? ((sl / allTrades.length) * 100).toFixed(1) : '0.0'}%)`);
  console.log(`  STILL_OPEN: ${open} (${allTrades.length > 0 ? ((open / allTrades.length) * 100).toFixed(1) : '0.0'}%)`);
  console.log(
    `  PnL=$${pnl.toFixed(2)}  winRate=${winRate.toFixed(1)}%  PF=${Number.isFinite(profitFactor) ? profitFactor.toFixed(2) : 'inf'}  wins=${wins}  losses=${losses}`,
  );

  console.log('\n=== So sanh voi cac ket qua da do trong ngay ===');
  console.log('  M5 Chien Luoc 1 tot nhat (RT-024, width=20): PF=0.17, winRate=12.5%, 0.089 lenh/ngay/coin');
  console.log('  M15 Chien Luoc 1 tot nhat (RT-026, width=2): PF=0.44, winRate=42.9%, 0.016 lenh/ngay/coin');
  console.log(
    `  M15 FVG (ticket nay):                         PF=${Number.isFinite(profitFactor) ? profitFactor.toFixed(2) : 'inf'}, winRate=${winRate.toFixed(1)}%, ${tradesPerDayPerCoin.toFixed(3)} lenh/ngay/coin`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
