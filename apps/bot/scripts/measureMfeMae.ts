import { readFile, writeFile } from 'node:fs/promises';
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

// TICKET-RT-034: measure the real MFE/MAE path of the 358 FVG trades confirmed in RT-033
// (DEFAULT_FVG_CONFIG.minCandle2BodyRatio=0.7, DEFAULT_FVG_STRATEGY_CONFIG.targetRMultiple=1.5,
// minSlPctFloor=0.5%). This script does NOT change entry/exit logic — it re-runs the exact same
// scan as strategy1MeasureFvg.ts's findTrades() (same detectFvg/checkNoTradeZone/classifyTrendH1/
// calculatePositionSize/findKeyZones calls, same config imports, same fill/timeout/floor rules),
// duplicated here only because that script's findTrades()/Trade type are not exported and don't
// carry entryIndex — needed to walk the post-entry candle path for MFE/MAE. No threshold, no
// entry/exit condition, and no config value here differs from strategy1MeasureFvg.ts/fvg.ts/
// fvgStrategyConfig.ts. Measurement only — no breakeven/trailing threshold is proposed here.

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
const SWEEP_CONFIG = {
  minCandle2BodyRatio: DEFAULT_FVG_CONFIG.minCandle2BodyRatio,
  maxWaitCandles: DEFAULT_FVG_STRATEGY_CONFIG.maxWaitCandles,
  targetRMultiple: DEFAULT_FVG_STRATEGY_CONFIG.targetRMultiple,
};

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

interface PathMetrics {
  outcome: Outcome;
  mfeR: number;
  maeR: number;
  barsToMFE: number;
  barsToOutcome: number;
}

interface Trade {
  symbol: string;
  direction: Direction;
  entryIndex: number;
  entryTime: number;
  entryPrice: number;
  slPrice: number;
  tpPrice: number;
  slPct: number;
  path: PathMetrics;
}

// Mirrors strategy1MeasureFvg.ts's scanOutcome() exactly (same touch conditions, same SL-before-TP
// priority order), while additionally tracking the running MFE/MAE (in R, R = slDistance) at every
// candle along the way.
function scanOutcomeWithPath(
  m15All: Candle[],
  entryIndex: number,
  direction: Direction,
  entryPrice: number,
  slPrice: number,
  tpPrice: number,
  slDistance: number,
): PathMetrics {
  let maxFavorable = 0;
  let maxAdverse = 0;
  let barsToMFE = 0;

  for (let j = entryIndex + 1; j < m15All.length; j++) {
    const candle = m15All[j];
    const favorable = direction === 'LONG' ? candle.high - entryPrice : entryPrice - candle.low;
    const adverse = direction === 'LONG' ? entryPrice - candle.low : candle.high - entryPrice;
    if (favorable > maxFavorable) {
      maxFavorable = favorable;
      barsToMFE = j - entryIndex;
    }
    if (adverse > maxAdverse) maxAdverse = adverse;

    const slTouched = direction === 'LONG' ? candle.low <= slPrice : candle.high >= slPrice;
    const tpTouched = direction === 'LONG' ? candle.high >= tpPrice : candle.low <= tpPrice;
    if (slTouched) {
      return { outcome: 'SL', mfeR: maxFavorable / slDistance, maeR: maxAdverse / slDistance, barsToMFE, barsToOutcome: j - entryIndex };
    }
    if (tpTouched) {
      return { outcome: 'TP', mfeR: maxFavorable / slDistance, maeR: maxAdverse / slDistance, barsToMFE, barsToOutcome: j - entryIndex };
    }
  }

  return {
    outcome: 'STILL_OPEN',
    mfeR: maxFavorable / slDistance,
    maeR: maxAdverse / slDistance,
    barsToMFE,
    barsToOutcome: m15All.length - 1 - entryIndex,
  };
}

async function findTrades(symbol: string, dataDir: string): Promise<Trade[]> {
  const h1All = await readCsv(path.join(dataDir, `${symbol}_1h.csv`));
  const m15All = await readCsv(path.join(dataDir, `${symbol}_15m.csv`));
  const leverage = LEVERAGE[symbol];

  let h1Cursor = 0;
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
            pending.direction === 'LONG'
              ? entryPrice + SWEEP_CONFIG.targetRMultiple * slDistance
              : entryPrice - SWEEP_CONFIG.targetRMultiple * slDistance;
          const sizing = calculatePositionSize({
            balance: BALANCE,
            riskUsd: RISK_USD,
            entryPrice,
            slPrice,
            leverage,
            maxMarginPct: DEFAULT_MAX_MARGIN_PCT,
          });
          if (sizing) {
            const pathMetrics = scanOutcomeWithPath(m15All, i, pending.direction, entryPrice, slPrice, tpPrice, slDistance);
            trades.push({
              symbol,
              direction: pending.direction,
              entryIndex: i,
              entryTime: m15All[i].openTime,
              entryPrice,
              slPrice,
              tpPrice,
              slPct: (slDistance / entryPrice) * 100,
              path: pathMetrics,
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
      void cachedZones; // TICKET-RT-030 correlation not in scope here; kept only to mirror the identical scan

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

function mean(values: number[]): number {
  if (values.length === 0) return NaN;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function pct(count: number, total: number): string {
  return total > 0 ? `${((count / total) * 100).toFixed(1)}%` : 'n/a';
}

function printGroupStats(label: string, trades: Trade[]): void {
  const mfe = trades.map((t) => t.path.mfeR);
  const mae = trades.map((t) => t.path.maeR);
  console.log(
    `  ${label}: n=${trades.length}  MFE mean=${mean(mfe).toFixed(3)}R median=${median(mfe).toFixed(3)}R  ` +
      `MAE mean=${mean(mae).toFixed(3)}R median=${median(mae).toFixed(3)}R`,
  );
}

async function main() {
  const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'HYPEUSDT', 'XRPUSDT'];
  const dataDir = path.resolve(process.cwd(), 'apps/bot/data');

  let allTrades: Trade[] = [];
  for (const symbol of symbols) {
    const result = await findTrades(symbol, dataDir);
    allTrades = allTrades.concat(result);
  }

  const filled = allTrades.filter((t) => t.slPct >= FLOOR_PCT);
  console.log(`Tong lenh da fill (floor=${FLOOR_PCT}%): n=${filled.length} (ky vong 358, doi chieu RT-033)`);

  const stillOpen = filled.filter((t) => t.path.outcome === 'STILL_OPEN');
  const measured = filled.filter((t) => t.path.outcome !== 'STILL_OPEN');
  console.log(`  Trong do STILL_OPEN (chua co outcome TP/SL, loai khoi do MFE/MAE): ${stillOpen.length}`);
  console.log(`  So lenh do MFE/MAE (outcome=TP hoac SL): n=${measured.length}`);

  const wins = measured.filter((t) => t.path.outcome === 'TP');
  const losses = measured.filter((t) => t.path.outcome === 'SL');

  const winsWithMfeGe1R = wins.filter((t) => t.path.mfeR >= 1).length;
  const lossesWithMfeGe1R = losses.filter((t) => t.path.mfeR >= 1).length;
  const lossesWithPositiveMfe = losses.filter((t) => t.path.mfeR > 0);

  console.log('\n=== 1) Bang tong (n=' + measured.length + ') ===');
  console.log(`  TP: ${wins.length} (${pct(wins.length, measured.length)})   SL: ${losses.length} (${pct(losses.length, measured.length)})`);
  console.log(`  % lenh THANG co MFE>=1R truoc khi thang: ${pct(winsWithMfeGe1R, wins.length)} (${winsWithMfeGe1R}/${wins.length})`);
  console.log(`  % lenh THUA co MFE>=1R truoc khi thua:   ${pct(lossesWithMfeGe1R, losses.length)} (${lossesWithMfeGe1R}/${losses.length})`);
  console.log(
    `  % lenh THUA tung co loi duong (MFE>0) truoc khi thua: ${pct(lossesWithPositiveMfe.length, losses.length)} (${lossesWithPositiveMfe.length}/${losses.length}), ` +
      `MFE trung binh trong nhom nay=${mean(lossesWithPositiveMfe.map((t) => t.path.mfeR)).toFixed(3)}R`,
  );
  printGroupStats('MFE/MAE - lenh THANG', wins);
  printGroupStats('MFE/MAE - lenh THUA', losses);

  console.log('\n=== 2) Breakdown theo tung coin ===');
  for (const symbol of symbols) {
    const symbolTrades = measured.filter((t) => t.symbol === symbol);
    const symbolWins = symbolTrades.filter((t) => t.path.outcome === 'TP');
    const symbolLosses = symbolTrades.filter((t) => t.path.outcome === 'SL');
    console.log(`\n${symbol}: n=${symbolTrades.length} (TP=${symbolWins.length}, SL=${symbolLosses.length})`);
    const symWinsGe1R = symbolWins.filter((t) => t.path.mfeR >= 1).length;
    const symLossGe1R = symbolLosses.filter((t) => t.path.mfeR >= 1).length;
    console.log(`  % THANG MFE>=1R: ${pct(symWinsGe1R, symbolWins.length)}   % THUA MFE>=1R: ${pct(symLossGe1R, symbolLosses.length)}`);
    printGroupStats('MFE/MAE - THANG', symbolWins);
    printGroupStats('MFE/MAE - THUA', symbolLosses);
  }

  const csvDir = path.resolve(process.cwd(), 'apps/bot/data');
  const csvPath = path.join(csvDir, 'mfeMaeRaw.csv');
  const header = 'symbol,entryTime,direction,R_sl,outcome,MFE_R,MAE_R,barsToMFE,barsToOutcome';
  const rows = measured.map((t) =>
    [
      t.symbol,
      new Date(t.entryTime).toISOString(),
      t.direction,
      Math.abs(t.entryPrice - t.slPrice).toFixed(8),
      t.path.outcome,
      t.path.mfeR.toFixed(4),
      t.path.maeR.toFixed(4),
      t.path.barsToMFE,
      t.path.barsToOutcome,
    ].join(','),
  );
  await writeFile(csvPath, [header, ...rows].join('\n') + '\n', 'utf8');
  console.log(`\nCSV thu da luu: ${csvPath} (${rows.length} dong)`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
