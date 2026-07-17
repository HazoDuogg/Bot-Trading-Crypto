/**
 * Temporary wiring for manually smoke-testing regime/ + risk/ in isolation, per this sprint's
 * scope — this is NOT a complete bot. entry/ and xgbFilter/ are NOT_IMPLEMENTED placeholders and
 * are intentionally not wired in here. Does not choose Static vs Dynamic-R sizer as a default —
 * PM has not picked one, so both run side by side for comparison.
 *
 * Run: npm run build && node dist/index.js
 */
import { detectRegime } from './regime/regimeDetector.js';
import type { CandleData } from './regime/types.js';
import { StaticMarginSizer } from './risk/staticMarginSizer.js';
import { DynamicRMarginSizer } from './risk/dynamicRMarginSizer.js';
import { checkRiskPool, type OpenPositionRisk } from './risk/riskPool.js';
import type { PositionSizingInput } from './risk/types.js';

// Synthetic candles for wiring smoke-tests only — replace with real OHLCV loaded from data/
// (see data/README.md) once available.
function dummyCandles(count: number, intervalMs: number, basePrice: number): CandleData[] {
  const startTs = Date.UTC(2024, 0, 1);
  const candles: CandleData[] = [];
  let prevClose = basePrice;
  for (let i = 0; i < count; i++) {
    const close = basePrice + i * 0.01;
    const open = prevClose;
    const high = Math.max(open, close) + 0.5;
    const low = Math.min(open, close) - 0.5;
    candles.push({ timestamp: startTs + i * intervalMs, open, high, low, close, volume: 1000 });
    prevClose = close;
  }
  return candles;
}

function demoRegime(): void {
  const output = detectRegime({
    candles5m: dummyCandles(320, 300_000, 100),
    candles15m: dummyCandles(325, 900_000, 100),
    candles1h: dummyCandles(40, 3_600_000, 100),
  });
  console.log('[regime] output:', output);
}

function demoRisk(): void {
  const input: PositionSizingInput = {
    accountBalance: 400,
    riskDollarOrPercent: 10,
    entryPrice: 100,
    slDistancePercent: 0.01,
    leverage: 30,
  };

  const staticSizer = new StaticMarginSizer();
  const dynamicSizer = new DynamicRMarginSizer();

  console.log('[risk] StaticMarginSizer:', staticSizer.calculate(input));
  console.log('[risk] DynamicRMarginSizer:', dynamicSizer.calculate({ ...input, maxMarginCap: 50 }));

  const openPositions: OpenPositionRisk[] = [{ id: 'BTC', actualRiskDollar: 8 }];
  console.log('[risk] riskPool check:', checkRiskPool(openPositions, input.accountBalance));
}

demoRegime();
demoRisk();
