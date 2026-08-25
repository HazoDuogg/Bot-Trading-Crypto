import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { checkNoTradeZone } from '../src/noTradeZone/noTradeZone.js';
import type { Candle } from '../src/noTradeZone/types.js';
import { classifyTrendH1 } from '../src/trend/trendH1.js';
import { detectFvg, DEFAULT_FVG_CONFIG } from '../src/entry/fvg.js';
import { DEFAULT_FVG_STRATEGY_CONFIG } from '../src/entry/fvgStrategyConfig.js';
import type { Direction } from '../src/entry/types.js';
import { calculatePositionSize } from '../src/positionSizing/positionSizing.js';
import { DEFAULT_MAX_MARGIN_PCT } from '../src/positionSizing/types.js';
import { computeAtr } from '../src/noTradeZone/atr.js';
import { findKeyZones } from '../src/zones/keyZones.js';
import type { KeyZone } from '../src/zones/keyZones.js';
import { DEFAULT_REGIME_CONFIG } from '../src/regime/types.js';

// TICKET-RT-039: two independent sweeps on top of RT-038's breakeven-only design (full size, no
// partial close, TP fixed at 1.5R) to test whether "cat non do quet noise gan entry" shrinks with a
// farther trigger (Sweep A) or a wider buffer (Sweep B). Entry detection duplicated verbatim from
// RT-034/036/037/038 (same detectFvg/checkNoTradeZone/classifyTrendH1/calculatePositionSize/config
// imports) for the same reason each time: strategy1MeasureFvg.ts's findTrades()/Trade aren't
// exported and don't carry entryIndex/raw path. fvg.ts/fvgStrategyConfig.ts untouched.
//
// Sweep B's ATR_M15 buffer uses computeAtr() (same function/period=14 convention already used for
// H1 ATR in strategy1MeasureFvg.ts's KeyZone correlation) applied to the M15 window ending at each
// trade's own entry candle — a real, per-trade, per-coin volatility measure, not one fixed percent
// shared across all 5 coins (the "bai hoc #4" scale mismatch this ticket explicitly avoids).

const FVG_KEY_ZONE_CONFIG = {
  swingPivotWidth: DEFAULT_REGIME_CONFIG.swingPivotWidth,
  clusterToleranceAtrMultiplier: 0.5,
  minTouches: 2,
  maxZoneAgeCandles: 500,
};

const H1_MS = 60 * 60 * 1000;
const M15_MS = 15 * 60 * 1000;
const ATR_PERIOD = 14;
const EMA_PERIOD_H1 = 200;

const FLOOR_PCT = DEFAULT_FVG_STRATEGY_CONFIG.minSlPctFloor;
const TARGET_R = DEFAULT_FVG_STRATEGY_CONFIG.targetRMultiple; // 1.5, unchanged
const SWEEP_CONFIG = {
  minCandle2BodyRatio: DEFAULT_FVG_CONFIG.minCandle2BodyRatio,
  maxWaitCandles: DEFAULT_FVG_STRATEGY_CONFIG.maxWaitCandles,
  targetRMultiple: TARGET_R,
};

const FEE_PCT_SUM = 0.05 + 0.05 + 0.05 + 0.05; // same constant as every sibling script since RT-027

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
  waitCount: number;
}

interface BaseTrade {
  symbol: string;
  direction: Direction;
  entryIndex: number;
  entryPrice: number;
  slPrice: number;
  tpPrice: number; // 1.5R, unchanged
  slDistance: number;
  qty: number;
  notional: number;
  baselineOutcome: Outcome;
  atrM15AtEntry: number; // real ATR(14) on M15, computed at the entry candle, per trade/coin
}

async function findBaseTrades(symbol: string, dataDir: string, m15AllOut: Map<string, Candle[]>): Promise<BaseTrade[]> {
  const h1All = await readCsv(path.join(dataDir, `${symbol}_1h.csv`));
  const m15All = await readCsv(path.join(dataDir, `${symbol}_15m.csv`));
  m15AllOut.set(symbol, m15All);
  const leverage = LEVERAGE[symbol];

  let h1Cursor = 0;
  const trades: BaseTrade[] = [];
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

    if (pending) {
      pending.waitCount++;
      const candle = m15All[i];
      const touchedGap = candle.low <= pending.gapHigh && candle.high >= pending.gapLow;

      if (touchedGap && !ntz.blocked) {
        const entryPrice = pending.direction === 'LONG' ? pending.gapLow : pending.gapHigh;
        const slPrice = pending.invalidationPrice;
        const slDistance = Math.abs(entryPrice - slPrice);

        if (slDistance > 0) {
          const tpPrice =
            pending.direction === 'LONG' ? entryPrice + SWEEP_CONFIG.targetRMultiple * slDistance : entryPrice - SWEEP_CONFIG.targetRMultiple * slDistance;
          const sizing = calculatePositionSize({
            balance: BALANCE,
            riskUsd: RISK_USD,
            entryPrice,
            slPrice,
            leverage,
            maxMarginPct: DEFAULT_MAX_MARGIN_PCT,
          });
          if (sizing) {
            const baselineOutcome = scanTouch(m15All, i, pending.direction, slPrice, tpPrice).outcome;
            const atrSeries = computeAtr(m15All.slice(0, i + 1), ATR_PERIOD);
            const atrM15AtEntry = atrSeries.length > 0 ? atrSeries[atrSeries.length - 1] : 0;
            trades.push({
              symbol,
              direction: pending.direction,
              entryIndex: i,
              entryPrice,
              slPrice,
              tpPrice,
              slDistance,
              qty: sizing.qty,
              notional: sizing.notional,
              baselineOutcome,
              atrM15AtEntry,
            });
          }
        }
        pending = null;
      } else if (pending.waitCount >= SWEEP_CONFIG.maxWaitCandles) {
        pending = null;
      }
    }

    if (ntz.blocked) continue;

    const trend = classifyTrendH1(h1Window, EMA_PERIOD_H1);
    if (trend === null) continue;
    const trendDirection: Direction = trend === 'UPTREND' ? 'LONG' : 'SHORT';

    const fvg = detectFvg(m15All[i - 2], m15All[i - 1], m15All[i], { minCandle2BodyRatio: SWEEP_CONFIG.minCandle2BodyRatio });
    if (fvg.isFvg && fvg.direction === trendDirection && fvg.gapLow !== undefined && fvg.gapHigh !== undefined && fvg.invalidationPrice !== undefined) {
      if (h1Cursor !== cachedH1Cursor) {
        cachedH1Cursor = h1Cursor;
        const atrH1Values = computeAtr(h1Window, ATR_PERIOD);
        const atrH1 = atrH1Values.length > 0 ? atrH1Values[atrH1Values.length - 1] : 0;
        cachedZones = atrH1 > 0 ? findKeyZones(h1Window, atrH1, FVG_KEY_ZONE_CONFIG) : [];
      }
      void cachedZones;

      pending = {
        direction: fvg.direction,
        gapLow: fvg.gapLow,
        gapHigh: fvg.gapHigh,
        invalidationPrice: fvg.invalidationPrice,
        waitCount: 0,
      };
    }
  }

  return trades;
}

function scanTouch(m15All: Candle[], fromIndex: number, direction: Direction, slPrice: number, tpPrice: number): { outcome: Outcome; index: number } {
  for (let j = fromIndex + 1; j < m15All.length; j++) {
    const candle = m15All[j];
    const slTouched = direction === 'LONG' ? candle.low <= slPrice : candle.high >= slPrice;
    const tpTouched = direction === 'LONG' ? candle.high >= tpPrice : candle.low <= tpPrice;
    if (slTouched) return { outcome: 'SL', index: j };
    if (tpTouched) return { outcome: 'TP', index: j };
  }
  return { outcome: 'STILL_OPEN', index: m15All.length - 1 };
}

function directedDelta(direction: Direction, entryPrice: number, exitPrice: number): number {
  return direction === 'LONG' ? exitPrice - entryPrice : entryPrice - exitPrice;
}

type ClassLabel =
  | 'NEVER_TRIGGERED_SL'
  | 'NEVER_TRIGGERED_STILL_OPEN'
  | 'UNAFFECTED_WIN'
  | 'SAVED'
  | 'CUT_SHORT'
  | 'TRIGGERED_STILL_OPEN'
  | 'BUFFER_EXCEEDS_TARGET';

interface SimResult {
  pnl: number;
  isWin: boolean;
  isDecided: boolean;
  classLabel: ClassLabel;
}

// bufferPrice is a price DISTANCE (not a %), so both fixed-% buffers (converted upstream) and
// ATR-based buffers share one code path.
function simulateTrade(m15All: Candle[], t: BaseTrade, triggerR: number, bufferPrice: number): SimResult {
  const triggerPrice = t.direction === 'LONG' ? t.entryPrice + triggerR * t.slDistance : t.entryPrice - triggerR * t.slDistance;
  const breakevenSlPrice = t.direction === 'LONG' ? t.entryPrice + bufferPrice : t.entryPrice - bufferPrice;
  // A stop cannot sit at or beyond the take-profit — physically meaningless (SL past TP), and
  // clamping it to "just inside TP" would make the SL and TP checks fire on the same candle for any
  // trade that reaches TP, which the SL-checked-first priority (matching every sibling script's
  // scanOutcome) would then always misclassify as an SL touch. Real for the ATR_M15 configs swept
  // here: p50 ATR/slDistance=0.94, so a 1.5x ATR buffer exceeds the 1.5R target distance for 154/358
  // trades. Excluded from stats (isDecided=false) rather than faked — counted and reported per config.
  const bufferExceedsTarget = t.direction === 'LONG' ? breakevenSlPrice >= t.tpPrice : breakevenSlPrice <= t.tpPrice;
  const cost = (t.notional * FEE_PCT_SUM) / 100; // full size throughout, 2 legs, same as baseline

  const phase1 = scanTouch(m15All, t.entryIndex, t.direction, t.slPrice, triggerPrice);

  if (phase1.outcome === 'SL') {
    const pnl = t.qty * directedDelta(t.direction, t.entryPrice, t.slPrice) - cost;
    return { pnl, isWin: pnl > 0, isDecided: true, classLabel: 'NEVER_TRIGGERED_SL' };
  }
  if (phase1.outcome === 'STILL_OPEN') {
    return { pnl: 0, isWin: false, isDecided: false, classLabel: 'NEVER_TRIGGERED_STILL_OPEN' };
  }
  if (bufferExceedsTarget) {
    return { pnl: 0, isWin: false, isDecided: false, classLabel: 'BUFFER_EXCEEDS_TARGET' };
  }

  const phase2 = scanTouch(m15All, phase1.index, t.direction, breakevenSlPrice, t.tpPrice);

  if (phase2.outcome === 'TP') {
    const pnl = t.qty * directedDelta(t.direction, t.entryPrice, t.tpPrice) - cost;
    return { pnl, isWin: pnl > 0, isDecided: true, classLabel: 'UNAFFECTED_WIN' };
  }
  if (phase2.outcome === 'STILL_OPEN') {
    return { pnl: 0, isWin: false, isDecided: false, classLabel: 'TRIGGERED_STILL_OPEN' };
  }

  const pnl = t.qty * directedDelta(t.direction, t.entryPrice, breakevenSlPrice) - cost;
  const classLabel: ClassLabel = t.baselineOutcome === 'SL' ? 'SAVED' : 'CUT_SHORT';
  return { pnl, isWin: pnl > 0, isDecided: true, classLabel };
}

interface Stats {
  n: number;
  pnl: number;
  winRate: number;
  profitFactor: number;
}

function summarize(results: SimResult[]): Stats {
  const decided = results.filter((r) => r.isDecided);
  let pnl = 0;
  let wins = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  for (const r of decided) {
    pnl += r.pnl;
    if (r.pnl > 0) {
      wins++;
      grossProfit += r.pnl;
    } else if (r.pnl < 0) {
      grossLoss += Math.abs(r.pnl);
    }
  }
  const winRate = decided.length > 0 ? (wins / decided.length) * 100 : 0;
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
  return { n: decided.length, pnl, winRate, profitFactor };
}

function computeBaselinePnl(t: BaseTrade): number {
  if (t.baselineOutcome === 'STILL_OPEN') return 0;
  const cost = (t.notional * FEE_PCT_SUM) / 100;
  const exitPrice = t.baselineOutcome === 'TP' ? t.tpPrice : t.slPrice;
  return t.qty * directedDelta(t.direction, t.entryPrice, exitPrice) - cost;
}

function summarizeBaseline(trades: BaseTrade[]): Stats {
  const decided = trades.filter((t) => t.baselineOutcome !== 'STILL_OPEN');
  let pnl = 0;
  let wins = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  for (const t of decided) {
    const p = computeBaselinePnl(t);
    pnl += p;
    if (p > 0) {
      wins++;
      grossProfit += p;
    } else if (p < 0) {
      grossLoss += Math.abs(p);
    }
  }
  const winRate = decided.length > 0 ? (wins / decided.length) * 100 : 0;
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
  return { n: decided.length, pnl, winRate, profitFactor };
}

function statsRow(s: Stats, saved: number, cutShort: number, excluded = 0): string {
  return (
    String(s.n).padEnd(6) +
    `$${s.pnl.toFixed(2)}`.padEnd(14) +
    `${s.winRate.toFixed(1)}%`.padEnd(10) +
    `${Number.isFinite(s.profitFactor) ? s.profitFactor.toFixed(2) : 'inf'}`.padEnd(8) +
    `${saved}/138`.padEnd(10) +
    `${cutShort}/220`.padEnd(10) +
    (excluded > 0 ? `excl=${excluded}` : '')
  );
}

async function main() {
  const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'HYPEUSDT', 'XRPUSDT'];
  const dataDir = path.resolve(process.cwd(), 'apps/bot/data');
  const m15Map = new Map<string, Candle[]>();

  let allTrades: BaseTrade[] = [];
  for (const symbol of symbols) {
    const trades = await findBaseTrades(symbol, dataDir, m15Map);
    allTrades = allTrades.concat(trades);
  }

  const filled = allTrades.filter((t) => (t.slDistance / t.entryPrice) * 100 >= FLOOR_PCT);
  console.log(`Tong lenh da fill (floor=${FLOOR_PCT}%): n=${filled.length} (ky vong 358, doi chieu RT-033/034/036/037/038)`);

  const baseline = summarizeBaseline(filled);
  console.log(
    `\nBASELINE (full TP=${TARGET_R}R, khong breakeven): n=${baseline.n}  PnL=$${baseline.pnl.toFixed(2)}  winRate=${baseline.winRate.toFixed(1)}%  PF=${Number.isFinite(baseline.profitFactor) ? baseline.profitFactor.toFixed(2) : 'inf'}  (doi chieu RT-033: $474.22, 61.5%, PF=1.54)`,
  );

  const feeBufferFn = (t: BaseTrade) => t.entryPrice * (FEE_PCT_SUM / 100); // 0.2%, same as RT-038

  console.log('\n=== SWEEP A: trigger xa hon (0.5R-1.0R da test o RT-038, mo rong 1.0R-1.4R), buffer=feeBuffer 0.2% ===');
  console.log('trigger'.padEnd(10) + 'n'.padEnd(6) + 'PnL$'.padEnd(14) + 'winRate'.padEnd(10) + 'PF'.padEnd(8) + 'saved'.padEnd(10) + 'cutShort');
  const TRIGGER_A = [1.0, 1.1, 1.2, 1.3, 1.4];
  let bestA: { trig: number; pnl: number } = { trig: TRIGGER_A[0], pnl: -Infinity };
  for (const trig of TRIGGER_A) {
    const results = filled.map((t) => simulateTrade(m15Map.get(t.symbol)!, t, trig, feeBufferFn(t)));
    const s = summarize(results);
    const saved = results.filter((r) => r.classLabel === 'SAVED').length;
    const cutShort = results.filter((r) => r.classLabel === 'CUT_SHORT').length;
    console.log(`${trig}R`.padEnd(10) + statsRow(s, saved, cutShort));
    if (s.pnl > bestA.pnl) bestA = { trig, pnl: s.pnl };
  }
  console.log(`  -> Sweep A best by PnL$: trigger=${bestA.trig}R ($${bestA.pnl.toFixed(2)})`);

  console.log(`\n=== Breakdown 5 coin cho cau hinh tot nhat cua Sweep A (trigger=${bestA.trig}R, buffer=0.2%) ===`);
  console.log('symbol'.padEnd(12) + 'n'.padEnd(6) + 'PnL$'.padEnd(14) + 'winRate'.padEnd(10) + 'PF'.padEnd(8) + 'saved'.padEnd(10) + 'cutShort');
  for (const symbol of symbols) {
    const symbolTrades = filled.filter((t) => t.symbol === symbol);
    const results = symbolTrades.map((t) => simulateTrade(m15Map.get(symbol)!, t, bestA.trig, feeBufferFn(t)));
    const s = summarize(results);
    const saved = results.filter((r) => r.classLabel === 'SAVED').length;
    const cutShort = results.filter((r) => r.classLabel === 'CUT_SHORT').length;
    console.log(symbol.padEnd(12) + statsRow(s, saved, cutShort));
  }

  console.log(`\n=== SWEEP B: buffer rong hon, trigger co dinh tai muc tot nhat cua Sweep A (${bestA.trig}R) ===`);
  console.log(
    '  LUU Y: cac hang co buffer >= khoang cach toi TP (1.5R) bi LOAI (khong tinh vao n/PnL) vi mot SL' +
      '\n  khong the nam qua muc TP — xem cot "excl". n khac nhau giua cac hang -> so sanh PnL$ tho giua' +
      '\n  cac cau hinh co excl khac 0 la khap-khenh (khong cung mau), doc PF/winRate cung voi nhau, khong chi PnL$.',
  );
  console.log('buffer'.padEnd(16) + 'n'.padEnd(6) + 'PnL$'.padEnd(14) + 'winRate'.padEnd(10) + 'PF'.padEnd(8) + 'saved'.padEnd(10) + 'cutShort'.padEnd(10) + 'excl');

  const bufferConfigs: { label: string; fn: (t: BaseTrade) => number }[] = [
    { label: '0.2% fee', fn: feeBufferFn },
    { label: '0.5% fixed', fn: (t) => t.entryPrice * 0.005 },
    { label: '1x ATR_M15', fn: (t) => t.atrM15AtEntry },
    { label: '1.5x ATR_M15', fn: (t) => t.atrM15AtEntry * 1.5 },
  ];

  let bestB: { label: string; pnl: number; excluded: number } = { label: bufferConfigs[0].label, pnl: -Infinity, excluded: 0 };
  const bResultsByLabel = new Map<string, SimResult[]>();
  for (const cfg of bufferConfigs) {
    const results = filled.map((t) => simulateTrade(m15Map.get(t.symbol)!, t, bestA.trig, cfg.fn(t)));
    bResultsByLabel.set(cfg.label, results);
    const s = summarize(results);
    const saved = results.filter((r) => r.classLabel === 'SAVED').length;
    const cutShort = results.filter((r) => r.classLabel === 'CUT_SHORT').length;
    const excluded = results.filter((r) => r.classLabel === 'BUFFER_EXCEEDS_TARGET').length;
    console.log(cfg.label.padEnd(16) + statsRow(s, saved, cutShort, excluded));
    if (s.pnl > bestB.pnl) bestB = { label: cfg.label, pnl: s.pnl, excluded };
  }
  console.log(
    `  -> Sweep B highest raw PnL$: buffer=${bestB.label} ($${bestB.pnl.toFixed(2)})` +
      (bestB.excluded > 0 ? `  (CANH BAO: n loai tru ${bestB.excluded}/358 — khong cung mau voi baseline n=358, xem PF/winRate truoc khi ket luan)` : ''),
  );

  const bestBufferFn = bufferConfigs.find((c) => c.label === bestB.label)!.fn;
  console.log(`\n=== Breakdown 5 coin cho cau hinh tot nhat cua Sweep B (trigger=${bestA.trig}R, buffer=${bestB.label}) ===`);
  console.log('symbol'.padEnd(12) + 'n'.padEnd(6) + 'PnL$'.padEnd(14) + 'winRate'.padEnd(10) + 'PF'.padEnd(8) + 'saved'.padEnd(10) + 'cutShort'.padEnd(10) + 'excl');
  for (const symbol of symbols) {
    const symbolTrades = filled.filter((t) => t.symbol === symbol);
    const results = symbolTrades.map((t) => simulateTrade(m15Map.get(symbol)!, t, bestA.trig, bestBufferFn(t)));
    const s = summarize(results);
    const saved = results.filter((r) => r.classLabel === 'SAVED').length;
    const cutShort = results.filter((r) => r.classLabel === 'CUT_SHORT').length;
    const excluded = results.filter((r) => r.classLabel === 'BUFFER_EXCEEDS_TARGET').length;
    console.log(symbol.padEnd(12) + statsRow(s, saved, cutShort, excluded));
  }

  console.log('\n=== Ket luan (chi bao cao, khong tu chot huong) ===');
  console.log(`  Baseline (n=358): $${baseline.pnl.toFixed(2)}, PF=${baseline.profitFactor.toFixed(2)}, winRate=${baseline.winRate.toFixed(1)}%`);
  console.log(`  Sweep A best (trigger=${bestA.trig}R, n=358, cung mau baseline): $${bestA.pnl.toFixed(2)}`);
  console.log(
    `  Sweep B highest raw PnL$ (buffer=${bestB.label}, n=${358 - bestB.excluded}${bestB.excluded > 0 ? `, loai ${bestB.excluded} lenh khong the ap dung stop nay` : ''}): $${bestB.pnl.toFixed(2)}`,
  );
  const sweepAWins = bestA.pnl > baseline.pnl;
  const sweepBRawWins = bestB.pnl > baseline.pnl;
  console.log(
    `  -> Sweep A (cung mau n=358 voi baseline): ${sweepAWins ? 'VUOT' : 'KHONG vuot'} baseline ve PnL$.`,
  );
  console.log(
    `  -> Sweep B (${bestB.excluded > 0 ? `n khac mau, ${bestB.excluded} lenh bi loai` : 'cung mau'}): PnL$ tho ${sweepBRawWins ? 'cao hon' : 'thap hon'} baseline` +
      (bestB.excluded > 0
        ? ' — NHUNG day la so sanh khap khenh (mau nho hon), KHONG nen dung lam bang chung "vuot baseline" ma khong doi chieu lai voi cung mau 358 lenh.'
        : '.'),
  );
  if (!sweepAWins && !sweepBRawWins) {
    console.log(
      '  -> KHONG co hang nao (kể cả các hang co n nho hon do loai buffer-vuot-target) vuot baseline ve PnL$' +
        ' -> bang chung du manh o ca 2 sweep de tam dung huong breakeven-only va chuyen huong khac (vd breaksKeyZone sizing), theo dung "Khong lam" cua ticket.',
    );
  } else if (!sweepAWins && sweepBRawWins && bestB.excluded > 0) {
    console.log(
      '  -> Sweep A khong vuot baseline tren cung mau, Sweep B chi "vuot" tren mau nho hon (khap khenh)' +
        ' -> CHUA du bang chung sach; can doc ky ca hai truoc khi Vinh Tam quyet.',
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
