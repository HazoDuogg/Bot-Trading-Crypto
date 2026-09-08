import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Candle } from '../../backtest/engine/noTradeZone/types.js';
import { computeAtr } from '../../backtest/engine/noTradeZone/atr.js';
import { computeAdxSeries } from '../../core/structure/regimeFilter.js';
import { detectSwingPoints, type SwingPoint } from '../../core/structure/swingPoints.js';

// TICKET-04X-AA: pure descriptive "market structure confirmation" measurement on BTCUSDT M15.
// No PnL/Sharpe anywhere. ADX thresholds (Wilder 1978) locked BEFORE running, not tuned to data.
const ADX_TREND_THRESHOLD = 25;
const ADX_TRANSITION_THRESHOLD = 20;
const ATR_PERIOD = 15; // R = 1 x ATR(15), locked per ticket text before running
const FAVORABLE_R = 8 / 3; // +2.67R
const ADVERSE_R = 1; // -1R
const HORIZONS = [5, 10, 20];
const MAX_TOUCH_SCAN_CANDLES = 10_000; // practical cap (~104 days) bounding per-level scan cost
const MIN_GROUP_N = 30;
const K_MAX = 10;
const DAY_MS = 86_400_000;
const SYMBOL = process.argv[2] ?? 'BTCUSDT'; // TICKET-04X-AC: multi-coin, all other params untouched

type Regime = 'TREND' | 'TRANSITION' | 'SIDEWAY';
type Session = 'ASIA' | 'EUROPE' | 'US';
type DepthBucket = 'SHALLOW' | 'MID' | 'DEEP';
type TouchKind = 'NO_BREAK' | 'BREAK';

interface TouchEvent {
  index: number;
  kind: TouchKind;
}

interface Level {
  swingIndex: number;
  type: 'high' | 'low';
  price: number;
  confirmedIndex: number;
  depthBucket: DepthBucket | null;
  touches: TouchEvent[];
}

interface TouchRecord {
  index: number;
  kind: TouchKind;
  level: Level;
}

interface PctResult {
  n: number;
  trueCount: number;
  pct: number | null;
}

async function loadCsv(csvPath: string): Promise<Candle[]> {
  const rows = (await readFile(csvPath, 'utf8')).trim().split(/\r?\n/u).slice(1);
  return rows.map((row) => {
    const [openTime, open, high, low, close, volume] = row.split(',').map(Number);
    return { openTime, open, high, low, close, volume } satisfies Candle;
  });
}

function classifyRegime3(adx: number | null): Regime | null {
  if (adx === null) return null;
  if (adx >= ADX_TREND_THRESHOLD) return 'TREND';
  if (adx >= ADX_TRANSITION_THRESHOLD) return 'TRANSITION';
  return 'SIDEWAY';
}

function regimeAt(adxSeries: Array<number | null>, index: number): Regime | null {
  return classifyRegime3(adxSeries[index] ?? null);
}

function sessionOf(openTime: number): Session {
  const hour = Math.floor((((openTime % DAY_MS) + DAY_MS) % DAY_MS) / 3_600_000);
  if (hour < 8) return 'ASIA';
  if (hour < 16) return 'EUROPE';
  return 'US';
}

// Standard 3-point Fib retracement: leg A->B (opposite-type swings), C = this swing retracing it.
// Requires a clean zigzag (alternating types) two swings back; otherwise depth is unknown (null).
function computeDepthBuckets(swings: readonly SwingPoint[]): Array<DepthBucket | null> {
  const buckets: Array<DepthBucket | null> = new Array(swings.length).fill(null);
  for (let i = 2; i < swings.length; i += 1) {
    const a = swings[i - 2];
    const b = swings[i - 1];
    const c = swings[i];
    if (a.type === b.type || b.type === c.type) continue;
    const legRange = Math.abs(b.price - a.price);
    if (legRange === 0) continue;
    const ratio = Math.abs(b.price - c.price) / legRange;
    buckets[i] = ratio < 0.382 ? 'SHALLOW' : ratio <= 0.618 ? 'MID' : 'DEEP';
  }
  return buckets;
}

// Sequential touch scan for one reference level: AWAY -> touch (NO_BREAK keeps scanning, BREAK
// terminates) -> back to AWAY once price closes clearly away again. Capped for runtime safety.
function scanTouchSequence(candles: readonly Candle[], price: number, type: 'high' | 'low', startIndex: number): TouchEvent[] {
  const touches: TouchEvent[] = [];
  const endIndex = Math.min(candles.length, startIndex + MAX_TOUCH_SCAN_CANDLES);
  let away = true;
  for (let i = startIndex; i < endIndex; i += 1) {
    const c = candles[i];
    if (type === 'low') {
      if (away) {
        if (c.low <= price) {
          const broke = c.close < price;
          touches.push({ index: i, kind: broke ? 'BREAK' : 'NO_BREAK' });
          if (broke) return touches;
          away = false;
        }
      } else if (c.close > price) {
        away = true;
      }
    } else {
      if (away) {
        if (c.high >= price) {
          const broke = c.close > price;
          touches.push({ index: i, kind: broke ? 'BREAK' : 'NO_BREAK' });
          if (broke) return touches;
          away = false;
        }
      } else if (c.close < price) {
        away = true;
      }
    }
  }
  return touches;
}

function buildLevels(candles: readonly Candle[], swings: readonly SwingPoint[], depthBuckets: Array<DepthBucket | null>): Level[] {
  return swings.map((s, i) => ({
    swingIndex: i,
    type: s.type,
    price: s.price,
    confirmedIndex: s.index,
    depthBucket: depthBuckets[i],
    touches: scanTouchSequence(candles, s.price, s.type, s.index + 1),
  }));
}

// First-touch order of +2.67R vs -1R within [startIdxInclusive, startIdxInclusive+horizon).
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

function pureDirectionCorrect(candles: readonly Candle[], touchIndex: number, horizon: number, direction: 'up' | 'down'): boolean | null {
  const targetIndex = touchIndex + horizon;
  if (targetIndex >= candles.length) return null;
  const base = candles[touchIndex].close;
  const later = candles[targetIndex].close;
  return direction === 'up' ? later > base : later < base;
}

function pctBreakdown<T>(items: readonly T[], truthFn: (item: T) => boolean | null): PctResult {
  let n = 0;
  let trueCount = 0;
  for (const item of items) {
    const v = truthFn(item);
    if (v === null) continue;
    n += 1;
    if (v) trueCount += 1;
  }
  return { n, trueCount, pct: n === 0 ? null : (100 * trueCount) / n };
}

function groupBySession<T>(items: readonly T[], sessionOfItem: (item: T) => Session, truthFn: (item: T) => boolean | null): Record<Session, PctResult> {
  const sessions: Session[] = ['ASIA', 'EUROPE', 'US'];
  return Object.fromEntries(sessions.map((s) => [s, pctBreakdown(items.filter((i) => sessionOfItem(i) === s), truthFn)])) as Record<Session, PctResult>;
}

function groupByDepth<T>(items: readonly T[], depthOfItem: (item: T) => DepthBucket | null, truthFn: (item: T) => boolean | null): Record<DepthBucket, PctResult> {
  const buckets: DepthBucket[] = ['SHALLOW', 'MID', 'DEEP'];
  return Object.fromEntries(buckets.map((b) => [b, pctBreakdown(items.filter((i) => depthOfItem(i) === b), truthFn)])) as Record<DepthBucket, PctResult>;
}

interface ContinuationObs {
  touchIndex: number;
  level: Level;
}

// Parts 1 & 3-continuation: NO_BREAK touches of TREND-regime levels -> pure direction and
// profitable-enough (first-touch +2.67R/-1R) continuation after 5/10/20 candles.
function computeContinuation(
  type: 'low' | 'high',
  touchRecords: readonly TouchRecord[],
  candles: readonly Candle[],
  adxSeries: Array<number | null>,
  atrSeries: readonly number[],
) {
  const direction: 'up' | 'down' = type === 'low' ? 'up' : 'down';
  const obs: ContinuationObs[] = touchRecords
    .filter((t) => t.level.type === type && t.kind === 'NO_BREAK' && regimeAt(adxSeries, t.index) === 'TREND')
    .map((t) => ({ touchIndex: t.index, level: t.level }));

  const perHorizon = Object.fromEntries(
    HORIZONS.map((h) => {
      const pureFn = (o: ContinuationObs) => pureDirectionCorrect(candles, o.touchIndex, h, direction);
      const profitFn = (o: ContinuationObs) => {
        const atrIdx = o.touchIndex - ATR_PERIOD;
        if (atrIdx < 0 || atrIdx >= atrSeries.length) return null;
        const riskPerUnit = atrSeries[atrIdx];
        const result = classifyFirstTouchR(candles, o.touchIndex + 1, h, candles[o.touchIndex].close, riskPerUnit, direction);
        return result === 'INSUFFICIENT_DATA' ? null : result === 'PROFIT';
      };
      return [
        `h${h}`,
        {
          pureDirection: {
            overall: pctBreakdown(obs, pureFn),
            bySession: groupBySession(obs, (o) => sessionOf(candles[o.touchIndex].openTime), pureFn),
            byDepth: groupByDepth(obs, (o) => o.level.depthBucket, pureFn),
          },
          profitableEnough: {
            overall: pctBreakdown(obs, profitFn),
            bySession: groupBySession(obs, (o) => sessionOf(candles[o.touchIndex].openTime), profitFn),
            byDepth: groupByDepth(obs, (o) => o.level.depthBucket, profitFn),
          },
        },
      ];
    }),
  );
  // TICKET-04X-AB reuses this raw list (touchIndex + openTime) as its own input, no logic change.
  return { n: obs.length, perHorizon, touchEvents: obs.map((o) => ({ touchIndex: o.touchIndex, openTime: candles[o.touchIndex].openTime })) };
}

interface BreakRetestObs {
  breakIndex: number;
  level: Level;
  retestKind: TouchKind | null;
}

// Parts 2 & 3-breakRetest: TREND-regime BREAK of a level -> first retest of the SAME price acting
// in the flipped role. NO_BREAK on retest = level holds (real); BREAK on retest = fails (false).
function computeBreakRetest(type: 'low' | 'high', levels: readonly Level[], candles: readonly Candle[], adxSeries: Array<number | null>) {
  const flip: 'low' | 'high' = type === 'low' ? 'high' : 'low';
  const obs: BreakRetestObs[] = [];
  for (const level of levels) {
    if (level.type !== type) continue;
    const lastTouch = level.touches[level.touches.length - 1];
    if (!lastTouch || lastTouch.kind !== 'BREAK') continue;
    if (regimeAt(adxSeries, lastTouch.index) !== 'TREND') continue;
    const retest = scanTouchSequence(candles, level.price, flip, lastTouch.index + 1);
    obs.push({ breakIndex: lastTouch.index, level, retestKind: retest.length > 0 ? retest[0].kind : null });
  }
  const heldFn = (o: BreakRetestObs) => (o.retestKind === null ? null : o.retestKind === 'NO_BREAK');
  return {
    totalBreaks: obs.length,
    noRetestFoundCount: obs.filter((o) => o.retestKind === null).length,
    held: {
      overall: pctBreakdown(obs, heldFn),
      bySession: groupBySession(obs, (o) => sessionOf(candles[o.breakIndex].openTime), heldFn),
      byDepth: groupByDepth(obs, (o) => o.level.depthBucket, heldFn),
    },
  };
}

// Wilson score interval, 95% (copied verbatim from TICKET-04X-AB's structureConfirmationH4Bias.ts
// -- two independent audit scripts, no cross-import between them).
function wilson95(successCount: number, n: number): { lower: number; upper: number } | null {
  if (n === 0) return null;
  const z = 1.959963985;
  const phat = successCount / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = phat + z2 / (2 * n);
  const margin = z * Math.sqrt((phat * (1 - phat)) / n + z2 / (4 * n * n));
  return { lower: (100 * Math.max(0, center - margin)) / denom, upper: (100 * Math.min(1, center + margin)) / denom };
}

// Part 4: touches occurring while regime=SIDEWAY -> % NO_BREAK ("bật lại" off the boundary),
// plus profitableEnough on the NO_BREAK subset, split by boundary type and pooled (ALL).
function computePart4(touchRecords: readonly TouchRecord[], candles: readonly Candle[], adxSeries: Array<number | null>, atrSeries: readonly number[]) {
  const obs = touchRecords.filter((t) => regimeAt(adxSeries, t.index) === 'SIDEWAY');
  const bounceFn = (t: TouchRecord) => t.kind === 'NO_BREAK';
  const bounceObs = obs.filter((t) => t.kind === 'NO_BREAK');
  const direction = (t: TouchRecord): 'up' | 'down' => (t.level.type === 'low' ? 'up' : 'down');

  const profitableEnough = Object.fromEntries(
    HORIZONS.map((h) => {
      const profitFn = (t: TouchRecord) => {
        const atrIdx = t.index - ATR_PERIOD;
        if (atrIdx < 0 || atrIdx >= atrSeries.length) return null;
        const riskPerUnit = atrSeries[atrIdx];
        const result = classifyFirstTouchR(candles, t.index + 1, h, candles[t.index].close, riskPerUnit, direction(t));
        return result === 'INSUFFICIENT_DATA' ? null : result === 'PROFIT';
      };
      const byGroup = (['ALL', 'low', 'high'] as const).map((g) => {
        const subset = g === 'ALL' ? bounceObs : bounceObs.filter((t) => t.level.type === g);
        const r = pctBreakdown(subset, profitFn);
        return [g, { n: r.n, profitCount: r.trueCount, profitableEnoughPct: r.pct, ci95: wilson95(r.trueCount, r.n) }];
      });
      return [`h${h}`, Object.fromEntries(byGroup)];
    }),
  );

  return {
    n: obs.length,
    overall: pctBreakdown(obs, bounceFn),
    bySession: groupBySession(obs, (t) => sessionOf(candles[t.index].openTime), bounceFn),
    byDepth: groupByDepth(obs, (t) => t.level.depthBucket, bounceFn),
    profitableEnough,
  };
}

// Part 5: given K consecutive NO_BREAK ("thất bại") touches, % of the (K+1)th touch that is BREAK.
// Pooled across all regimes. n<30 groups are omitted entirely, per ticket.
function computePart5(levels: readonly Level[], type: 'low' | 'high') {
  const subset = levels.filter((l) => l.type === type);
  const buckets: Array<{ k: number; n: number; breakCount: number; breakPct: number }> = [];
  for (let k = 1; k <= K_MAX; k += 1) {
    const qualifying = subset.filter((l) => l.touches.length >= k && l.touches[k - 1].kind === 'NO_BREAK');
    const withNext = qualifying.filter((l) => l.touches.length > k);
    const n = withNext.length;
    if (n < MIN_GROUP_N) continue;
    const breakCount = withNext.filter((l) => l.touches[k].kind === 'BREAK').length;
    buckets.push({ k, n, breakCount, breakPct: (100 * breakCount) / n });
  }
  return buckets;
}

// Part 6: every sequential touch of every level, labeled BREAK/NO_BREAK, grouped by touch number
// K=1..4 and 5+. Denominator includes NO_BREAK touches (levels never broken are still counted).
function computePart6(levels: readonly Level[], filterType?: 'low' | 'high') {
  const subset = filterType ? levels.filter((l) => l.type === filterType) : levels;
  const buckets: Array<{ kLabel: string; n: number; breakCount: number; breakPct: number | null }> = [];
  for (let k = 1; k <= 5; k += 1) {
    const entries: TouchEvent[] = [];
    for (const level of subset) {
      if (k < 5) {
        if (level.touches.length >= k) entries.push(level.touches[k - 1]);
      } else {
        for (let pos = 4; pos < level.touches.length; pos += 1) entries.push(level.touches[pos]);
      }
    }
    const n = entries.length;
    const breakCount = entries.filter((e) => e.kind === 'BREAK').length;
    buckets.push({ kLabel: k < 5 ? String(k) : '5+', n, breakCount, breakPct: n === 0 ? null : (100 * breakCount) / n });
  }
  return buckets;
}

async function main(): Promise<void> {
  const dataDirectory = fileURLToPath(new URL('../../data/', import.meta.url));
  const auditsDirectory = fileURLToPath(new URL('./', import.meta.url));

  console.info(`Loading M15 CSV for ${SYMBOL}...`);
  const candles = await loadCsv(resolve(dataDirectory, `${SYMBOL}_15m_3y.csv`));
  console.info(`  M15=${candles.length}`);

  const adxSeries = computeAdxSeries(candles);
  const atrSeries = computeAtr(candles, ATR_PERIOD);
  const swings = detectSwingPoints(candles);
  const depthBuckets = computeDepthBuckets(swings);
  console.info(`  swings=${swings.length} (highs=${swings.filter((s) => s.type === 'high').length}, lows=${swings.filter((s) => s.type === 'low').length})`);

  console.info('Scanning touch sequences for every reference level...');
  const startedAt = Date.now();
  const levels = buildLevels(candles, swings, depthBuckets);
  const touchRecords: TouchRecord[] = [];
  for (const level of levels) for (const t of level.touches) touchRecords.push({ index: t.index, kind: t.kind, level });
  console.info(`  total touches=${touchRecords.length} elapsed=${((Date.now() - startedAt) / 1000).toFixed(1)}s`);

  const part1 = computeContinuation('low', touchRecords, candles, adxSeries, atrSeries);
  const part2 = computeBreakRetest('low', levels, candles, adxSeries);
  const part3 = {
    continuation: computeContinuation('high', touchRecords, candles, adxSeries, atrSeries),
    breakRetest: computeBreakRetest('high', levels, candles, adxSeries),
  };
  const part4 = computePart4(touchRecords, candles, adxSeries, atrSeries);
  const part5 = {
    UP: computePart5(levels, 'low'),
    DOWN: computePart5(levels, 'high'),
  };
  const part6 = {
    ALL: computePart6(levels),
    UP: computePart6(levels, 'low'),
    DOWN: computePart6(levels, 'high'),
  };

  console.info(`\nPart1 (UP continuation, n=${part1.n}) h20 pureDirection=${part1.perHorizon.h20.pureDirection.overall.pct?.toFixed(2)}% profitableEnough=${part1.perHorizon.h20.profitableEnough.overall.pct?.toFixed(2)}%`);
  console.info(`Part2 (UP break+retest, totalBreaks=${part2.totalBreaks}, noRetestFound=${part2.noRetestFoundCount}) held=${part2.held.overall.pct?.toFixed(2)}%`);
  console.info(`Part4 (SIDEWAY bounce, n=${part4.n}) bounce=${part4.overall.pct?.toFixed(2)}%`);

  const output = {
    warning:
      'TICKET-04X-AA/AC: cau truc thi truong THUAN MO TA (swing + ADX regime), KHONG PnL/Sharpe. Nguong ADX (25/20, Wilder 1978) ' +
      'khoa TRUOC khi chay va khong doi sau khi thay so lieu.',
    symbol: SYMBOL,
    generatedAt: new Date().toISOString(),
    adxThresholds: { trend: ADX_TREND_THRESHOLD, transition: ADX_TRANSITION_THRESHOLD },
    riskDefinition: `R = 1 x ATR(${ATR_PERIOD})`,
    favorableR: FAVORABLE_R,
    adverseR: ADVERSE_R,
    horizonsM15Candles: HORIZONS,
    maxTouchScanCandles: MAX_TOUCH_SCAN_CANDLES,
    minGroupN: MIN_GROUP_N,
    totalCandles: candles.length,
    totalSwings: swings.length,
    totalTouches: touchRecords.length,
    part1_holdingRetraceContinuation_UP: part1,
    part2_breakAndRetest_UP: part2,
    part3_symmetric_DOWN: part3,
    part4_sidewayBoundaryBounce: part4,
    part5_consecutiveFailureStreak: part5,
    part6_touchSequenceBreakTable: part6,
  };

  const outputPath = resolve(auditsDirectory, `structureConfirmationDescriptive-${SYMBOL}.json`);
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  console.info(`\nOutput: ${outputPath}`);
}

await main();
