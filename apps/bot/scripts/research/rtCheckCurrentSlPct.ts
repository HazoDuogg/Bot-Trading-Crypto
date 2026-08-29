import { config as loadEnv } from 'dotenv';
loadEnv();

import { SymbolSignalEngine } from '../../src/live/signalEngine.js';
import { DEFAULT_FVG_STRATEGY_CONFIG } from '../../src/entry/fvgStrategyConfig.js';
import type { Candle } from '../../src/noTradeZone/types.js';

const BASE_URL = process.env.BINANCE_URL;
if (!BASE_URL) throw new Error('BINANCE_URL missing from .env');

const FLOOR_PCT = DEFAULT_FVG_STRATEGY_CONFIG.minSlPctFloor;
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'HYPEUSDT', 'DOGEUSDT'];

async function fetchKlines(symbol: string, interval: string, limit: number): Promise<Candle[]> {
  const url = new URL('/fapi/v1/klines', BASE_URL);
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('interval', interval);
  url.searchParams.set('limit', String(limit));
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${symbol} ${interval}: ${res.status} ${await res.text()}`);
  const raw = (await res.json()) as unknown[][];
  const now = Date.now();
  return raw
    .map((row) => ({ openTime: row[0] as number, open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]), volume: Number(row[5]) }))
    .filter((c) => c.openTime + (interval === '1h' ? 3600000 : 900000) <= now); // closed candles only
}

async function main() {
  console.log(`FLOOR_PCT (minSlPctFloor, production) = ${FLOOR_PCT}%\n`);

  for (const symbol of SYMBOLS) {
    const h1 = await fetchKlines(symbol, '1h', 300);
    const m15 = await fetchKlines(symbol, '15m', 300);

    const engine = new SymbolSignalEngine(symbol);
    for (const c of h1) engine.onNewH1Candle(c);

    const signals: { time: string; direction: string; slPct: number; skipped: boolean }[] = [];
    for (const c of m15) {
      const signal = engine.checkForNewSignal(c, true);
      if (signal) {
        const entryPrice = signal.direction === 'LONG' ? signal.gapLow : signal.gapHigh;
        const slDistance = Math.abs(entryPrice - signal.invalidationPrice);
        const slPct = (slDistance / entryPrice) * 100;
        signals.push({ time: new Date(signal.detectedAtOpenTime).toISOString(), direction: signal.direction, slPct, skipped: slPct < FLOOR_PCT });
      }
    }

    const debug = engine.getDebugState();
    console.log(`=== ${symbol} === (H1 nen=${debug.h1Count}, currentAtr=${debug.currentAtr?.toFixed(6)}, trend=${debug.trend})`);
    if (signals.length === 0) {
      console.log('  (khong co FVG tin hieu nao trong ~3 ngay M15 gan day — khong co du lieu slPct de kiem tra)');
    } else {
      for (const s of signals.slice(-10)) {
        console.log(`  ${s.time}  ${s.direction.padEnd(5)}  slPct=${s.slPct.toFixed(4)}%  ${s.skipped ? '-> SKIP (duoi floor 0.5%)' : '-> DAT LENH (>= floor)'}`);
      }
      const skippedCount = signals.filter((s) => s.skipped).length;
      console.log(`  Tong: ${signals.length} tin hieu, ${skippedCount} bi skip do slPct < 0.5% (${((skippedCount / signals.length) * 100).toFixed(0)}%).`);
    }
    console.log('');
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
