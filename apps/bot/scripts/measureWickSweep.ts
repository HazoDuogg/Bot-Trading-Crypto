import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { checkNoTradeZone } from '../src/noTradeZone/noTradeZone.js';
import type { Candle } from '../src/noTradeZone/types.js';
import { classifyRegime } from '../src/regime/regimeClassifier.js';
import { routeRegimeMatrix } from '../src/regime/regimeMatrix.js';
import { DEFAULT_REGIME_CONFIG } from '../src/regime/types.js';
import type { Direction, Strategy } from '../src/regime/types.js';
import { detectPinBar } from '../src/entry/pinBar.js';
import { detectEngulfing } from '../src/entry/engulfing.js';
import { detectBos } from '../src/entry/bos.js';
import { DEFAULT_BOS_CONFIG } from '../src/entry/types.js';
import { checkPullbackZone, DEFAULT_PULLBACK_ZONE_CONFIG } from '../src/entry/pullbackZone.js';
import { computeAtr } from '../src/noTradeZone/atr.js';
import { calculateSl } from '../src/risk/slCalculator.js';
import type { EntryStrategy } from '../src/risk/types.js';
import { calculatePartialTp } from '../src/risk/partialTpCalculator.js';

const H1_MS = 60 * 60 * 1000;
const M15_MS = 15 * 60 * 1000;
const ATR_PERIOD = 14;
const SWING_WIDTH = DEFAULT_REGIME_CONFIG.swingPivotWidth;
const MAX_LOOKAHEAD_CANDLES = 50;

async function readCsv(filePath: string): Promise<Candle[]> {
  const raw = await readFile(filePath, 'utf8');
  const lines = raw.trim().split('\n').slice(1);
  return lines.map((line) => {
    const [openTime, open, high, low, close, volume] = line.split(',');
    return {
      openTime: Number(openTime),
      open: Number(open),
      high: Number(high),
      low: Number(low),
      close: Number(close),
      volume: Number(volume),
    };
  });
}

interface PassingSignal {
  strategy: 'TREND_PULLBACK' | 'BREAKOUT_WATCH';
  direction: Direction;
  entryIndex: number; // index into the symbol's m5All array
  tp1Price: number;
  tp2Price: number;
}

function candlestickDirection(m5Window: Candle[]): Direction | null {
  const current = m5Window[m5Window.length - 1];
  const pinBar = detectPinBar(current);
  if (pinBar.isPinBar && pinBar.direction) return pinBar.direction;

  if (m5Window.length >= 2) {
    const prev = m5Window[m5Window.length - 2];
    const engulfing = detectEngulfing(prev, current);
    if (engulfing.isEngulfing && engulfing.direction) return engulfing.direction;
  }
  return null;
}

async function findPassingSignals(symbol: string, dataDir: string): Promise<{ signals: PassingSignal[]; m5All: Candle[] }> {
  const h1All = await readCsv(path.join(dataDir, `${symbol}_1h.csv`));
  const m15All = await readCsv(path.join(dataDir, `${symbol}_15m.csv`));
  const m5All = await readCsv(path.join(dataDir, `${symbol}_5m.csv`));

  const signals: PassingSignal[] = [];
  let h1Cursor = 0;
  let m15Cursor = 0;

  for (let i = 0; i < m5All.length; i++) {
    const m5CloseTime = m5All[i].openTime + 5 * 60 * 1000;

    while (h1Cursor < h1All.length && h1All[h1Cursor].openTime + H1_MS <= m5CloseTime) h1Cursor++;
    while (m15Cursor < m15All.length && m15All[m15Cursor].openTime + M15_MS <= m5CloseTime) m15Cursor++;
    if (h1Cursor === 0 || m15Cursor === 0) continue;

    const h1Window = h1All.slice(0, h1Cursor);
    const m15Window = m15All.slice(0, m15Cursor);
    const closePrice = h1Window[h1Window.length - 1].close;

    const ntz = checkNoTradeZone({
      nowMs: m5CloseTime,
      bid: closePrice,
      ask: closePrice,
      h1Candles: h1Window,
      m15Candles: m15Window,
    });
    if (ntz.blocked) continue;

    const regimeH1 = classifyRegime(h1Window);
    const regimeM15 = classifyRegime(m15Window);
    const matrix = routeRegimeMatrix(regimeH1.state, regimeM15.state);
    if (matrix.strategy !== 'TREND_PULLBACK' && matrix.strategy !== 'BREAKOUT_WATCH') continue;

    const m5Window = m5All.slice(0, i + 1);
    const atrValues = computeAtr(m5Window, ATR_PERIOD);
    if (atrValues.length === 0) continue;
    const atrM5 = atrValues[atrValues.length - 1];

    let direction: Direction | undefined;
    let brokenLevel: number | undefined;

    if (matrix.strategy === 'TREND_PULLBACK') {
      const signalDir = candlestickDirection(m5Window);
      if (signalDir !== matrix.direction) continue;

      const zone = checkPullbackZone({
        direction: matrix.direction,
        entryPrice: m5Window[m5Window.length - 1].close,
        m15Candles: m15Window,
        swingPivotWidth: SWING_WIDTH,
        atrM5,
        toleranceAtrMultiplier: DEFAULT_PULLBACK_ZONE_CONFIG.toleranceAtrMultiplier,
      });
      if (!zone.valid) continue;

      direction = matrix.direction;
    } else {
      const bos = detectBos(m5Window, DEFAULT_BOS_CONFIG);
      if (!bos.isBos || bos.direction !== matrix.direction) continue;
      direction = matrix.direction;
      brokenLevel = bos.brokenLevel;
    }
    if (!direction) continue;

    const entryPrice = m5Window[m5Window.length - 1].close;
    const slResult = calculateSl({
      strategy: matrix.strategy as EntryStrategy,
      direction,
      entryPrice,
      m5Candles: m5Window,
      swingPivotWidth: SWING_WIDTH,
      brokenLevel,
      atrM5,
    });
    if (!slResult) continue;

    const partialTp = calculatePartialTp({ direction, entryPrice, slPrice: slResult.slPrice });
    if (!partialTp.passes) continue;

    signals.push({
      strategy: matrix.strategy,
      direction,
      entryIndex: i,
      tp1Price: partialTp.tp1Price,
      tp2Price: partialTp.tp2Price,
    });
  }

  return { signals, m5All };
}

type SweepOutcome = 'sustained' | 'wick-only' | 'undetermined';

function classifyTouch(m5All: Candle[], entryIndex: number, direction: Direction, tpPrice: number): SweepOutcome {
  const start = entryIndex + 1;
  const end = Math.min(m5All.length - 1, entryIndex + MAX_LOOKAHEAD_CANDLES);

  for (let j = start; j <= end; j++) {
    const candle = m5All[j];
    const touched = direction === 'LONG' ? candle.high >= tpPrice : candle.low <= tpPrice;
    if (!touched) continue;

    const closeFavorable = direction === 'LONG' ? candle.close >= tpPrice : candle.close <= tpPrice;
    if (closeFavorable) return 'sustained';

    const next = m5All[j + 1];
    if (next) {
      const nextFavorable = direction === 'LONG' ? next.close >= tpPrice : next.close <= tpPrice;
      if (nextFavorable) return 'sustained';
    }
    return 'wick-only';
  }
  return 'undetermined';
}

interface LegStats {
  total: number;
  touched: number;
  sustained: number;
  wickOnly: number;
}

function emptyStats(): LegStats {
  return { total: 0, touched: 0, sustained: 0, wickOnly: 0 };
}

function printLegStats(label: string, stats: LegStats): void {
  const touchedPct = stats.total > 0 ? (stats.touched / stats.total) * 100 : 0;
  const sustainedPct = stats.touched > 0 ? (stats.sustained / stats.touched) * 100 : 0;
  const wickOnlyPct = stats.touched > 0 ? (stats.wickOnly / stats.touched) * 100 : 0;
  console.log(
    `  ${label}: n=${stats.total}  touched=${stats.touched} (${touchedPct.toFixed(1)}%)  |  trong so touched: sustained=${stats.sustained} (${sustainedPct.toFixed(1)}%)  wick-only=${stats.wickOnly} (${wickOnlyPct.toFixed(1)}%)`,
  );
}

async function main() {
  const symbols = ['BTCUSDT', 'ETHUSDT'];
  const dataDir = path.resolve(process.cwd(), 'apps/bot/data');
  const strategies: Strategy[] = ['TREND_PULLBACK', 'BREAKOUT_WATCH'];

  console.log(
    'LUU Y: day la proxy gian tiep tu OHLC (khong co order book/tick data), khong phai mo phong khop lenh that.\n' +
    'Ket qua chi mang tinh tham khao, khong thay the viec theo doi fill-rate that khi chay testnet.\n',
  );

  for (const symbol of symbols) {
    console.log(`Processing ${symbol}...`);
    const { signals, m5All } = await findPassingSignals(symbol, dataDir);
    console.log(`  ${signals.length} tin hieu da pass (TREND_PULLBACK + BREAKOUT_WATCH)\n`);

    console.log(`=== ${symbol} ===`);
    for (const strategy of strategies) {
      const subset = signals.filter((s) => s.strategy === strategy);
      console.log(`\n${strategy} (n=${subset.length}):`);
      if (subset.length === 0) continue;

      const tp1Stats = emptyStats();
      const tp2Stats = emptyStats();

      for (const signal of subset) {
        for (const [stats, tpPrice] of [
          [tp1Stats, signal.tp1Price],
          [tp2Stats, signal.tp2Price],
        ] as const) {
          stats.total++;
          const outcome = classifyTouch(m5All, signal.entryIndex, signal.direction, tpPrice);
          if (outcome === 'undetermined') continue;
          stats.touched++;
          if (outcome === 'sustained') stats.sustained++;
          else stats.wickOnly++;
        }
      }

      printLegStats('TP1', tp1Stats);
      printLegStats('TP2', tp2Stats);
    }
    console.log('');
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
