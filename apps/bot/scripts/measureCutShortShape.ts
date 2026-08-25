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

// TICKET-RT-040: measure the path shape of the exact "cat non" trade set identified in RT-039 Sweep
// B's best clean config (trigger=1.2R, buffer=0.5% fixed on entry, n=358 same sample, 82 cut-short
// trades) — before/after the breakeven-stop touch. Entry detection and the trigger/breakeven
// simulation are duplicated verbatim from RT-034/036/037/038/039 (same detectFvg/checkNoTradeZone/
// classifyTrendH1/calculatePositionSize/config imports, same scanTouch/simulateTrade logic as
// RT-039) for the same reason each time: strategy1MeasureFvg.ts's findTrades()/Trade aren't exported
// and don't carry entryIndex/raw path. fvg.ts/fvgStrategyConfig.ts untouched. Measurement only — no
// buffer number is proposed here, per the ticket's "Khong lam".

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

// This ticket's exact config, taken from RT-039 Sweep B's best clean (non-excluded) row:
const TRIGGER_R = 1.2;
const BUFFER_PCT = 0.005; // 0.5% fixed, same as RT-039 Sweep B's "0.5% fixed" row

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
  baselineExitIndex: number;
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
            const baselineScan = scanTouch(m15All, i, pending.direction, slPrice, tpPrice);
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
              baselineOutcome: baselineScan.outcome,
              baselineExitIndex: baselineScan.index,
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

interface CutShortTrade {
  symbol: string;
  triggerIndex: number; // phase1: candle where 1.2R trigger was first touched
  stopIndex: number; // phase2: candle where breakeven-stop was touched
  mfeBeforeReversalR: number; // metric 1
  pullbackDepthR: number; // metric 2
  barsTriggerToStop: number; // metric 3
  barsRecoverToTP: number; // metric 4 (raw, can be <=0 — see sameCandleArtifact note below)
  sameCandleArtifact: boolean; // baseline's TP touch is on the SAME M15 candle as the trigger touch
}

// Identifies the exact RT-039 Sweep B "cat non" set (trigger=1.2R, buffer=0.5% fixed) and measures
// the 4 path-shape metrics the ticket asks for, from the raw M15 candles.
function findCutShortTrades(m15All: Candle[], t: BaseTrade): CutShortTrade | null {
  if (t.baselineOutcome !== 'TP') return null; // only baseline winners can be "cat non"

  const triggerPrice = t.direction === 'LONG' ? t.entryPrice + TRIGGER_R * t.slDistance : t.entryPrice - TRIGGER_R * t.slDistance;
  const bufferPrice = t.entryPrice * BUFFER_PCT;
  const breakevenSlPrice = t.direction === 'LONG' ? t.entryPrice + bufferPrice : t.entryPrice - bufferPrice;

  const phase1 = scanTouch(m15All, t.entryIndex, t.direction, t.slPrice, triggerPrice);
  if (phase1.outcome !== 'TP') return null; // never reached trigger (or SL/STILL_OPEN) — not this set

  const phase2 = scanTouch(m15All, phase1.index, t.direction, breakevenSlPrice, t.tpPrice);
  if (phase2.outcome !== 'SL') return null; // reached TP2 anyway, or STILL_OPEN — not "cat non"

  // Metric 1: peak favorable R reached from entry up to the stop-out candle (inclusive) — the
  // running max necessarily captures wherever the true reversal point was.
  let maxFavorable = 0;
  for (let j = t.entryIndex + 1; j <= phase2.index; j++) {
    const candle = m15All[j];
    const favorable = t.direction === 'LONG' ? candle.high - t.entryPrice : t.entryPrice - candle.low;
    if (favorable > maxFavorable) maxFavorable = favorable;
  }
  const mfeBeforeReversalR = maxFavorable / t.slDistance;

  // Metric 2: depth from that peak down to the breakeven-stop price, in R.
  const stopR = bufferPrice / t.slDistance;
  const pullbackDepthR = mfeBeforeReversalR - stopR;

  // Metric 3: bars from the trigger-touch candle to the stop-touch candle.
  const barsTriggerToStop = phase2.index - phase1.index;

  // Metric 4: bars from the stop-touch point to when the UNCUT baseline path actually reaches TP.
  // Since trigger price (1.2R) < TP price (1.5R), the trigger-touch candle is always <= the baseline
  // TP-touch candle (t.baselineExitIndex >= phase1.index, always). But when a single volatile M15
  // candle's range spans BOTH levels (common at the 0.5% floor's tight R), baseline records its TP
  // touch on that SAME candle (t.baselineExitIndex === phase1.index), while this phase1/phase2 split
  // (same design as RT-039) only starts checking for a stop-touch on the candle AFTER the trigger —
  // so a stop hit on the very next candle yields a negative/zero raw value here. This is a real M15
  // candle-granularity limit (no tick data), not a bug — reported both raw and floored, see output.
  const barsRecoverToTP = t.baselineExitIndex - phase2.index;
  const sameCandleArtifact = t.baselineExitIndex === phase1.index;

  return {
    symbol: t.symbol,
    triggerIndex: phase1.index,
    stopIndex: phase2.index,
    mfeBeforeReversalR,
    pullbackDepthR,
    barsTriggerToStop,
    barsRecoverToTP,
    sameCandleArtifact,
  };
}

function mean(values: number[]): number {
  if (values.length === 0) return NaN;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function median(values: number[]): number {
  return percentile([...values].sort((a, b) => a - b), 0.5);
}

function printStatRow(label: string, values: number[], unit = ''): void {
  const s = [...values].sort((a, b) => a - b);
  console.log(
    `  ${label}: n=${s.length}  mean=${mean(s).toFixed(3)}${unit}  median=${median(s).toFixed(3)}${unit}  p25=${percentile(s, 0.25).toFixed(3)}${unit}  p75=${percentile(s, 0.75).toFixed(3)}${unit}`,
  );
}

function printFullPercentileRow(label: string, values: number[], unit = ''): void {
  const s = [...values].sort((a, b) => a - b);
  console.log(
    `  ${label}: n=${s.length}  p10=${percentile(s, 0.1).toFixed(3)}${unit}  p25=${percentile(s, 0.25).toFixed(3)}${unit}  p50=${percentile(s, 0.5).toFixed(3)}${unit}  ` +
      `p75=${percentile(s, 0.75).toFixed(3)}${unit}  p90=${percentile(s, 0.9).toFixed(3)}${unit}  p95=${percentile(s, 0.95).toFixed(3)}${unit}  max=${s[s.length - 1].toFixed(3)}${unit}`,
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
  console.log(`Tong lenh da fill: n=${filled.length} (ky vong 358)`);

  const cutShortTrades = filled
    .map((t) => findCutShortTrades(m15Map.get(t.symbol)!, t))
    .filter((r): r is CutShortTrade => r !== null);

  console.log(`So lenh "cat non" (trigger=${TRIGGER_R}R, buffer=${BUFFER_PCT * 100}%): n=${cutShortTrades.length} (ky vong 82, doi chieu RT-039 Sweep B "0.5% fixed" row)`);

  console.log('\n=== Bang thong ke 4 chi so (n=' + cutShortTrades.length + ') ===');
  printStatRow('1) MFE truoc khi hoi', cutShortTrades.map((c) => c.mfeBeforeReversalR), 'R');
  printStatRow('2) Do sau hoi nguoc', cutShortTrades.map((c) => c.pullbackDepthR), 'R');
  printStatRow('3) So nen trigger->stop', cutShortTrades.map((c) => c.barsTriggerToStop), ' nen');
  printStatRow('4) So nen phuc hoi toi TP (RAW, co the am)', cutShortTrades.map((c) => c.barsRecoverToTP), ' nen');
  const sameCandleCount = cutShortTrades.filter((c) => c.sameCandleArtifact).length;
  console.log(
    `     LUU Y chi so 4: ${sameCandleCount}/${cutShortTrades.length} lenh co trigger(1.2R) va TP(1.5R) goc cung nam trong 1 nen M15` +
      ` (nen bien dong manh) — phase2 (do o day) chi bat dau kiem tra stop TU NEN SAU trigger, nen "so nen phuc hoi" co the am/0` +
      ' trong cac truong hop nay. Day la gioi han do phan giai M15 (khong co du lieu tick), khong phai loi tinh toan.',
  );
  printStatRow('4b) So nen phuc hoi toi TP (floor tai 0)', cutShortTrades.map((c) => Math.max(0, c.barsRecoverToTP)), ' nen');

  console.log('\n=== Phan phoi day du: Do sau hoi nguoc (chi so 2 — quan trong nhat) ===');
  printFullPercentileRow('Do sau hoi nguoc', cutShortTrades.map((c) => c.pullbackDepthR), 'R');

  console.log('\n=== Breakdown theo tung coin: Do sau hoi nguoc ===');
  for (const symbol of symbols) {
    const symbolValues = cutShortTrades.filter((c) => c.symbol === symbol).map((c) => c.pullbackDepthR);
    if (symbolValues.length === 0) {
      console.log(`  ${symbol.padEnd(10)}: n=0`);
      continue;
    }
    printFullPercentileRow(symbol.padEnd(10), symbolValues, 'R');
  }

  console.log('\n=== Breakdown theo tung coin: ca 4 chi so (mean/median) ===');
  for (const symbol of symbols) {
    const symbolTrades = cutShortTrades.filter((c) => c.symbol === symbol);
    if (symbolTrades.length === 0) {
      console.log(`\n${symbol}: n=0`);
      continue;
    }
    console.log(`\n${symbol}: n=${symbolTrades.length}`);
    printStatRow('  MFE truoc hoi', symbolTrades.map((c) => c.mfeBeforeReversalR), 'R');
    printStatRow('  Do sau hoi', symbolTrades.map((c) => c.pullbackDepthR), 'R');
    printStatRow('  Nen trigger->stop', symbolTrades.map((c) => c.barsTriggerToStop), ' nen');
    printStatRow('  Nen phuc hoi->TP', symbolTrades.map((c) => c.barsRecoverToTP), ' nen');
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
