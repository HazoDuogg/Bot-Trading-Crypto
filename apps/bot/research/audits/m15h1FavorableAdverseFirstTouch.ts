import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Candle } from '../../backtest/engine/noTradeZone/types.js';
import { computeAtr } from '../../backtest/engine/noTradeZone/atr.js';
import { computeMeanReversionSignals } from '../../core/entry/meanReversionSignal.js';
import { MEAN_REVERSION_RISK_PER_UNIT_ATR_MULTIPLE } from '../../core/risk/meanReversionTradePlan.js';

// TICKET-04X-U: does TICKET-04X-T's ~54% end-of-horizon directional edge actually survive to
// become a tradeable opportunity, or does price go adverse first (TICKET-04X-H's finding for the
// old M1/M15 combo)? Same structure as favorableAdverseFirstTouch.ts (TICKET-04X-H), reused
// unchanged in spirit: independent first-touch scans of a favorable and an adverse R-threshold,
// classified into the same 7 labels. Still NO TP/SL/limit-fill/PnL/$ of any kind -- pure touch-order.
//
// Reuses computeMeanReversionSignals exactly as TICKET-04X-T already called it (H1=regime,
// M15=signal) -- not recomputed with new logic, same signals array shape.
const H1_MS = 60 * 60 * 1000;
const M15_MS = 15 * 60 * 1000;
const ATR_PERIOD = 14;
const HORIZONS_M15_CANDLES = [4, 8, 16, 40]; // same 4 horizons as TICKET-04X-T, for direct comparison
const FAVORABLE_THRESHOLDS_R = [1.0, 8 / 3]; // +1.0R and +2.67R (8:3 ratio from the M5 TP design)
const ADVERSE_THRESHOLD_R = 1.0; // the real SL level for this timeframe if built (not an arbitrary probe)

type Label = 'FAVORABLE_FIRST' | 'ADVERSE_FIRST' | 'SAME_M15_AMBIGUOUS' | 'FAVORABLE_ONLY' | 'ADVERSE_ONLY' | 'NEITHER' | 'INSUFFICIENT_DATA';
const ALL_LABELS: Label[] = ['FAVORABLE_FIRST', 'ADVERSE_FIRST', 'SAME_M15_AMBIGUOUS', 'FAVORABLE_ONLY', 'ADVERSE_ONLY', 'NEITHER', 'INSUFFICIENT_DATA'];

async function loadCsv(csvPath: string): Promise<Candle[]> {
  const rows = (await readFile(csvPath, 'utf8')).trim().split(/\r?\n/u).slice(1);
  return rows.map((row) => {
    const [openTime, open, high, low, close, volume] = row.split(',').map(Number);
    return { openTime, open, high, low, close, volume } satisfies Candle;
  });
}

// Independent first-touch scan over the M15 window [i+1, i+horizon] for one favorable threshold
// (favorableR) and the fixed adverse threshold, classified into the same 7 labels as TICKET-04X-H.
function classify(
  m15Candles: readonly Candle[],
  signalIndex: number,
  horizon: number,
  entryPrice: number,
  riskPerUnit: number,
  direction: 'LONG' | 'SHORT',
  favorableR: number,
): Label {
  const startIdx = signalIndex + 1;
  const endIdxExclusive = signalIndex + 1 + horizon;
  if (endIdxExclusive > m15Candles.length) return 'INSUFFICIENT_DATA';

  let favIdx: number | null = null;
  let advIdx: number | null = null;
  for (let k = startIdx; k < endIdxExclusive; k += 1) {
    const candle = m15Candles[k];
    const favorable = direction === 'LONG' ? (candle.high - entryPrice) / riskPerUnit : (entryPrice - candle.low) / riskPerUnit;
    const adverse = direction === 'LONG' ? (entryPrice - candle.low) / riskPerUnit : (candle.high - entryPrice) / riskPerUnit;
    if (favIdx === null && favorable >= favorableR) favIdx = k;
    if (advIdx === null && adverse >= ADVERSE_THRESHOLD_R) advIdx = k;
  }

  if (favIdx !== null && advIdx !== null) {
    if (favIdx === advIdx) return 'SAME_M15_AMBIGUOUS';
    return favIdx < advIdx ? 'FAVORABLE_FIRST' : 'ADVERSE_FIRST';
  }
  if (favIdx !== null) return 'FAVORABLE_ONLY';
  if (advIdx !== null) return 'ADVERSE_ONLY';
  return 'NEITHER';
}

async function main(): Promise<void> {
  const dataDirectory = fileURLToPath(new URL('../../data/', import.meta.url));
  const auditsDirectory = fileURLToPath(new URL('./', import.meta.url));

  console.info('Loading CSVs...');
  const h1Candles = await loadCsv(resolve(dataDirectory, 'BTCUSDT_1h_3y.csv'));
  const m15Candles = await loadCsv(resolve(dataDirectory, 'BTCUSDT_15m_3y.csv'));
  console.info(`  H1=${h1Candles.length} M15=${m15Candles.length}`);

  const signals = computeMeanReversionSignals(h1Candles, m15Candles, H1_MS, M15_MS);
  const atrSeries = computeAtr(m15Candles, ATR_PERIOD); // atrSeries[k] -> m15Candles[k + ATR_PERIOD]

  // counts[thresholdKey][horizon][direction][label] = count
  const counts: Record<string, Record<number, Record<string, Record<Label, number>>>> = {};
  const thresholdKeys = FAVORABLE_THRESHOLDS_R.map((r) => `${r.toFixed(2)}R`);
  for (const tk of thresholdKeys) {
    counts[tk] = {};
    for (const h of HORIZONS_M15_CANDLES) {
      counts[tk][h] = {
        LONG: Object.fromEntries(ALL_LABELS.map((l) => [l, 0])) as Record<Label, number>,
        SHORT: Object.fromEntries(ALL_LABELS.map((l) => [l, 0])) as Record<Label, number>,
        ALL: Object.fromEntries(ALL_LABELS.map((l) => [l, 0])) as Record<Label, number>,
      };
    }
  }

  let totalSignals = 0;
  for (let i = 0; i < m15Candles.length; i += 1) {
    const s = signals[i];
    if (s.signal === 'NONE') continue;
    const atr14 = i >= ATR_PERIOD ? atrSeries[i - ATR_PERIOD] : undefined;
    if (atr14 === undefined) continue; // should not happen: zScore requires i>=20>14, same invariant as TICKET-04X-S
    totalSignals += 1;

    const entryPrice = m15Candles[i].close;
    const riskPerUnit = MEAN_REVERSION_RISK_PER_UNIT_ATR_MULTIPLE * atr14;
    const direction = s.signal;

    for (let ti = 0; ti < FAVORABLE_THRESHOLDS_R.length; ti += 1) {
      const tk = thresholdKeys[ti];
      for (const h of HORIZONS_M15_CANDLES) {
        const label = classify(m15Candles, i, h, entryPrice, riskPerUnit, direction, FAVORABLE_THRESHOLDS_R[ti]);
        counts[tk][h][direction][label] += 1;
        counts[tk][h].ALL[label] += 1;
      }
    }
  }

  console.info(`\nTotal signals: ${totalSignals}`);
  console.info('\n########## FIRST-TOUCH ORDER: favorable-R vs adverse -1.0R ##########');
  const consoleLines: string[] = [];
  for (const tk of thresholdKeys) {
    console.info(`\n--- Favorable threshold: +${tk} (adverse fixed at -${ADVERSE_THRESHOLD_R.toFixed(2)}R) ---`);
    for (const h of HORIZONS_M15_CANDLES) {
      for (const direction of ['LONG', 'SHORT', 'ALL'] as const) {
        const total = ALL_LABELS.reduce((sum, l) => sum + counts[tk][h][direction][l], 0);
        for (const label of ALL_LABELS) {
          const count = counts[tk][h][direction][label];
          const pct = total === 0 ? 0 : (100 * count) / total;
          const line = `${tk} | horizon=${h} | ${direction} | ${label}: ${count} (${pct.toFixed(2)}%)`;
          consoleLines.push(line);
        }
        const advFirst = counts[tk][h][direction].ADVERSE_FIRST;
        const sameM15 = counts[tk][h][direction].SAME_M15_AMBIGUOUS;
        const conservativeTotal = advFirst + sameM15;
        const conservativePct = total === 0 ? 0 : (100 * conservativeTotal) / total;
        consoleLines.push(`${tk} | horizon=${h} | ${direction} | adverse-first-conservative: ${conservativeTotal} (${conservativePct.toFixed(2)}%)`);
      }
    }
  }
  for (const line of consoleLines) console.info(line);

  const output = {
    warning:
      'TICKET-04X-U: thu tu thoi gian cham nguong R thuan tuy -- KHONG TP/SL/limit-fill/PnL/$ nao. ' +
      'FAVORABLE_FIRST chi la dieu kien CAN cho gia thuyet "co the giao dich duoc", KHONG phai bang chung co loi nhuan sau phi/spread.',
    generatedAt: new Date().toISOString(),
    riskDefinition: `R = riskPerUnit = ${MEAN_REVERSION_RISK_PER_UNIT_ATR_MULTIPLE} x ATR14(M15)`,
    favorableThresholdsR: FAVORABLE_THRESHOLDS_R,
    adverseThresholdR: ADVERSE_THRESHOLD_R,
    horizonsM15Candles: HORIZONS_M15_CANDLES,
    totalSignals,
    tables: Object.fromEntries(
      thresholdKeys.map((tk) => [
        tk,
        HORIZONS_M15_CANDLES.map((h) => ({
          horizon: h,
          LONG: counts[tk][h].LONG,
          SHORT: counts[tk][h].SHORT,
          ALL: counts[tk][h].ALL,
        })),
      ]),
    ),
  };

  const outputPath = resolve(auditsDirectory, 'm15h1FavorableAdverseFirstTouch.json');
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  console.info(`\nOutput: ${outputPath}`);
}

await main();
