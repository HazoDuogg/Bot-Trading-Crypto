import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import AdmZip from "adm-zip";
import { createBinanceClient, type ExchangeClient } from "../src/exchange/binanceClient.js";

// TICKET-06X-ORDERFLOW-CVD: BTCUSDT, 1 tháng gần nhất, Binance Futures mainnet.
// Trade volume thật (~1.3M trade/ngày) quá lớn cho REST aggTrades pagination (ước tính ~10 giờ).
// Dùng bulk daily dump từ data.binance.vision thay thế — cùng dữ liệu, nhanh hơn nhiều.
const SYMBOL = "BTCUSDT";
const MINUTE_MS = 60 * 1000;
const FIFTEEN_MIN_MS = 15 * MINUTE_MS;
const HOUR_MS = 60 * MINUTE_MS;
const OUTPUT_DIR = "data";
const DOWNLOAD_DELAY_MS = 200;

function parseArgs() {
  const args = process.argv.slice(2);
  let days = 30;
  let suffix = "last30d";
  let start: string | undefined;
  let end: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--days") days = Number(args[++i]);
    if (args[i] === "--suffix") suffix = args[++i];
    if (args[i] === "--start") start = args[++i];
    if (args[i] === "--end") end = args[++i];
  }
  return { days, suffix, start, end };
}

const { days: DAYS, suffix: SUFFIX, start: START_ARG, end: END_ARG } = parseArgs();
const END_TIME = END_ARG ? Date.parse(END_ARG) : Date.now();
const START_TIME = START_ARG ? Date.parse(START_ARG) : END_TIME - DAYS * 24 * 60 * 60 * 1000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toDateString(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function bucketTimestamp(ts: number, bucketMs: number): number {
  return Math.floor(ts / bucketMs) * bucketMs;
}

async function fetchCandles(client: ExchangeClient, interval: string) {
  const candles = [];
  let cursor = START_TIME;
  while (cursor < END_TIME) {
    const batch = await client.getCandles(SYMBOL, interval, {
      limit: 1500,
      startTime: cursor,
      endTime: END_TIME,
    });
    if (batch.length === 0) break;
    candles.push(...batch);
    const last = batch[batch.length - 1];
    if (last.closeTime <= cursor) break;
    cursor = last.closeTime + 1;
    await sleep(300);
  }
  return candles;
}

async function downloadDailyAggTrades(dateStr: string): Promise<Buffer | null> {
  const url = `https://data.binance.vision/data/futures/um/daily/aggTrades/${SYMBOL}/${SYMBOL}-aggTrades-${dateStr}.zip`;
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`Không tải được ${url}: ${res.status} ${res.statusText}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

// CSV columns: agg_trade_id,price,quantity,first_trade_id,last_trade_id,transact_time,is_buyer_maker
function accumulateDayIntoMinuteDelta(csvText: string, minuteDelta: Map<number, number>) {
  const lines = csvText.split("\n");
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;

    const cols = line.split(",");
    const quantity = Number(cols[2]);
    const timestamp = Number(cols[5]);
    const isBuyerMaker = cols[6] === "true";

    if (!Number.isFinite(quantity) || !Number.isFinite(timestamp)) continue;

    const minute = bucketTimestamp(timestamp, MINUTE_MS);
    const signedQty = isBuyerMaker ? -quantity : quantity;
    minuteDelta.set(minute, (minuteDelta.get(minute) ?? 0) + signedQty);
  }
}

async function saveCvd(minuteDelta: Map<number, number>) {
  const minutes = [...minuteDelta.keys()].sort((a, b) => a - b);

  let cvd = 0;
  const perMinute = minutes.map((minute) => {
    const delta = minuteDelta.get(minute)!;
    cvd += delta;
    return { minute, delta, cvd };
  });
  await writeFile(path.join(OUTPUT_DIR, `cvd-${SYMBOL}-1m-${SUFFIX}.json`), JSON.stringify(perMinute));

  const fifteenMinDelta = new Map<number, number>();
  for (const { minute, delta } of perMinute) {
    const bucket = bucketTimestamp(minute, FIFTEEN_MIN_MS);
    fifteenMinDelta.set(bucket, (fifteenMinDelta.get(bucket) ?? 0) + delta);
  }
  const buckets = [...fifteenMinDelta.keys()].sort((a, b) => a - b);
  let cvd15 = 0;
  const per15Min = buckets.map((bucket) => {
    const delta = fifteenMinDelta.get(bucket)!;
    cvd15 += delta;
    return { openTime: bucket, delta, cvd: cvd15 };
  });
  await writeFile(path.join(OUTPUT_DIR, `cvd-${SYMBOL}-15m-${SUFFIX}.json`), JSON.stringify(per15Min));

  const hourDelta = new Map<number, number>();
  for (const { minute, delta } of perMinute) {
    const bucket = bucketTimestamp(minute, HOUR_MS);
    hourDelta.set(bucket, (hourDelta.get(bucket) ?? 0) + delta);
  }
  const hourBuckets = [...hourDelta.keys()].sort((a, b) => a - b);
  let cvd1h = 0;
  const per1Hour = hourBuckets.map((bucket) => {
    const delta = hourDelta.get(bucket)!;
    cvd1h += delta;
    return { openTime: bucket, delta, cvd: cvd1h };
  });
  await writeFile(path.join(OUTPUT_DIR, `cvd-${SYMBOL}-1h-${SUFFIX}.json`), JSON.stringify(per1Hour));
}

async function main() {
  const client = createBinanceClient();
  await mkdir(OUTPUT_DIR, { recursive: true });

  console.log(
    `Fetching ${SYMBOL} 15m candles từ ${new Date(START_TIME).toISOString()} đến ${new Date(END_TIME).toISOString()}...`,
  );
  const candles15m = await fetchCandles(client, "15m");
  const candlesPath = path.join(OUTPUT_DIR, `ohlcv-${SYMBOL}-15m-${SUFFIX}.json`);
  await writeFile(candlesPath, JSON.stringify(candles15m));
  console.log(`  Đã lưu ${candles15m.length} nến vào ${candlesPath}`);

  const dayCount = Math.ceil((END_TIME - START_TIME) / (24 * 60 * 60 * 1000));
  console.log(`\nTải aggTrades ${dayCount} ngày từ data.binance.vision (bulk dump)...`);
  const minuteDelta = new Map<number, number>();

  const SAVE_EVERY_N_DAYS = 10;
  for (let d = 0; d < dayCount; d++) {
    const dateStr = toDateString(START_TIME + d * 24 * 60 * 60 * 1000);
    process.stdout.write(`\r  [${d + 1}/${dayCount}] ${dateStr}...`);

    const zipBuffer = await downloadDailyAggTrades(dateStr);
    if (!zipBuffer) {
      console.log(`\n  Không có dữ liệu cho ${dateStr}, bỏ qua.`);
      continue;
    }

    const zip = new AdmZip(zipBuffer);
    const entry = zip.getEntries()[0];
    const csvText = entry.getData().toString("utf-8");
    accumulateDayIntoMinuteDelta(csvText, minuteDelta);

    if (d % SAVE_EVERY_N_DAYS === 0 || d === dayCount - 1) {
      await saveCvd(minuteDelta);
    }
    await sleep(DOWNLOAD_DELAY_MS);
  }
  process.stdout.write("\n");

  console.log(`Hoàn tất: ${minuteDelta.size} phút có giao dịch.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
