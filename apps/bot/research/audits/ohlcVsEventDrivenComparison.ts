import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Candle } from '../../backtest/engine/noTradeZone/types.js';
import { simulateLimitFill } from '../../backtest/engine/limitFillSimulation.js';
import type { EntryFillOutcome } from '../../backtest/engine/eventDrivenEntryFill.js';

// TICKET-04X-Q Step 3: OHLC vs event-driven entry-fill comparison on the 9 locked stress weeks.
// Same signals, same buffer (N=1 tick), same TTL (5min), same per-week tickSize on both sides.
// Reuses the event-driven side's own entryQuote-derived limitPrice for the OHLC side too, so both
// methods are judging the exact same resting order — the only variable is what price data each
// method can see (top-of-book events vs M1 OHLC).
//
// Step 1 (fetchBookTickerStressWeeks.ts) already runs the event-driven fill tracker incrementally
// while streaming raw ticks (to avoid buffering them — see that file's design note), so this step
// only reads its precomputed per-signal outcome/limitPrice/minutesToFill; it does not re-run
// simulateEventDrivenEntryFill or see any raw events.
const TTL_MS = 5 * 60 * 1000;
const N = 1; // locked in TICKET-04X-M

interface BookTickerWeekFile {
  periodLabel: string;
  selectionReason: string;
  tickSize: number;
  signals: Array<{
    index: number;
    direction: 'LONG' | 'SHORT';
    decisionAt: number;
    outcome: EntryFillOutcome;
    limitPrice: number | null;
    filledAtEventTime: number | null;
    minutesToFill: number | null;
  }>;
}

async function loadCsv(csvPath: string): Promise<Candle[]> {
  const rows = (await readFile(csvPath, 'utf8')).trim().split(/\r?\n/u).slice(1);
  return rows.map((row) => {
    const [openTime, open, high, low, close, volume] = row.split(',').map(Number);
    return { openTime, open, high, low, close, volume } satisfies Candle;
  });
}

function firstM1After(candles: readonly Candle[], timestamp: number): number {
  let left = 0;
  let right = candles.length;
  while (left < right) {
    const middle = (left + right) >>> 1;
    if (candles[middle].openTime <= timestamp) left = middle + 1;
    else right = middle;
  }
  return left;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function p90(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil(0.9 * sorted.length) - 1);
  return sorted[idx];
}

type Quadrant = 'OHLC_OPTIMISTIC' | 'OHLC_MISSED_OPPORTUNITY' | 'BOTH_FILL' | 'CONSENSUS_NO_FILL';

interface Row {
  direction: 'LONG' | 'SHORT';
  quadrant: Quadrant;
  ohlcMinutesToFill: number | null;
  eventMinutesToFill: number | null;
}

async function main(): Promise<void> {
  const dataDirectory = fileURLToPath(new URL('../../data/', import.meta.url));
  const reportsDirectory = fileURLToPath(new URL('../../reports/', import.meta.url));
  const weekFileNames = (await readdir(dataDirectory)).filter((f) => f.startsWith('bookTickerStressWeek-') && f.endsWith('.json'));
  if (weekFileNames.length === 0) throw new Error('No bookTickerStressWeek-*.json files found — run fetchBookTickerStressWeeks.ts first');
  console.info(`Found ${weekFileNames.length} week file(s): ${weekFileNames.join(', ')}`);
  const weeks: BookTickerWeekFile[] = await Promise.all(
    weekFileNames.map(async (f) => JSON.parse(await readFile(resolve(dataDirectory, f), 'utf8')) as BookTickerWeekFile),
  );
  const m1Candles = await loadCsv(resolve(dataDirectory, 'BTCUSDT_rt094_1m.csv'));

  const rows: Row[] = [];
  let dataGapAbortCount = 0;
  let totalSignals = 0;

  for (const week of weeks) {
    for (const signal of week.signals) {
      totalSignals += 1;

      if (signal.outcome === 'DATA_GAP_ABORT') {
        dataGapAbortCount += 1;
        continue; // excluded from the fill-rate / quadrant comparison, per the ticket
      }
      if (signal.limitPrice === null) continue; // should not happen once gap-aborted is excluded

      const startIdx = firstM1After(m1Candles, signal.decisionAt);
      const endIdx = firstM1After(m1Candles, signal.decisionAt + TTL_MS - 1);
      const ohlcWindow = m1Candles.slice(startIdx, endIdx);
      const ohlcResult = simulateLimitFill({
        limitPrice: signal.limitPrice,
        direction: signal.direction === 'LONG' ? 'BULL' : 'BEAR',
        m1Candles: ohlcWindow,
        tickSize: week.tickSize,
        n: N,
      });

      const ohlcFilled = ohlcResult.filled;
      const eventFilled = signal.outcome === 'FILLED';
      let quadrant: Quadrant;
      if (ohlcFilled && !eventFilled) quadrant = 'OHLC_OPTIMISTIC';
      else if (!ohlcFilled && eventFilled) quadrant = 'OHLC_MISSED_OPPORTUNITY';
      else if (ohlcFilled && eventFilled) quadrant = 'BOTH_FILL';
      else quadrant = 'CONSENSUS_NO_FILL';

      rows.push({
        direction: signal.direction,
        quadrant,
        ohlcMinutesToFill: ohlcFilled ? (ohlcResult.filledAtTimestamp! - signal.decisionAt) / 60_000 : null,
        eventMinutesToFill: eventFilled ? signal.minutesToFill : null,
      });
    }
  }

  console.info(`Tong tin hieu (${weeks.length} tuan): ${totalSignals}`);
  console.info(`DATA_GAP_ABORT: ${dataGapAbortCount}/${totalSignals} (${((100 * dataGapAbortCount) / totalSignals).toFixed(2)}%) — loai khoi so sanh ben duoi`);
  console.info(`Con lai de so sanh: ${rows.length}`);

  for (const directionLabel of ['LONG', 'SHORT', 'ALL'] as const) {
    const subset = directionLabel === 'ALL' ? rows : rows.filter((r) => r.direction === directionLabel);
    console.info(`\n########## ${directionLabel} (n=${subset.length}) ##########`);
    for (const q of ['OHLC_OPTIMISTIC', 'OHLC_MISSED_OPPORTUNITY', 'BOTH_FILL', 'CONSENSUS_NO_FILL'] as const) {
      const count = subset.filter((r) => r.quadrant === q).length;
      console.info(`  ${q}: ${count} (${subset.length === 0 ? 'N/A' : ((100 * count) / subset.length).toFixed(2) + '%'})`);
    }
    const bothFillRows = subset.filter((r) => r.quadrant === 'BOTH_FILL');
    const ohlcTimes = bothFillRows.map((r) => r.ohlcMinutesToFill!);
    const eventTimes = bothFillRows.map((r) => r.eventMinutesToFill!);
    console.info(`  BOTH_FILL time-to-fill (minutes) — OHLC: median=${median(ohlcTimes)?.toFixed(3) ?? 'N/A'} p90=${p90(ohlcTimes)?.toFixed(3) ?? 'N/A'}`);
    console.info(`  BOTH_FILL time-to-fill (minutes) — Event: median=${median(eventTimes)?.toFixed(3) ?? 'N/A'} p90=${p90(eventTimes)?.toFixed(3) ?? 'N/A'}`);
  }

  await mkdir(reportsDirectory, { recursive: true });
  const outputPath = resolve(reportsDirectory, 'ohlcVsEventDrivenComparison.json');
  await writeFile(
    outputPath,
    JSON.stringify(
      {
        warning:
          'bookTicker la top-of-book, khong co vi tri hang doi/khoi luong that da khop truoc lenh — day van la proxy bao thu, chua dung aggTrades.',
        scopeLimitation:
          'Ket qua nay CHI phan anh hanh vi thi truong trong khung 2023-09-18 .. 2024-03-30 (3 tuan stress-test trong khung nay) — vi ' +
          'Binance ngung cong khai bookTicker cong khai cho BTCUSDT sau 2024-03-30 (data.binance.vision tra 404 tu 2024-03-31 tro di, ' +
          'da xac nhan qua thang 2026; khop voi GitHub issue #372 cua binance/binance-public-data — khong phai loi thu thap du lieu ' +
          'cua repo nay). Ap dung ket luan nay cho giai doan cuoi 2024 / 2025 / 2026 la MOT GIA DINH CHUA KIEM CHUNG va PHAI duoc neu ro ' +
          'moi khi trich dan ket qua nay sau nay.',
        totalSignals,
        dataGapAbortCount,
        rows,
      },
      null,
      2,
    ),
    'utf8',
  );
  console.info(`\nOutput: ${outputPath}`);
}

await main();
