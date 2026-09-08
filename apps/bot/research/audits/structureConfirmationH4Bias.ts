import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Candle } from '../../backtest/engine/noTradeZone/types.js';
import { computeAtr } from '../../backtest/engine/noTradeZone/atr.js';

// TICKET-04X-AB: does H4 EMA50 bias line up with TICKET-04X-AA's Part1/Part3 continuation
// touches, and does it matter for profitableEnough? Pure descriptive, no PnL. EMA50/H4 definition
// and the +2.67R/-1R/R=1xATR15 convention are locked BEFORE running, never changed after.
const H4_MS = 4 * 60 * 60 * 1000;
const EMA_PERIOD = 50;
const ATR_PERIOD = 15;
const FAVORABLE_R = 8 / 3; // +2.67R, same as AA
const ADVERSE_R = 1; // -1R, same as AA
const HORIZONS = [5, 10, 20];
const Z_95 = 1.959963985;

type Bias = 'UP' | 'DOWN';
type BiasGroup = 'TOAN_BO' | 'CUNG_BIAS' | 'NGUOC_BIAS';

interface TouchEventRaw {
  touchIndex: number;
  openTime: number;
}

async function loadCsv(csvPath: string): Promise<Candle[]> {
  const rows = (await readFile(csvPath, 'utf8')).trim().split(/\r?\n/u).slice(1);
  return rows.map((row) => {
    const [openTime, open, high, low, close, volume] = row.split(',').map(Number);
    return { openTime, open, high, low, close, volume } satisfies Candle;
  });
}

// Same pattern as h1Aggregator.ts's aggregateM15ToClosedH1, generalized to a 4-hour window:
// emits an H4 candle only when all 16 M15 children are present, contiguous, and start on a
// round UTC 4h boundary. Any trailing partial group is silently dropped (causal contract).
function aggregateM15ToClosedH4(m15Candles: readonly Candle[]): Candle[] {
  const M15_MS = 15 * 60 * 1000;
  const GROUP_SIZE = H4_MS / M15_MS;
  const closedH4: Candle[] = [];
  let index = 0;
  while (index + GROUP_SIZE <= m15Candles.length) {
    const start = m15Candles[index];
    if (start.openTime % H4_MS !== 0) {
      index += 1;
      continue;
    }
    const group = m15Candles.slice(index, index + GROUP_SIZE);
    const contiguous = group.every((candle, offset) => candle.openTime === start.openTime + offset * M15_MS);
    if (!contiguous) {
      index += 1;
      continue;
    }
    closedH4.push({
      openTime: start.openTime,
      open: group[0].open,
      high: Math.max(...group.map((c) => c.high)),
      low: Math.min(...group.map((c) => c.low)),
      close: group[GROUP_SIZE - 1].close,
      volume: group.reduce((sum, c) => sum + c.volume, 0),
    });
    index += GROUP_SIZE;
  }
  return closedH4;
}

// Standard EMA: SMA-seeded, then the usual recursive smoothing. Entries before the seed are null.
function computeEma(closes: readonly number[], period = EMA_PERIOD): Array<number | null> {
  const result: Array<number | null> = new Array(closes.length).fill(null);
  if (closes.length < period) return result;
  const seed = closes.slice(0, period).reduce((sum, v) => sum + v, 0) / period;
  result[period - 1] = seed;
  const k = 2 / (period + 1);
  let previous = seed;
  for (let i = period; i < closes.length; i += 1) {
    previous = closes[i] * k + previous * (1 - k);
    result[i] = previous;
  }
  return result;
}

// Last CLOSED H4 candle strictly before `beforeOpenTime` (closeTime = openTime + H4_MS <=
// beforeOpenTime) -- avoids any lookahead into the H4 bar the touch itself falls inside.
function findLastClosedH4Index(h4Candles: readonly Candle[], beforeOpenTime: number): number {
  let left = 0;
  let right = h4Candles.length;
  while (left < right) {
    const mid = (left + right) >>> 1;
    if (h4Candles[mid].openTime + H4_MS <= beforeOpenTime) left = mid + 1;
    else right = mid;
  }
  return left - 1;
}

function biasAt(h4Candles: readonly Candle[], ema50H4: Array<number | null>, beforeOpenTime: number): Bias | null {
  const h4Idx = findLastClosedH4Index(h4Candles, beforeOpenTime);
  if (h4Idx < 0) return null;
  const ema = ema50H4[h4Idx];
  if (ema === null) return null;
  return h4Candles[h4Idx].close > ema ? 'UP' : 'DOWN';
}

function classifyFirstTouchR(
  candles: readonly Candle[],
  startIdxInclusive: number,
  horizon: number,
  entryPrice: number,
  riskPerUnit: number,
  direction: 'up' | 'down',
): 'PROFIT' | 'NOT_PROFIT' | 'INSUFFICIENT_DATA' {
  const endIdxExclusive = startIdxInclusive + horizon;
  if (endIdxExclusive > candles.length) return 'INSUFFICIENT_DATA';
  let favIdx: number | null = null;
  let advIdx: number | null = null;
  for (let k = startIdxInclusive; k < endIdxExclusive; k += 1) {
    const c = candles[k];
    const favorable = direction === 'up' ? (c.high - entryPrice) / riskPerUnit : (entryPrice - c.low) / riskPerUnit;
    const adverse = direction === 'up' ? (entryPrice - c.low) / riskPerUnit : (c.high - entryPrice) / riskPerUnit;
    if (favIdx === null && favorable >= FAVORABLE_R) favIdx = k;
    if (advIdx === null && adverse >= ADVERSE_R) advIdx = k;
  }
  if (favIdx !== null && (advIdx === null || favIdx < advIdx)) return 'PROFIT';
  return 'NOT_PROFIT';
}

// Wilson score interval, 95%. Chosen over the naive Wald interval for better behavior at
// small n and proportions near 0/100%, which several groups here run into.
function wilson95(successCount: number, n: number): { lower: number; upper: number } | null {
  if (n === 0) return null;
  const phat = successCount / n;
  const z2 = Z_95 * Z_95;
  const denom = 1 + z2 / n;
  const center = phat + z2 / (2 * n);
  const margin = Z_95 * Math.sqrt((phat * (1 - phat)) / n + z2 / (4 * n * n));
  return { lower: (100 * Math.max(0, center - margin)) / denom, upper: (100 * Math.min(1, center + margin)) / denom };
}

interface Enriched {
  touchIndex: number;
  bias: Bias | null;
}

function computeSide(
  continuationDirection: 'up' | 'down',
  touches: readonly TouchEventRaw[],
  h4Candles: readonly Candle[],
  ema50H4: Array<number | null>,
  candles: readonly Candle[],
  atrSeries: readonly number[],
) {
  const enriched: Enriched[] = touches.map((t) => ({ touchIndex: t.touchIndex, bias: biasAt(h4Candles, ema50H4, t.openTime) }));
  const matchingBias: Bias = continuationDirection === 'up' ? 'UP' : 'DOWN';
  const excludedNoH4Bias = enriched.filter((e) => e.bias === null).length;

  const groups: Record<BiasGroup, Enriched[]> = {
    TOAN_BO: enriched,
    CUNG_BIAS: enriched.filter((e) => e.bias === matchingBias),
    NGUOC_BIAS: enriched.filter((e) => e.bias !== null && e.bias !== matchingBias),
  };

  const perHorizon = Object.fromEntries(
    HORIZONS.map((h) => {
      const byGroup = Object.fromEntries(
        (Object.keys(groups) as BiasGroup[]).map((g) => {
          let n = 0;
          let profitCount = 0;
          for (const item of groups[g]) {
            const atrIdx = item.touchIndex - ATR_PERIOD;
            if (atrIdx < 0 || atrIdx >= atrSeries.length) continue;
            const riskPerUnit = atrSeries[atrIdx];
            const result = classifyFirstTouchR(candles, item.touchIndex + 1, h, candles[item.touchIndex].close, riskPerUnit, continuationDirection);
            if (result === 'INSUFFICIENT_DATA') continue;
            n += 1;
            if (result === 'PROFIT') profitCount += 1;
          }
          return [g, { n, profitCount, profitableEnoughPct: n === 0 ? null : (100 * profitCount) / n, ci95: wilson95(profitCount, n) }];
        }),
      );
      return [`h${h}`, byGroup];
    }),
  );

  return {
    totalTouches: touches.length,
    excludedNoH4Bias,
    cungBiasCount: groups.CUNG_BIAS.length,
    nguocBiasCount: groups.NGUOC_BIAS.length,
    perHorizon,
  };
}

async function main(): Promise<void> {
  const dataDirectory = fileURLToPath(new URL('../../data/', import.meta.url));
  const auditsDirectory = fileURLToPath(new URL('./', import.meta.url));

  console.info('Loading M15 CSV and TICKET-04X-AA output...');
  const candles = await loadCsv(resolve(dataDirectory, 'BTCUSDT_15m_3y.csv'));
  const aa = JSON.parse(await readFile(resolve(auditsDirectory, 'structureConfirmationDescriptive.json'), 'utf8')) as {
    part1_holdingRetraceContinuation_UP: { touchEvents: TouchEventRaw[] };
    part3_symmetric_DOWN: { continuation: { touchEvents: TouchEventRaw[] } };
  };
  console.info(`  M15=${candles.length} part1(UP)=${aa.part1_holdingRetraceContinuation_UP.touchEvents.length} part3(DOWN)=${aa.part3_symmetric_DOWN.continuation.touchEvents.length}`);

  const atrSeries = computeAtr(candles, ATR_PERIOD);
  const h4Candles = aggregateM15ToClosedH4(candles);
  const ema50H4 = computeEma(
    h4Candles.map((c) => c.close),
    EMA_PERIOD,
  );
  console.info(`  H4=${h4Candles.length} ema50 warm from index ${EMA_PERIOD - 1}`);

  const partUP = computeSide('up', aa.part1_holdingRetraceContinuation_UP.touchEvents, h4Candles, ema50H4, candles, atrSeries);
  const partDOWN = computeSide('down', aa.part3_symmetric_DOWN.continuation.touchEvents, h4Candles, ema50H4, candles, atrSeries);

  console.info(`\nUP h20: TOAN_BO n=${partUP.perHorizon.h20.TOAN_BO.n} pct=${partUP.perHorizon.h20.TOAN_BO.profitableEnoughPct?.toFixed(2)}% | CUNG_BIAS n=${partUP.perHorizon.h20.CUNG_BIAS.n} pct=${partUP.perHorizon.h20.CUNG_BIAS.profitableEnoughPct?.toFixed(2)}% | NGUOC_BIAS n=${partUP.perHorizon.h20.NGUOC_BIAS.n} pct=${partUP.perHorizon.h20.NGUOC_BIAS.profitableEnoughPct?.toFixed(2)}%`);
  console.info(`DOWN h20: TOAN_BO n=${partDOWN.perHorizon.h20.TOAN_BO.n} pct=${partDOWN.perHorizon.h20.TOAN_BO.profitableEnoughPct?.toFixed(2)}% | CUNG_BIAS n=${partDOWN.perHorizon.h20.CUNG_BIAS.n} pct=${partDOWN.perHorizon.h20.CUNG_BIAS.profitableEnoughPct?.toFixed(2)}% | NGUOC_BIAS n=${partDOWN.perHorizon.h20.NGUOC_BIAS.n} pct=${partDOWN.perHorizon.h20.NGUOC_BIAS.profitableEnoughPct?.toFixed(2)}%`);

  const output = {
    warning:
      'TICKET-04X-AB: H4_BIAS (EMA50/H4) doi voi cac diem cham NO_BREAK TREND cua TICKET-04X-AA Part1/Part3 -- THUAN MO TA, KHONG PnL. ' +
      'Dinh nghia EMA50/H4 va +2.67R/-1R/R=1xATR15 khoa TRUOC khi chay, khong doi sau khi thay so lieu.',
    generatedAt: new Date().toISOString(),
    emaPeriod: EMA_PERIOD,
    h4Candles: h4Candles.length,
    favorableR: FAVORABLE_R,
    adverseR: ADVERSE_R,
    riskDefinition: `R = 1 x ATR(${ATR_PERIOD})`,
    horizonsM15Candles: HORIZONS,
    ciMethod: 'wilson_score_95pct',
    UP_continuation: partUP,
    DOWN_continuation: partDOWN,
  };

  const outputPath = resolve(auditsDirectory, 'structureConfirmationH4Bias.json');
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  console.info(`\nOutput: ${outputPath}`);
}

await main();
