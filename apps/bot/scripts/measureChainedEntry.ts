import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { checkNoTradeZone } from '../src/noTradeZone/noTradeZone.js';
import type { Candle } from '../src/noTradeZone/types.js';
import { classifyTrendH1 } from '../src/trend/trendH1.js';
import { detectFvg, DEFAULT_FVG_CONFIG } from '../src/entry/fvg.js';
import { DEFAULT_FVG_STRATEGY_CONFIG } from '../src/entry/fvgStrategyConfig.js';
import type { Direction } from '../src/entry/types.js';
import { calculatePositionSize } from '../src/positionSizing/positionSizing.js';
import { DEFAULT_MAX_MARGIN_PCT } from '../src/positionSizing/types.js';

// TICKET-RT-046: MEASUREMENT ONLY — does a fresh, standard-entry-rule FVG setup exist right after a
// trade closes at TP=2.10R (RT-045's now-production target), and is it worth taking? No new "auto
// re-enter on TP" mechanism is built here — the chained setup is detected/filled using the exact
// same detectFvg/checkNoTradeZone/classifyTrendH1/calculatePositionSize/config imports and the exact
// same fill/timeout rules as production (via DEFAULT_FVG_STRATEGY_CONFIG, now targetRMultiple=2.1).
// fvg.ts/fvgStrategyConfig.ts untouched — reading the current (already RT-045-updated) production
// values, not overriding them.
//
// Entry detection for the ORIGINAL 358-trade set is duplicated verbatim from RT-034/036-044 (same
// reason each time: strategy1MeasureFvg.ts's findTrades()/Trade aren't exported and don't carry
// entryIndex/raw path).
//
// "Cung huong" = the standard H1-trend-matched FVG filter already built into detectFvg's caller
// (fvg.direction === trendDirection) — the SAME filter every entry always uses, not an extra
// constraint that the chained setup must match the ORIGINAL trade's direction (the current entry
// rule has no such check, and this ticket does not add one — it only reuses "du filter hien tai").

const H1_MS = 60 * 60 * 1000;
const M15_MS = 15 * 60 * 1000;
const EMA_PERIOD_H1 = 200;

const FLOOR_PCT = DEFAULT_FVG_STRATEGY_CONFIG.minSlPctFloor;
const TARGET_R = DEFAULT_FVG_STRATEGY_CONFIG.targetRMultiple; // 2.1, production as of RT-045
const SWEEP_CONFIG = {
  minCandle2BodyRatio: DEFAULT_FVG_CONFIG.minCandle2BodyRatio,
  maxWaitCandles: DEFAULT_FVG_STRATEGY_CONFIG.maxWaitCandles,
  targetRMultiple: TARGET_R,
};

// Step 0's stated window for a "setup nối tiếp ngay sau đó" — ticket gives "5-10 nen" as an example
// range; 10 (the generous end of that range) is used as the primary detection window below.
const CHAIN_DETECTION_WINDOW = 10;

const FEE_PCT_SUM = 0.05 + 0.05 + 0.05 + 0.05; // same constant as every sibling script since RT-027

const BALANCE = 500;
const RISK_PCT = 0.01;
const RISK_USD = BALANCE * RISK_PCT;
const LEVERAGE: Record<string, number> = {
  BTCUSDT: 20,
  ETHUSDT: 20,
  SOLUSDT: 10,
  HYPEUSDT: 10,
  XRPUSDT: 10,
};

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

type Outcome = 'TP' | 'SL' | 'STILL_OPEN';

interface PendingFvg {
  direction: Direction;
  gapLow: number;
  gapHigh: number;
  invalidationPrice: number;
  waitCount: number;
}

interface BaseTrade {
  symbol: string;
  direction: Direction;
  entryIndex: number;
  entryPrice: number;
  slPrice: number;
  tpPrice: number; // 2.1R, current production
  slDistance: number;
  qty: number;
  notional: number;
  baselineOutcome: Outcome;
  baselineExitIndex: number;
}

async function findBaseTrades(symbol: string, dataDir: string, m15AllOut: Map<string, Candle[]>, h1AllOut: Map<string, Candle[]>): Promise<BaseTrade[]> {
  const h1All = await readCsv(path.join(dataDir, `${symbol}_1h.csv`));
  const m15All = await readCsv(path.join(dataDir, `${symbol}_15m.csv`));
  m15AllOut.set(symbol, m15All);
  h1AllOut.set(symbol, h1All);
  const leverage = LEVERAGE[symbol];

  let h1Cursor = 0;
  const trades: BaseTrade[] = [];
  let pending: PendingFvg | null = null;

  for (let i = 2; i < m15All.length; i++) {
    const m15CloseTime = m15All[i].openTime + M15_MS;
    while (h1Cursor < h1All.length && h1All[h1Cursor].openTime + H1_MS <= m15CloseTime) h1Cursor++;
    if (h1Cursor === 0) continue;

    const h1Window = h1All.slice(0, h1Cursor);
    const m15Window = m15All.slice(0, i + 1);
    const closePrice = h1Window[h1Window.length - 1].close;

    const ntz = checkNoTradeZone({
      nowMs: m15CloseTime,
      bid: closePrice,
      ask: closePrice,
      h1Candles: h1Window,
      m15Candles: m15Window,
    });

    if (pending) {
      pending.waitCount++;
      const candle = m15All[i];
      const touchedGap = candle.low <= pending.gapHigh && candle.high >= pending.gapLow;

      if (touchedGap && !ntz.blocked) {
        const entryPrice = pending.direction === 'LONG' ? pending.gapLow : pending.gapHigh;
        const slPrice = pending.invalidationPrice;
        const slDistance = Math.abs(entryPrice - slPrice);

        if (slDistance > 0) {
          const tpPrice =
            pending.direction === 'LONG' ? entryPrice + SWEEP_CONFIG.targetRMultiple * slDistance : entryPrice - SWEEP_CONFIG.targetRMultiple * slDistance;
          const sizing = calculatePositionSize({
            balance: BALANCE,
            riskUsd: RISK_USD,
            entryPrice,
            slPrice,
            leverage,
            maxMarginPct: DEFAULT_MAX_MARGIN_PCT,
          });
          if (sizing) {
            const baselineScan = scanTouch(m15All, i, pending.direction, slPrice, tpPrice);
            trades.push({
              symbol,
              direction: pending.direction,
              entryIndex: i,
              entryPrice,
              slPrice,
              tpPrice,
              slDistance,
              qty: sizing.qty,
              notional: sizing.notional,
              baselineOutcome: baselineScan.outcome,
              baselineExitIndex: baselineScan.index,
            });
          }
        }
        pending = null;
      } else if (pending.waitCount >= SWEEP_CONFIG.maxWaitCandles) {
        pending = null;
      }
    }

    if (ntz.blocked) continue;

    const trend = classifyTrendH1(h1Window, EMA_PERIOD_H1);
    if (trend === null) continue;
    const trendDirection: Direction = trend === 'UPTREND' ? 'LONG' : 'SHORT';

    const fvg = detectFvg(m15All[i - 2], m15All[i - 1], m15All[i], { minCandle2BodyRatio: SWEEP_CONFIG.minCandle2BodyRatio });
    if (fvg.isFvg && fvg.direction === trendDirection && fvg.gapLow !== undefined && fvg.gapHigh !== undefined && fvg.invalidationPrice !== undefined) {
      pending = {
        direction: fvg.direction,
        gapLow: fvg.gapLow,
        gapHigh: fvg.gapHigh,
        invalidationPrice: fvg.invalidationPrice,
        waitCount: 0,
      };
    }
  }

  return trades;
}

function scanTouch(m15All: Candle[], fromIndex: number, direction: Direction, slPrice: number, tpPrice: number): { outcome: Outcome; index: number } {
  for (let j = fromIndex + 1; j < m15All.length; j++) {
    const candle = m15All[j];
    const slTouched = direction === 'LONG' ? candle.low <= slPrice : candle.high >= slPrice;
    const tpTouched = direction === 'LONG' ? candle.high >= tpPrice : candle.low <= tpPrice;
    if (slTouched) return { outcome: 'SL', index: j };
    if (tpTouched) return { outcome: 'TP', index: j };
  }
  return { outcome: 'STILL_OPEN', index: m15All.length - 1 };
}

function directedDelta(direction: Direction, entryPrice: number, exitPrice: number): number {
  return direction === 'LONG' ? exitPrice - entryPrice : entryPrice - exitPrice;
}

function getH1Window(h1All: Candle[], m15CloseTime: number): Candle[] {
  let cursor = 0;
  while (cursor < h1All.length && h1All[cursor].openTime + H1_MS <= m15CloseTime) cursor++;
  return h1All.slice(0, cursor);
}

interface ChainedEntry {
  symbol: string;
  chainEntryIndex: number;
  direction: Direction;
  entryPrice: number;
  slPrice: number;
  tpPrice: number;
  slDistance: number;
  qty: number;
  notional: number;
  outcome: Outcome;
  pnl: number;
}

// Reuses the EXACT same entry/fill rule as production (same detectFvg/NTZ/trend/sizing calls), just
// gated so a fresh FVG's candle3 must appear within [tpTouchIndex+1, tpTouchIndex+windowCandles] —
// the fill-wait itself still follows the normal maxWaitCandles timeout, unbounded by that window.
function findChainedEntry(
  symbol: string,
  m15All: Candle[],
  h1All: Candle[],
  leverage: number,
  tpTouchIndex: number,
  windowCandles: number,
): ChainedEntry | null {
  let pending: PendingFvg | null = null;

  for (let i = tpTouchIndex + 1; i < m15All.length; i++) {
    if (i < 2) continue;
    const m15CloseTime = m15All[i].openTime + M15_MS;
    const h1Window = getH1Window(h1All, m15CloseTime);
    if (h1Window.length === 0) continue;

    const m15Window = m15All.slice(0, i + 1);
    const closePrice = h1Window[h1Window.length - 1].close;
    const ntz = checkNoTradeZone({
      nowMs: m15CloseTime,
      bid: closePrice,
      ask: closePrice,
      h1Candles: h1Window,
      m15Candles: m15Window,
    });

    if (pending) {
      pending.waitCount++;
      const candle = m15All[i];
      const touchedGap = candle.low <= pending.gapHigh && candle.high >= pending.gapLow;

      if (touchedGap && !ntz.blocked) {
        const entryPrice = pending.direction === 'LONG' ? pending.gapLow : pending.gapHigh;
        const slPrice = pending.invalidationPrice;
        const slDistance = Math.abs(entryPrice - slPrice);

        if (slDistance > 0) {
          const tpPrice = pending.direction === 'LONG' ? entryPrice + TARGET_R * slDistance : entryPrice - TARGET_R * slDistance;
          const sizing = calculatePositionSize({
            balance: BALANCE,
            riskUsd: RISK_USD,
            entryPrice,
            slPrice,
            leverage,
            maxMarginPct: DEFAULT_MAX_MARGIN_PCT,
          });
          if (sizing) {
            const slPct = (slDistance / entryPrice) * 100;
            if (slPct >= FLOOR_PCT) {
              const scan = scanTouch(m15All, i, pending.direction, slPrice, tpPrice);
              const exitPrice = scan.outcome === 'TP' ? tpPrice : scan.outcome === 'SL' ? slPrice : entryPrice;
              const cost = (sizing.notional * FEE_PCT_SUM) / 100;
              const pnl = scan.outcome === 'STILL_OPEN' ? 0 : sizing.qty * directedDelta(pending.direction, entryPrice, exitPrice) - cost;
              return {
                symbol,
                chainEntryIndex: i,
                direction: pending.direction,
                entryPrice,
                slPrice,
                tpPrice,
                slDistance,
                qty: sizing.qty,
                notional: sizing.notional,
                outcome: scan.outcome,
                pnl,
              };
            }
          }
        }
        pending = null;
      } else if (pending.waitCount >= SWEEP_CONFIG.maxWaitCandles) {
        pending = null;
      }
    }

    if (ntz.blocked) continue;

    const trend = classifyTrendH1(h1Window, EMA_PERIOD_H1);
    if (trend === null) continue;
    const trendDirection: Direction = trend === 'UPTREND' ? 'LONG' : 'SHORT';

    // Only accept a FRESH FVG whose candle3 falls within the detection window.
    if (i <= tpTouchIndex + windowCandles) {
      const fvg = detectFvg(m15All[i - 2], m15All[i - 1], m15All[i], { minCandle2BodyRatio: SWEEP_CONFIG.minCandle2BodyRatio });
      if (fvg.isFvg && fvg.direction === trendDirection && fvg.gapLow !== undefined && fvg.gapHigh !== undefined && fvg.invalidationPrice !== undefined) {
        pending = {
          direction: fvg.direction,
          gapLow: fvg.gapLow,
          gapHigh: fvg.gapHigh,
          invalidationPrice: fvg.invalidationPrice,
          waitCount: 0,
        };
      }
    }

    // No fresh FVG can appear anymore (past the detection window) and nothing is pending -> give up.
    if (i > tpTouchIndex + windowCandles && pending === null) break;
  }

  return null;
}

async function main() {
  const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'HYPEUSDT', 'XRPUSDT'];
  const dataDir = path.resolve(process.cwd(), 'apps/bot/data');
  const m15Map = new Map<string, Candle[]>();
  const h1Map = new Map<string, Candle[]>();

  let allTrades: BaseTrade[] = [];
  for (const symbol of symbols) {
    const trades = await findBaseTrades(symbol, dataDir, m15Map, h1Map);
    allTrades = allTrades.concat(trades);
  }

  const filled = allTrades.filter((t) => (t.slDistance / t.entryPrice) * 100 >= FLOOR_PCT);
  console.log(`Tong lenh da fill (targetRMultiple=${TARGET_R}, production RT-045): n=${filled.length} (ky vong 358, doi chieu RT-045: $653.72, PF=1.61, winRate=52.8%)`);

  const tpTrades = filled.filter((t) => t.baselineOutcome === 'TP');
  console.log(`So lenh cham TP=${TARGET_R}R: n=${tpTrades.length}`);

  const chainedResults = tpTrades.map((t) => ({
    original: t,
    chain: findChainedEntry(t.symbol, m15Map.get(t.symbol)!, h1Map.get(t.symbol)!, LEVERAGE[t.symbol], t.baselineExitIndex, CHAIN_DETECTION_WINDOW),
  }));

  const withChain = chainedResults.filter((r) => r.chain !== null);
  console.log(
    `\n% lenh (trong nhom TP=${TARGET_R}R) co setup FVG hop le noi tiep trong ${CHAIN_DETECTION_WINDOW} nen M15: ${withChain.length}/${tpTrades.length} (${((withChain.length / tpTrades.length) * 100).toFixed(1)}%)`,
  );

  const decided = withChain.filter((r) => r.chain!.outcome !== 'STILL_OPEN');
  const stillOpenChain = withChain.filter((r) => r.chain!.outcome === 'STILL_OPEN');
  let totalChainPnl = 0;
  let wins = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  for (const r of decided) {
    const p = r.chain!.pnl;
    totalChainPnl += p;
    if (p > 0) {
      wins++;
      grossProfit += p;
    } else if (p < 0) {
      grossLoss += Math.abs(p);
    }
  }
  const chainWinRate = decided.length > 0 ? (wins / decided.length) * 100 : 0;
  const chainPF = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

  console.log(`\n=== PnL cua cac setup noi tiep (da tinh du phi lan 2 = FEE_PCT_SUM ${FEE_PCT_SUM}% rieng) ===`);
  console.log(`  n co outcome (TP/SL): ${decided.length}  (STILL_OPEN loai khoi PnL: ${stillOpenChain.length})`);
  console.log(`  PnL$ tong cac setup noi tiep: $${totalChainPnl.toFixed(2)}`);
  console.log(`  winRate=${chainWinRate.toFixed(1)}%  PF=${Number.isFinite(chainPF) ? chainPF.toFixed(2) : 'inf'}`);
  console.log(
    `  -> ${totalChainPnl > 0 ? 'CO LOI: cong don PnL tang them, phi khong an het loi nhuan them' : 'KHONG co loi: phi an het (hoac vuot) loi nhuan them tu cac setup noi tiep'}`,
  );

  console.log('\n=== Breakdown 5 coin ===');
  console.log('symbol'.padEnd(12) + 'TP_trades'.padEnd(12) + 'co_chain'.padEnd(10) + '%chain'.padEnd(10) + 'chain_n'.padEnd(10) + 'chain_PnL$'.padEnd(14) + 'chain_PF');
  for (const symbol of symbols) {
    const symbolTpTrades = tpTrades.filter((t) => t.symbol === symbol);
    const symbolChained = chainedResults.filter((r) => r.original.symbol === symbol && r.chain !== null);
    const symbolDecided = symbolChained.filter((r) => r.chain!.outcome !== 'STILL_OPEN');
    let symPnl = 0;
    let symWins = 0;
    let symGrossProfit = 0;
    let symGrossLoss = 0;
    for (const r of symbolDecided) {
      const p = r.chain!.pnl;
      symPnl += p;
      if (p > 0) {
        symWins++;
        symGrossProfit += p;
      } else if (p < 0) {
        symGrossLoss += Math.abs(p);
      }
    }
    const symPF = symGrossLoss > 0 ? symGrossProfit / symGrossLoss : symGrossProfit > 0 ? Infinity : 0;
    const pctChain = symbolTpTrades.length > 0 ? (symbolChained.length / symbolTpTrades.length) * 100 : 0;
    console.log(
      symbol.padEnd(12) +
        String(symbolTpTrades.length).padEnd(12) +
        String(symbolChained.length).padEnd(10) +
        `${pctChain.toFixed(1)}%`.padEnd(10) +
        String(symbolDecided.length).padEnd(10) +
        `$${symPnl.toFixed(2)}`.padEnd(14) +
        `${Number.isFinite(symPF) ? symPF.toFixed(2) : 'inf'}`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
