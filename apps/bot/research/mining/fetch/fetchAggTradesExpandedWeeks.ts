import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import unzipper from 'unzipper';

// TICKET-04X-Z Step 1+2: extends TICKET-04X-X's aggTrades order-flow features from 3 weeks to the
// 12 weeks locked in aggTradesExpandedWeeks.json. Same streaming architecture as
// fetchAggTradesOrderFlowFeatures.ts (incremental per-signal accumulation, no raw-event buffering).
// Weeks already fetched in TICKET-04X-Q/X (marked alreadyFetched in the manifest) are NOT
// re-downloaded -- their signals are pulled straight from the existing
// aggTradesOrderFlowFeatures.json instead. Step 0's honest selection found only 1/3 old weeks
// naturally overlapped the new 12 (not the 3 the ticket assumed), so 11 weeks needed a fresh fetch
// here, not 9 -- reported plainly, not forced.
const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_5MIN_MS = 5 * 60 * 1000;
const WINDOW_1MIN_MS = 60 * 1000;

interface SignalRef {
  m5Index: number;
  m5CloseTime: number;
  direction: 'LONG' | 'SHORT';
  outcome: string;
}

interface SignalWindow extends SignalRef {
  windowStart: number;
  buyVol5: number;
  sellVol5: number;
  buyVol1: number;
  sellVol1: number;
}

interface FeatureRow {
  m5Index: number;
  m5CloseTime: number;
  direction: 'LONG' | 'SHORT';
  outcome: string;
  weekLabel: string;
  buyVol5: number;
  sellVol5: number;
  buyVol1: number;
  sellVol1: number;
  imbalance5min: number | null;
  imbalance1min: number | null;
  imbalanceShift: number | null;
}

interface DayQualityFlags {
  date: string;
  rowCount: number;
  outOfOrder: number;
  nonPositivePriceOrQty: number;
}

function dateStringUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function* fetchDayCsvLines(dateStr: string): AsyncGenerator<string> {
  const url = `https://data.binance.vision/data/futures/um/daily/aggTrades/BTCUSDT/BTCUSDT-aggTrades-${dateStr}.zip`;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      if (res.body === null) throw new Error(`Empty response body for ${url}`);
      const nodeStream = Readable.fromWeb(res.body as never);
      const zipEntryStream = nodeStream.pipe(unzipper.ParseOne());
      const rl = createInterface({ input: zipEntryStream, crlfDelay: Infinity });
      let first = true;
      for await (const line of rl) {
        if (first) {
          first = false;
          continue;
        }
        if (line.trim().length === 0) continue;
        yield line;
      }
      return;
    } catch (err) {
      lastErr = err;
      console.warn(`  attempt ${attempt}/3 failed for ${dateStr}: ${(err as Error).message}`);
      if (attempt < 3) await sleep(2000 * attempt);
    }
  }
  throw new Error(`Failed to fetch ${dateStr} after 3 attempts: ${(lastErr as Error)?.message}`);
}

interface ParsedRow {
  quantity: number;
  transactTime: number;
  isBuyerMaker: boolean;
}

function parseRow(line: string): ParsedRow | null {
  const parts = line.split(',');
  if (parts.length !== 7) return null;
  const quantity = Number(parts[2]);
  const transactTime = Number(parts[5]);
  const isBuyerMakerRaw = parts[6];
  if (!Number.isFinite(quantity) || !Number.isFinite(transactTime)) return null;
  if (isBuyerMakerRaw !== 'true' && isBuyerMakerRaw !== 'false') return null;
  return { quantity, transactTime, isBuyerMaker: isBuyerMakerRaw === 'true' };
}

async function processDay(dateStr: string, activeWindows: SignalWindow[]): Promise<DayQualityFlags> {
  const flags: DayQualityFlags = { date: dateStr, rowCount: 0, outOfOrder: 0, nonPositivePriceOrQty: 0 };
  let previousTransactTime = -Infinity;

  for await (const line of fetchDayCsvLines(dateStr)) {
    const row = parseRow(line);
    if (row === null) continue;
    flags.rowCount += 1;
    if (row.transactTime < previousTransactTime) flags.outOfOrder += 1;
    previousTransactTime = row.transactTime;
    if (row.quantity <= 0) {
      flags.nonPositivePriceOrQty += 1;
      continue;
    }

    for (const window of activeWindows) {
      if (row.transactTime < window.windowStart || row.transactTime >= window.m5CloseTime) continue;
      if (row.isBuyerMaker) window.sellVol5 += row.quantity;
      else window.buyVol5 += row.quantity;
      if (row.transactTime >= window.m5CloseTime - WINDOW_1MIN_MS) {
        if (row.isBuyerMaker) window.sellVol1 += row.quantity;
        else window.buyVol1 += row.quantity;
      }
    }
  }

  if (flags.outOfOrder > 0) {
    console.warn(`  WARNING: ${dateStr} has ${flags.outOfOrder} out-of-order row(s) -- flagged, not silently corrected.`);
  }
  return flags;
}

async function main(): Promise<void> {
  const reportsDirectory = fileURLToPath(new URL('../../../reports/', import.meta.url));
  const auditsDirectory = fileURLToPath(new URL('../../audits/', import.meta.url));

  const manifest = JSON.parse(await readFile(resolve(auditsDirectory, 'aggTradesExpandedWeeks.json'), 'utf8')) as {
    weeks: Array<{
      periodLabel: string;
      selectionReason: string;
      weekStartTimestamp: number;
      weekEndTimestampExclusive: number;
      alreadyFetched: boolean;
    }>;
  };
  const backtest = JSON.parse(await readFile(resolve(reportsDirectory, 'nukida-04x-s-mean-reversion-backtest.json'), 'utf8')) as {
    trades: Array<{ m5Index: number; m5CloseTime: number; direction: 'LONG' | 'SHORT'; outcome: string }>;
  };
  const oldFeatures = JSON.parse(await readFile(resolve(auditsDirectory, 'aggTradesOrderFlowFeatures.json'), 'utf8')) as {
    features: FeatureRow[];
  };

  const allDayFlags: DayQualityFlags[] = [];
  const allFeatures: FeatureRow[] = [];

  for (const week of manifest.weeks) {
    const weekLabel = `${week.periodLabel}-${week.selectionReason}`;

    if (week.alreadyFetched) {
      const reused = oldFeatures.features.filter(
        (f) => f.m5CloseTime >= week.weekStartTimestamp && f.m5CloseTime < week.weekEndTimestampExclusive,
      );
      console.info(`\n########## ${weekLabel}: REUSING ${reused.length} signals from TICKET-04X-X data ##########`);
      allFeatures.push(...reused.map((f) => ({ ...f, weekLabel })));
      continue;
    }

    const signalsInWeek: SignalRef[] = backtest.trades
      .filter((t) => t.m5CloseTime >= week.weekStartTimestamp && t.m5CloseTime < week.weekEndTimestampExclusive)
      .map((t) => ({ m5Index: t.m5Index, m5CloseTime: t.m5CloseTime, direction: t.direction, outcome: t.outcome }));
    console.info(`\n########## ${weekLabel}: ${signalsInWeek.length} signals (fresh fetch) ##########`);

    const windows: SignalWindow[] = signalsInWeek.map((s) => ({
      ...s,
      windowStart: s.m5CloseTime - WINDOW_5MIN_MS,
      buyVol5: 0,
      sellVol5: 0,
      buyVol1: 0,
      sellVol1: 0,
    }));

    const daysNeeded: string[] = [];
    for (let t = week.weekStartTimestamp - DAY_MS; t < week.weekEndTimestampExclusive; t += DAY_MS) {
      daysNeeded.push(dateStringUtc(t));
    }

    for (const dateStr of daysNeeded) {
      console.info(`  Fetching ${dateStr}...`);
      const startedAt = Date.now();
      const flags = await processDay(dateStr, windows);
      allDayFlags.push(flags);
      console.info(`    rows=${flags.rowCount} outOfOrder=${flags.outOfOrder} nonPositive=${flags.nonPositivePriceOrQty} elapsed=${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
    }

    for (const w of windows) {
      const total5 = w.buyVol5 + w.sellVol5;
      const total1 = w.buyVol1 + w.sellVol1;
      const imbalance5min = total5 === 0 ? null : (w.buyVol5 - w.sellVol5) / total5;
      const imbalance1min = total1 === 0 ? null : (w.buyVol1 - w.sellVol1) / total1;
      allFeatures.push({
        m5Index: w.m5Index,
        m5CloseTime: w.m5CloseTime,
        direction: w.direction,
        outcome: w.outcome,
        weekLabel,
        buyVol5: w.buyVol5,
        sellVol5: w.sellVol5,
        buyVol1: w.buyVol1,
        sellVol1: w.sellVol1,
        imbalance5min,
        imbalance1min,
        imbalanceShift: imbalance5min === null || imbalance1min === null ? null : imbalance1min - imbalance5min,
      });
    }

    // Persist progressively after each week so a later failure doesn't lose earlier fetches.
    await writeFile(
      resolve(auditsDirectory, 'aggTradesExpandedFeatures.json'),
      JSON.stringify(
        {
          warning: 'TICKET-04X-Z: order-flow-imbalance features across 12 weeks (1 reused from TICKET-04X-X, 11 freshly fetched). In progress.',
          generatedAt: new Date().toISOString(),
          dayQualityFlags: allDayFlags,
          features: allFeatures,
        },
        null,
        2,
      ),
      'utf8',
    );
  }

  const nullCount = allFeatures.filter((f) => f.imbalance5min === null || f.imbalance1min === null).length;
  console.info(`\nTotal signals: ${allFeatures.length} (null imbalance: ${nullCount})`);

  const output = {
    warning:
      'TICKET-04X-Z: order-flow-imbalance features across 12 weeks (1 reused from TICKET-04X-X, 11 freshly fetched). Same formula as ' +
      'TICKET-04X-X, unchanged.',
    generatedAt: new Date().toISOString(),
    dayQualityFlags: allDayFlags,
    features: allFeatures,
  };

  const outputPath = resolve(auditsDirectory, 'aggTradesExpandedFeatures.json');
  await writeFile(outputPath, JSON.stringify(output, null, 2), 'utf8');
  console.info(`\nOutput: ${outputPath}`);
}

await main();
