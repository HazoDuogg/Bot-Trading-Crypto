import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { checkNoTradeZone } from '../src/noTradeZone/noTradeZone.js';
import type { Candle } from '../src/noTradeZone/types.js';
import { classifyTrendH1 } from '../src/trend/trendH1.js';
import { detectFvg, DEFAULT_FVG_CONFIG } from '../src/entry/fvg.js';
import type { Direction } from '../src/entry/types.js';
import { calculatePositionSize } from '../src/positionSizing/positionSizing.js';
import { DEFAULT_MAX_MARGIN_PCT } from '../src/positionSizing/types.js';
import { computeAtr } from '../src/noTradeZone/atr.js';
import { findKeyZones } from '../src/zones/keyZones.js';
import type { KeyZone } from '../src/zones/keyZones.js';
import { DEFAULT_REGIME_CONFIG } from '../src/regime/types.js';

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
//
// TICKET-RT-028: adds a minSlPctFloor, applied POST-HOC in main() by filtering the already-built
// `allTrades` list (slPct is computed and stored on every trade regardless of any floor) rather than
// rejecting inside findTrades()'s fill logic — entryPrice/slPrice/tpPrice/outcome never depend on the
// floor, so filtering afterward is exactly equivalent to "don't count as filled" for every reported
// number (n, breakdown, PnL, winRate, PF), without re-running the scan per floor value. detectFvg()
// itself is untouched — the floor is a risk/sizing decision, not a pattern-recognition one.
//
// TICKET-RT-030: measures (never filters on) whether the FVG's gap contains an H1 KeyZone price —
// findKeyZones() is reused UNMODIFIED. There is no exported "DEFAULT_KEY_ZONE_CONFIG" in
// src/zones/keyZones.ts (the ticket assumed one) — FVG_KEY_ZONE_CONFIG below replicates the exact
// same values strategy1Measure.ts's KEY_ZONE_CONFIG uses, not new numbers. "Breaks a zone" = literal
// containment, zero tolerance per ticket instruction: some zone's price falls within [gapLow, gapHigh].
const FVG_KEY_ZONE_CONFIG = {
  swingPivotWidth: DEFAULT_REGIME_CONFIG.swingPivotWidth,
  clusterToleranceAtrMultiplier: 0.5,
  minTouches: 2,
  maxZoneAgeCandles: 500,
};

const H1_MS = 60 * 60 * 1000;
const M15_MS = 15 * 60 * 1000;
const ATR_PERIOD = 14;

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
  breaksKeyZone: boolean; // TICKET-RT-030: measured only, never filtered on
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
  slPct: number; // TICKET-RT-028: always computed, floor applied post-hoc in main() — see note there
  breaksKeyZone: boolean;
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

  let cachedH1Cursor = -1;
  let cachedZones: KeyZone[] = [];

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
              slPct: (slDistance / entryPrice) * 100,
              breaksKeyZone: pending.breaksKeyZone,
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

      // TICKET-RT-030: recompute H1 KeyZones only when h1Cursor has advanced since last time —
      // findKeyZones is O(h1Window length), and h1Cursor only changes once per hour.
      if (h1Cursor !== cachedH1Cursor) {
        cachedH1Cursor = h1Cursor;
        const atrH1Values = computeAtr(h1Window, ATR_PERIOD);
        const atrH1 = atrH1Values.length > 0 ? atrH1Values[atrH1Values.length - 1] : 0;
        cachedZones = atrH1 > 0 ? findKeyZones(h1Window, atrH1, FVG_KEY_ZONE_CONFIG) : [];
      }
      const gapLow = fvg.gapLow;
      const gapHigh = fvg.gapHigh;
      const breaksKeyZone = cachedZones.some((z) => z.price >= gapLow && z.price <= gapHigh);

      pending = {
        direction: fvg.direction,
        gapLow: fvg.gapLow,
        gapHigh: fvg.gapHigh,
        invalidationPrice: fvg.invalidationPrice,
        fvgIndex: i,
        waitCount: 0,
        breaksKeyZone,
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

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

interface Summary {
  n: number;
  tp: number;
  sl: number;
  open: number;
  pnl: number;
  winRate: number;
  profitFactor: number;
  tradesPerDayPerCoin: number;
}

function summarize(trades: Trade[], spanDays: number, symbolCount: number): Summary {
  const tp = trades.filter((t) => t.outcome === 'TP').length;
  const sl = trades.filter((t) => t.outcome === 'SL').length;
  const open = trades.filter((t) => t.outcome === 'STILL_OPEN').length;

  let pnl = 0;
  let wins = 0;
  let losses = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  for (const t of trades) {
    if (t.outcome === 'STILL_OPEN') continue;
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
  const tradesPerDayPerCoin = spanDays > 0 ? trades.length / spanDays / symbolCount : 0;

  return { n: trades.length, tp, sl, open, pnl, winRate, profitFactor, tradesPerDayPerCoin };
}

function printSummary(label: string, s: Summary): void {
  console.log(`\n=== ${label} ===`);
  console.log(`  n=${s.n}  (${s.tradesPerDayPerCoin.toFixed(3)} lenh/ngay/coin)`);
  console.log(`  TP: ${s.tp} (${s.n > 0 ? ((s.tp / s.n) * 100).toFixed(1) : '0.0'}%)`);
  console.log(`  SL: ${s.sl} (${s.n > 0 ? ((s.sl / s.n) * 100).toFixed(1) : '0.0'}%)`);
  console.log(`  STILL_OPEN: ${s.open} (${s.n > 0 ? ((s.open / s.n) * 100).toFixed(1) : '0.0'}%)`);
  console.log(
    `  PnL=$${s.pnl.toFixed(2)}  winRate=${s.winRate.toFixed(1)}%  PF=${Number.isFinite(s.profitFactor) ? s.profitFactor.toFixed(2) : 'inf'}`,
  );
}

function printKeyZoneCorrelation(label: string, trades: Trade[]): void {
  const withZone = trades.filter((t) => t.breaksKeyZone);
  const withoutZone = trades.filter((t) => !t.breaksKeyZone);
  const matchPct = trades.length > 0 ? (withZone.length / trades.length) * 100 : 0;

  console.log(`\n=== Tuong quan breaksKeyZone voi outcome — ${label} ===`);
  console.log(`  Ty le FVG pha qua KeyZone H1: ${withZone.length}/${trades.length} (${matchPct.toFixed(1)}%)`);
  if (matchPct < 5) {
    console.log('  LUU Y: ty le duoi 5% — co mau nhom "true" co the qua nho, KHONG tu ket luan chac chan tu so nay.');
  }

  const sBreak = summarize(withZone, 1, 1);
  const sNoBreak = summarize(withoutZone, 1, 1);
  console.log(
    `  breaksKeyZone=true:  n=${sBreak.n}  TP=${sBreak.tp} (${sBreak.n > 0 ? ((sBreak.tp / sBreak.n) * 100).toFixed(1) : '0.0'}%)  PnL=$${sBreak.pnl.toFixed(2)}  winRate=${sBreak.winRate.toFixed(1)}%  PF=${Number.isFinite(sBreak.profitFactor) ? sBreak.profitFactor.toFixed(2) : 'inf'}`,
  );
  console.log(
    `  breaksKeyZone=false: n=${sNoBreak.n}  TP=${sNoBreak.tp} (${sNoBreak.n > 0 ? ((sNoBreak.tp / sNoBreak.n) * 100).toFixed(1) : '0.0'}%)  PnL=$${sNoBreak.pnl.toFixed(2)}  winRate=${sNoBreak.winRate.toFixed(1)}%  PF=${Number.isFinite(sNoBreak.profitFactor) ? sNoBreak.profitFactor.toFixed(2) : 'inf'}`,
  );
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

  // TICKET-RT-028 step 1: SL% distribution of ALL filled trades, no floor applied — measured before
  // guessing where to put the floor, not reused blindly from Chien Luoc 1's 0.05% (different SL source:
  // candle1's wick, not a swing point).
  const slPctValues = allTrades.map((t) => t.slPct).sort((a, b) => a - b);
  console.log('\n=== Phan phoi SL% (tat ca lenh da fill, CHUA ap floor) ===');
  console.log(
    `  n=${slPctValues.length}  p10=${percentile(slPctValues, 0.1).toFixed(4)}  p25=${percentile(slPctValues, 0.25).toFixed(4)}  median=${percentile(slPctValues, 0.5).toFixed(4)}  p75=${percentile(slPctValues, 0.75).toFixed(4)}  p90=${percentile(slPctValues, 0.9).toFixed(4)}  min=${slPctValues[0].toFixed(4)}  max=${slPctValues[slPctValues.length - 1].toFixed(4)}`,
  );

  const baseline = summarize(allTrades, spanDays, symbols.length);
  printSummary(`BASELINE (khong floor, khop RT-027: n=1959, PnL=-$1799.16, winRate=52.1%, PF=0.70)`, baseline);

  // Step 3: sweep floor levels spanning the measured distribution (p10 through ~p75), plus the
  // round-trip fee (~0.2%) itself as a natural reference point.
  // TICKET-RT-029: extended past RT-028's 0.3 peak, to see whether PF keeps rising, plateaus, or
  // reverses at higher floors (the "distribution tail" effect already seen with Chien Luoc 1's net
  // R:R floor sweep) — not stopping at the first peak observed.
  const FLOOR_SWEEP = [0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.5, 0.6];
  console.log('\n=== Sweep minSlPctFloor ===');
  console.log('floor%'.padEnd(10) + 'n'.padEnd(8) + 'lenh/ngay/coin'.padEnd(16) + 'TP%'.padEnd(8) + 'SL%'.padEnd(8) + 'PnL$'.padEnd(14) + 'winRate'.padEnd(10) + 'PF');
  for (const floor of FLOOR_SWEEP) {
    const filtered = allTrades.filter((t) => t.slPct >= floor);
    const s = summarize(filtered, spanDays, symbols.length);
    console.log(
      `${floor}`.padEnd(10) +
        String(s.n).padEnd(8) +
        s.tradesPerDayPerCoin.toFixed(3).padEnd(16) +
        `${s.n > 0 ? ((s.tp / s.n) * 100).toFixed(0) : '0'}%`.padEnd(8) +
        `${s.n > 0 ? ((s.sl / s.n) * 100).toFixed(0) : '0'}%`.padEnd(8) +
        `$${s.pnl.toFixed(2)}`.padEnd(14) +
        `${s.winRate.toFixed(1)}%`.padEnd(10) +
        `${Number.isFinite(s.profitFactor) ? s.profitFactor.toFixed(2) : 'inf'}`,
    );
  }

  // TICKET-RT-029 step 2: breakdown per coin at floor=0.3 — confirms (or not) that the positive
  // result isn't just 1-2 coins dragging the pooled average up, same check style as RT-013.
  const BREAKDOWN_FLOOR = 0.3;
  console.log(`\n=== Breakdown theo tung coin, floor=${BREAKDOWN_FLOOR}% ===`);
  console.log('symbol'.padEnd(12) + 'n'.padEnd(8) + 'TP%'.padEnd(8) + 'SL%'.padEnd(8) + 'PnL$'.padEnd(14) + 'winRate'.padEnd(10) + 'PF');
  for (const symbol of symbols) {
    const symbolTrades = allTrades.filter((t) => t.symbol === symbol && t.slPct >= BREAKDOWN_FLOOR);
    const s = summarize(symbolTrades, spanDays, 1);
    console.log(
      symbol.padEnd(12) +
        String(s.n).padEnd(8) +
        `${s.n > 0 ? ((s.tp / s.n) * 100).toFixed(0) : '0'}%`.padEnd(8) +
        `${s.n > 0 ? ((s.sl / s.n) * 100).toFixed(0) : '0'}%`.padEnd(8) +
        `$${s.pnl.toFixed(2)}`.padEnd(14) +
        `${s.winRate.toFixed(1)}%`.padEnd(10) +
        `${Number.isFinite(s.profitFactor) ? s.profitFactor.toFixed(2) : 'inf'}`,
    );
  }

  // TICKET-RT-030: correlation between breaksKeyZone and outcome — measured only, never filtered on.
  // Reported on BOTH the no-floor baseline (n=1959) and floor=0.5% (RT-029's PF peak, n=469).
  printKeyZoneCorrelation('BASELINE khong floor', allTrades);
  printKeyZoneCorrelation('floor=0.5% (RT-029 PF peak)', allTrades.filter((t) => t.slPct >= 0.5));

  console.log('\n=== So sanh voi cac ket qua da do trong ngay (baseline, khong floor) ===');
  console.log('  M5 Chien Luoc 1 tot nhat (RT-024, width=20): PF=0.17, winRate=12.5%, 0.089 lenh/ngay/coin');
  console.log('  M15 Chien Luoc 1 tot nhat (RT-026, width=2): PF=0.44, winRate=42.9%, 0.016 lenh/ngay/coin');
  console.log(
    `  M15 FVG khong floor (RT-027):                 PF=${Number.isFinite(baseline.profitFactor) ? baseline.profitFactor.toFixed(2) : 'inf'}, winRate=${baseline.winRate.toFixed(1)}%, ${baseline.tradesPerDayPerCoin.toFixed(3)} lenh/ngay/coin`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
