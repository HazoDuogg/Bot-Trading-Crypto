import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createBinanceClient } from "../src/exchange/binanceClient.js";
import type { Candle } from "../src/core/types.js";

function parseArgs() {
  const args = process.argv.slice(2);
  let symbol = "BTCUSDT";
  let intervals = ["15m", "1h", "4h"];
  let start = "2023-01-01T00:00:00Z";
  let end = "2026-01-01T00:00:00Z";
  let suffix = "";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--symbol") symbol = args[++i];
    if (args[i] === "--intervals") intervals = args[++i].split(",");
    if (args[i] === "--start") start = args[++i];
    if (args[i] === "--end") end = args[++i];
    if (args[i] === "--suffix") suffix = args[++i];
  }
  return { symbol, intervals, start, end, suffix };
}

const { symbol: SYMBOL, intervals: INTERVALS, start, end, suffix: SUFFIX } = parseArgs();
const START_TIME = Date.parse(start);
const END_TIME = Date.parse(end);
const PAGE_LIMIT = 1500;
const REQUEST_DELAY_MS = 350;
const OUTPUT_DIR = "data";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchRange(
  client: ReturnType<typeof createBinanceClient>,
  interval: string,
): Promise<Candle[]> {
  const candles: Candle[] = [];
  let cursor = START_TIME;

  while (cursor < END_TIME) {
    const batch = await client.getCandles(SYMBOL, interval, {
      limit: PAGE_LIMIT,
      startTime: cursor,
      endTime: END_TIME,
    });
    if (batch.length === 0) break;

    candles.push(...batch);
    const last = batch[batch.length - 1];
    if (last.closeTime <= cursor) break;
    cursor = last.closeTime + 1;

    process.stdout.write(
      `\r${interval}: ${candles.length} nến, tới ${new Date(cursor).toISOString()}`,
    );
    await sleep(REQUEST_DELAY_MS);
  }
  process.stdout.write("\n");
  return candles;
}

async function main() {
  const client = createBinanceClient();
  await mkdir(OUTPUT_DIR, { recursive: true });

  console.log(
    `Fetching ${SYMBOL} [${INTERVALS.join(", ")}] từ ${new Date(START_TIME).toISOString()} đến ${new Date(END_TIME).toISOString()}`,
  );

  for (const interval of INTERVALS) {
    console.log(`\n${interval}:`);
    const candles = await fetchRange(client, interval);
    const suffixPart = SUFFIX ? `-${SUFFIX}` : "";
    const outPath = path.join(OUTPUT_DIR, `ohlcv-${SYMBOL}-${interval}${suffixPart}.json`);
    await writeFile(outPath, JSON.stringify(candles));
    console.log(`Đã lưu ${candles.length} nến vào ${outPath}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
