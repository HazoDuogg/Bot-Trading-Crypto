import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'HYPEUSDT', 'DOGEUSDT'] as const;
export const INTERVAL = '15m';
export const INTERVAL_MS = 15 * 60 * 1000;
export const DEFAULT_CONTEXT_CANDLES = 80;

export interface Candle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface AnnotationSegment {
  sourceId: string;
  symbol: string;
  sourceStartIndex: number;
  decisionOpenTime: number;
  candles: Candle[];
}

export interface AnnotationDataset {
  schemaVersion: 1;
  seed: string;
  interval: typeof INTERVAL;
  intervalMs: number;
  contextCandles: number;
  candlesPerSegment: number;
  segmentsPerCoin: number;
  cutoffTime: number;
  samplingStartTime: number;
  sourceMonthsBack: number;
  sourceSha256BySymbol: Record<string, string>;
  generatedAt: string;
  symbols: string[];
  segments: AnnotationSegment[];
}

export interface MappingEntry {
  segmentId: string;
  chartFile: string;
  sourceId: string;
  symbol: string;
  decisionOpenTime: number;
  sourceStartIndex: number;
  candleCount: number;
}

export interface AnnotationMapping {
  schemaVersion: 1;
  seed: string;
  shuffleSeed: string;
  datasetFile: string;
  chartsDirectory: string;
  entries: MappingEntry[];
}

export interface LabelDocument {
  segment_id: string;
  quality: 'CLEAN' | 'CHAOTIC' | 'UNCLEAR' | null;
  dominance: 'BULL' | 'BEAR' | 'NEUTRAL' | null;
  swing_points: Array<{ index: number; type: 'high' | 'low' }>;
  base_zone: { start_index: number; end_index: number } | null;
  compression: boolean | null;
  breakout: 'STRONG' | 'WEAK' | 'NONE' | null;
  reclaim: 'FAILED' | 'SUCCESS' | 'NOT_APPLICABLE' | null;
  notes: string;
}

export function parseFlags(argv: string[]): Map<string, string | true> {
  const flags = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`Unexpected positional argument: ${token}`);
    const equalsAt = token.indexOf('=');
    if (equalsAt >= 0) {
      flags.set(token.slice(2, equalsAt), token.slice(equalsAt + 1));
      continue;
    }
    const name = token.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(name, next);
      index += 1;
    } else {
      flags.set(name, true);
    }
  }
  return flags;
}

export function stringFlag(flags: Map<string, string | true>, name: string, fallback?: string): string {
  const value = flags.get(name);
  if (value === undefined) {
    if (fallback === undefined) throw new Error(`Missing required flag --${name}`);
    return fallback;
  }
  if (value === true) throw new Error(`Flag --${name} requires a value`);
  return value;
}

export function positiveIntegerFlag(flags: Map<string, string | true>, name: string, fallback: number): number {
  const raw = stringFlag(flags, name, String(fallback));
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`--${name} must be a positive integer; received ${raw}`);
  }
  return parsed;
}

function xmur3(value: string): () => number {
  let hash = 1779033703 ^ value.length;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 3432918353);
    hash = (hash << 13) | (hash >>> 19);
  }
  return () => {
    hash = Math.imul(hash ^ (hash >>> 16), 2246822507);
    hash = Math.imul(hash ^ (hash >>> 13), 3266489909);
    return (hash ^= hash >>> 16) >>> 0;
  };
}

export function seededRandom(seed: string): () => number {
  const seedValue = xmur3(seed)();
  let state = seedValue;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffled<T>(values: readonly T[], seed: string): T[] {
  const output = [...values];
  const random = seededRandom(seed);
  for (let index = output.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [output[index], output[other]] = [output[other], output[index]];
  }
  return output;
}

export function blankLabel(segmentId: string): LabelDocument {
  return {
    segment_id: segmentId,
    quality: null,
    dominance: null,
    swing_points: [],
    base_zone: null,
    compression: null,
    breakout: null,
    reclaim: null,
    notes: '',
  };
}

export async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, 'utf8')) as T;
}

export function isMain(importMetaUrl: string): boolean {
  const entry = process.argv[1];
  return entry !== undefined && importMetaUrl === pathToFileURL(entry).href;
}
