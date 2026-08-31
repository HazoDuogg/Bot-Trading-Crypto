import { deflateSync } from 'node:zlib';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  type AnnotationDataset,
  type AnnotationMapping,
  type Candle,
  isMain,
  parseFlags,
  readJson,
  shuffled,
  stringFlag,
} from './shared.js';

const WIDTH = 1200;
const HEIGHT = 700;
const PADDING = 28;

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuffer = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, checksum]);
}

function setPixel(pixels: Buffer, x: number, y: number, color: readonly [number, number, number]): void {
  if (x < 0 || y < 0 || x >= WIDTH || y >= HEIGHT) return;
  const offset = (y * WIDTH + x) * 3;
  pixels[offset] = color[0];
  pixels[offset + 1] = color[1];
  pixels[offset + 2] = color[2];
}

function verticalLine(
  pixels: Buffer,
  x: number,
  top: number,
  bottom: number,
  color: readonly [number, number, number],
): void {
  for (let y = Math.max(0, top); y <= Math.min(HEIGHT - 1, bottom); y += 1) setPixel(pixels, x, y, color);
}

function filledRectangle(
  pixels: Buffer,
  left: number,
  top: number,
  right: number,
  bottom: number,
  color: readonly [number, number, number],
): void {
  for (let y = Math.max(0, top); y <= Math.min(HEIGHT - 1, bottom); y += 1) {
    for (let x = Math.max(0, left); x <= Math.min(WIDTH - 1, right); x += 1) setPixel(pixels, x, y, color);
  }
}

export function renderCandlestickPng(candles: readonly Candle[]): Buffer {
  if (candles.length === 0) throw new Error('Cannot render an empty segment');
  const pixels = Buffer.alloc(WIDTH * HEIGHT * 3);
  for (let offset = 0; offset < pixels.length; offset += 3) {
    pixels[offset] = 15;
    pixels[offset + 1] = 18;
    pixels[offset + 2] = 22;
  }

  const minimum = Math.min(...candles.map((candle) => candle.low));
  const maximum = Math.max(...candles.map((candle) => candle.high));
  const priceSpan = maximum - minimum || Math.max(Math.abs(maximum), 1) * 0.01;
  const chartHeight = HEIGHT - PADDING * 2;
  const yFor = (price: number): number =>
    Math.round(PADDING + ((maximum - price) / priceSpan) * chartHeight);
  const slotWidth = (WIDTH - PADDING * 2) / candles.length;
  const bodyHalfWidth = Math.max(2, Math.floor(slotWidth * 0.31));

  candles.forEach((candle, index) => {
    const x = Math.round(PADDING + slotWidth * (index + 0.5));
    const rising = candle.close >= candle.open;
    const color = rising ? ([42, 196, 141] as const) : ([235, 87, 87] as const);
    verticalLine(pixels, x, yFor(candle.high), yFor(candle.low), color);
    const bodyTop = Math.min(yFor(candle.open), yFor(candle.close));
    const bodyBottom = Math.max(yFor(candle.open), yFor(candle.close));
    filledRectangle(pixels, x - bodyHalfWidth, bodyTop, x + bodyHalfWidth, Math.max(bodyTop + 1, bodyBottom), color);
  });

  const scanlines = Buffer.alloc(HEIGHT * (1 + WIDTH * 3));
  for (let y = 0; y < HEIGHT; y += 1) {
    const rowOffset = y * (1 + WIDTH * 3);
    scanlines[rowOffset] = 0;
    pixels.copy(scanlines, rowOffset + 1, y * WIDTH * 3, (y + 1) * WIDTH * 3);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(WIDTH, 0);
  header.writeUInt32BE(HEIGHT, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(scanlines, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

async function assertNoExistingCharts(chartsDirectory: string): Promise<void> {
  await mkdir(chartsDirectory, { recursive: true });
  const existing = (await readdir(chartsDirectory)).filter((name) => /^seg_\d+\.png$/u.test(name));
  if (existing.length > 0) {
    throw new Error(`${chartsDirectory} already contains ${existing.length} segment chart(s); use a fresh directory`);
  }
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const datasetPath = path.resolve(stringFlag(flags, 'dataset'));
  const chartsDirectory = path.resolve(stringFlag(flags, 'charts-dir', 'apps/bot/annotation-output/blinded/charts'));
  const mappingPath = path.resolve(
    stringFlag(flags, 'mapping', 'apps/bot/annotation-output/private/mapping.private.json'),
  );
  const dataset = await readJson<AnnotationDataset>(datasetPath);
  if (dataset.schemaVersion !== 1 || dataset.segments.length === 0) throw new Error('Unsupported or empty dataset');
  await assertNoExistingCharts(chartsDirectory);
  await mkdir(path.dirname(mappingPath), { recursive: true });

  const shuffleSeed = `${dataset.seed}:render-order`;
  const randomized = shuffled(dataset.segments, shuffleSeed);
  const width = Math.max(4, String(randomized.length).length);
  const entries: AnnotationMapping['entries'] = [];
  for (let index = 0; index < randomized.length; index += 1) {
    const segment = randomized[index];
    const segmentId = `seg_${String(index + 1).padStart(width, '0')}`;
    const chartFile = `${segmentId}.png`;
    await writeFile(path.join(chartsDirectory, chartFile), renderCandlestickPng(segment.candles));
    entries.push({
      segmentId,
      chartFile,
      sourceId: segment.sourceId,
      symbol: segment.symbol,
      decisionOpenTime: segment.decisionOpenTime,
      sourceStartIndex: segment.sourceStartIndex,
      candleCount: segment.candles.length,
    });
  }

  const mapping: AnnotationMapping = {
    schemaVersion: 1,
    seed: dataset.seed,
    shuffleSeed,
    datasetFile: datasetPath,
    chartsDirectory,
    entries,
  };
  await writeFile(mappingPath, `${JSON.stringify(mapping, null, 2)}\n`, 'utf8');
  console.log(`Rendered ${entries.length} blinded charts in ${chartsDirectory}`);
  console.log(`Keep the private mapping away from annotators: ${mappingPath}`);
}

if (isMain(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
