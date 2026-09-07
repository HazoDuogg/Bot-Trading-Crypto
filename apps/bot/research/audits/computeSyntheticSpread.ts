import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import unzipper from 'unzipper';

// TICKET-04X-S Step 0: locks the synthetic half-spread H used to price entry/TP limit orders in
// the full 3-year backtest, computed ONCE from real bookTicker data on the 3 stress weeks locked
// in TICKET-04X-Q — not touched again after PnL is seen.
//
// DEVIATION FROM THE TICKET TEXT (flagged to the user, proceeding as agreed): the ticket says to
// "read back" the already-fetched bookTicker files for these weeks, but TICKET-04X-Q's fetch
// script deliberately discards raw bid/ask ticks after feeding them into each signal's fill
// tracker (that's what fixed its OOM/RangeError crashes) — nothing but resolved fill outcomes
// survives to disk. This script re-streams the same 3 weeks' raw archives from data.binance.vision
// to get bid/ask again. An exact median over ~380M+ rows would require holding all of them in
// memory (the same class of crash TICKET-04X-Q hit), so this uses reservoir sampling: a fixed-size
// uniform random sample of the full stream, median taken over the sample. Reservoir sampling is a
// standard unbiased streaming quantile estimator, not an invented proxy metric — documented here
// and in the output file so nobody mistakes it for an exact median later.
const RESERVOIR_SIZE = 200_000;

interface WeekRef {
  periodLabel: string;
  selectionReason: string;
  weekStartTimestamp: number;
  weekEndTimestampExclusive: number;
}

function dateStringUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function* fetchDayCsvLines(dateStr: string): AsyncGenerator<string> {
  const url = `https://data.binance.vision/data/futures/um/daily/bookTicker/BTCUSDT/BTCUSDT-bookTicker-${dateStr}.zip`;
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

function parseBidAsk(line: string): { bid: number; ask: number } | null {
  const parts = line.split(',');
  if (parts.length !== 7) return null;
  const bid = Number(parts[1]);
  const ask = Number(parts[3]);
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0 || bid > ask) return null;
  return { bid, ask };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

async function main(): Promise<void> {
  const auditsDirectory = fileURLToPath(new URL('./', import.meta.url));
  const configDirectory = fileURLToPath(new URL('../../config/', import.meta.url));
  const manifest = JSON.parse(await readFile(resolve(auditsDirectory, 'eventDrivenStressWeeks.json'), 'utf8')) as {
    weeks: WeekRef[];
  };

  // Reservoir sampling (Algorithm R): each new observation replaces a uniformly-random existing
  // slot with probability RESERVOIR_SIZE/seenCount once the reservoir is full — every observation
  // across the whole stream ends up with equal probability of surviving into the final sample.
  const reservoir: number[] = [];
  let seenCount = 0;
  let totalRows = 0;
  let rejectedRows = 0;

  for (const week of manifest.weeks) {
    console.info(`\n########## Week ${week.periodLabel} / ${week.selectionReason} ##########`);
    for (let t = week.weekStartTimestamp; t < week.weekEndTimestampExclusive; t += 24 * 60 * 60 * 1000) {
      const dateStr = dateStringUtc(t);
      console.info(`  Streaming ${dateStr} (bid/ask only, no persistence)...`);
      const startedAt = Date.now();
      let dayRows = 0;
      for await (const line of fetchDayCsvLines(dateStr)) {
        const parsed = parseBidAsk(line);
        if (parsed === null) {
          rejectedRows += 1;
          continue;
        }
        dayRows += 1;
        totalRows += 1;
        const halfSpread = (parsed.ask - parsed.bid) / 2;
        seenCount += 1;
        if (reservoir.length < RESERVOIR_SIZE) {
          reservoir.push(halfSpread);
        } else {
          const j = Math.floor(Math.random() * seenCount);
          if (j < RESERVOIR_SIZE) reservoir[j] = halfSpread;
        }
      }
      console.info(`    rows=${dayRows} elapsed=${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
    }
  }

  const halfSpreadMedian = median(reservoir);
  console.info(`\nTotal rows scanned: ${totalRows} (rejected/malformed: ${rejectedRows})`);
  console.info(`Reservoir sample size: ${reservoir.length}`);
  console.info(`Median half-spread H = ${halfSpreadMedian}`);

  const computedAtIso = new Date().toISOString();
  const configContent = `// AUTO-GENERATED ONCE by research/audits/computeSyntheticSpread.ts — TICKET-04X-S Step 0.
// LOCKED: computed once from real bookTicker data, never re-tuned after seeing backtest PnL.
//
// Source: median((bestAsk - bestBid) / 2) over a ${RESERVOIR_SIZE}-observation reservoir sample of
// every BTCUSDT bookTicker event across the 3 TICKET-04X-Q stress weeks (${manifest.weeks
    .map((w) => `${w.selectionReason} ${dateStringUtc(w.weekStartTimestamp)}`)
    .join(', ')}).
// ${totalRows} raw rows scanned across the 3 weeks; reservoir sampling used instead of an exact
// median because holding all ${totalRows} half-spread values in memory would reintroduce the OOM
// TICKET-04X-Q's fetch script hit — see that script's design note.
// Computed at: ${computedAtIso}

export const SYNTHETIC_HALF_SPREAD_SOURCE = {
  method: 'median of a reservoir sample of (bestAsk - bestBid) / 2 over 3 TICKET-04X-Q stress weeks',
  reservoirSize: ${RESERVOIR_SIZE},
  totalRowsScanned: ${totalRows},
  rejectedRows: ${rejectedRows},
  computedAtIso: '${computedAtIso}',
} as const;

// Half-spread H (USD) used to synthesize a post-only entry/TP limit price in TICKET-04X-S: LONG
// entry rests at C - H, SHORT entry rests at C + H (see runMeanReversionFullBacktest.ts).
export const SYNTHETIC_HALF_SPREAD_USD = ${halfSpreadMedian};
`;

  await mkdir(configDirectory, { recursive: true });
  const configPath = resolve(configDirectory, 'syntheticSpread.ts');
  await writeFile(configPath, configContent, 'utf8');
  console.info(`\nWrote locked config: ${configPath}`);
}

await main();
