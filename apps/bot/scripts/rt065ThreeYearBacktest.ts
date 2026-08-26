import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { checkNoTradeZone } from '../src/noTradeZone/noTradeZone.js';
import type { Candle } from '../src/noTradeZone/types.js';
import { createEmaTracker } from '../src/regime/ema.js';
import { createAtrTracker } from '../src/noTradeZone/atr.js';
import { detectFvg, DEFAULT_FVG_CONFIG } from '../src/entry/fvg.js';
import { DEFAULT_FVG_STRATEGY_CONFIG } from '../src/entry/fvgStrategyConfig.js';
import type { Direction } from '../src/entry/types.js';
import { calculatePositionSize } from '../src/positionSizing/positionSizing.js';
import { DEFAULT_MAX_MARGIN_PCT } from '../src/positionSizing/types.js';
import { findKeyZones } from '../src/zones/keyZones.js';
import type { KeyZone } from '../src/zones/keyZones.js';
import { DEFAULT_REGIME_CONFIG } from '../src/regime/types.js';
import { resolveRiskPct } from '../src/positionSizing/riskConfig.js';
import {
  admitPosition,
  closePosition,
  EMPTY_EXPOSURE_STATE,
  DEFAULT_EXPOSURE_TRACKER_CONFIG,
  type ExposureTrackerState,
} from '../src/positionSizing/exposureTracker.js';

// TICKET-RT-065 Part C: re-confirms the ORIGINAL production strategy (FVG H1+M15 entry,
// targetR=2.10, risk 1.5%/HYPE-breaksKeyZone-split via resolveRiskPct — identical to
// RT-056/057 Config B) on up to 3 years of data (RT-065 Part A). Audit-only, no production file
// touched here — every entry/exit/sizing decision comes from the SAME unmodified production
// functions used throughout RT-051..064 (detectFvg, checkNoTradeZone, calculatePositionSize,
// admitPosition/closePosition, resolveRiskPct, findKeyZones).
//
// TWO changes from the RT-051-style "shared lockstep index" simulation, both required by 3-year
// data and both explained/verified below:
//
// 1. HYPE has ~453 days of history (listed 2025-05-30), not 3 years like the other 4 coins — the
//    RT-051 design's core assumption ("all 5 symbols share an IDENTICAL M15/H1 timestamp grid") no
//    longer holds. Verified empirically (see checkGridsAlignExactly() below, run at startup, fails
//    loudly if violated): BTC/ETH/SOL/XRP's 3y grids are byte-identical (same first/last timestamp,
//    same candle count), and HYPE's grid is an EXACT contiguous tail-suffix of that same grid (its
//    first candle's openTime lines up precisely on a global-grid boundary, with zero gap). This lets
//    the simulation use one shared global M15 index (driven by the 4 always-present coins' array),
//    with HYPE read via a computed offset and simply skipped before its offset (it wasn't tradable
//    yet — that's not a data problem, it's history).
//
// 2. Uses RT-065 Part B's createEmaTracker (src/regime/ema.ts) and createAtrTracker
//    (src/noTradeZone/atr.ts) instead of repeatedly calling computeEma/computeAtr on the ENTIRE
//    growing window every candle (the O(n^2) cost that made this impractical on 3x the data —
//    benchmarked: the M15-scale full-window recompute alone was ~360s/symbol at 1-candle granularity
//    before this change). Both trackers are numerically verified IDENTICAL to computeEma/computeAtr
//    step-by-step in ema.test.ts/atr.test.ts (RT-065 Part B) — using them here for trend
//    classification (replacing classifyTrendH1's internal computeEma call) and for the KeyZone ATR
//    input (replacing the per-detection computeAtr(h1Window,...) call) does not change any decision,
//    only how cheaply the identical value is obtained. checkNoTradeZone() itself is called AS-IS,
//    unmodified, on the true full window every candle (not accelerated) — it is production
//    entry/risk logic this ticket does not touch beyond calling it faithfully.
//
// Self-check strategy: since there is no independently-confirmed "3-year" baseline to compare
// against, this script first runs its OWN simulation function against the EXISTING, UNCHANGED
// apps/bot/data/*_1y.csv files (RT-051's dataset) and asserts an EXACT match to the RT-056/057
// confirmed constants (n=1217, PnL=$2628.76, PF=1.551, maxDD=1.24%) — proving the incremental-EMA
// substitution and the offset-aware loop structure (exercised here with offset=0, since HYPE's 1y
// data already spans the full 1y window) produce bit-for-bit identical decisions to the original
// design before trusting the 3-year output that reuses the exact same code path.

const FVG_KEY_ZONE_CONFIG = {
  swingPivotWidth: DEFAULT_REGIME_CONFIG.swingPivotWidth,
  clusterToleranceAtrMultiplier: 0.5,
  minTouches: 2,
  maxZoneAgeCandles: 500,
};

const H1_MS = 60 * 60 * 1000;
const M15_MS = 15 * 60 * 1000;
const ATR_PERIOD = 14;
const EMA_PERIOD_H1 = 200;

const FLOOR_PCT = DEFAULT_FVG_STRATEGY_CONFIG.minSlPctFloor;
const MAX_WAIT_CANDLES = DEFAULT_FVG_STRATEGY_CONFIG.maxWaitCandles;
const MIN_CANDLE2_BODY_RATIO = DEFAULT_FVG_CONFIG.minCandle2BodyRatio;

const FEE_PCT_SUM = 0.05 + 0.05 + 0.05 + 0.05;
const BALANCE = 500;
const LEVERAGE: Record<string, number> = {
  BTCUSDT: 20,
  ETHUSDT: 20,
  SOLUSDT: 10,
  HYPEUSDT: 10,
  XRPUSDT: 10,
};
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'HYPEUSDT', 'XRPUSDT'];
const REFERENCE_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT']; // must share an identical grid

async function readCsv(filePath: string): Promise<Candle[]> {
  const raw = await readFile(filePath, 'utf8');
  const lines = raw.trim().split('\n').slice(1);
  return lines.map((line) => {
    const [openTime, open, high, low, close, volume] = line.split(',');
    return { openTime: Number(openTime), open: Number(open), high: Number(high), low: Number(low), close: Number(close), volume: Number(volume) };
  });
}

interface SymbolData {
  symbol: string;
  m15All: Candle[];
  h1All: Candle[];
}

async function loadAllSymbolData(dataDir: string, suffix: string): Promise<Map<string, SymbolData>> {
  const out = new Map<string, SymbolData>();
  for (const symbol of SYMBOLS) {
    const m15All = await readCsv(path.join(dataDir, `${symbol}_15m_${suffix}.csv`));
    const h1All = await readCsv(path.join(dataDir, `${symbol}_1h_${suffix}.csv`));
    out.set(symbol, { symbol, m15All, h1All });
  }
  return out;
}

interface GridCheckResult {
  m15Offset: Map<string, number>; // symbol -> offset into the reference M15 grid (0 for reference symbols)
  h1Offset: Map<string, number>;
  referenceM15Length: number;
}

// Verifies BTC/ETH/SOL/XRP share a byte-identical M15+H1 timestamp grid (elementwise, not just
// first/last/count), and computes HYPE's exact offset into that grid (or any other non-reference
// symbol's, generically) — fails loudly (throws) on any mismatch instead of silently proceeding.
function checkGridsAlignExactly(allData: Map<string, SymbolData>): GridCheckResult {
  const ref = allData.get(REFERENCE_SYMBOLS[0])!;
  for (const sym of REFERENCE_SYMBOLS.slice(1)) {
    const d = allData.get(sym)!;
    if (d.m15All.length !== ref.m15All.length || d.h1All.length !== ref.h1All.length) {
      throw new Error(`CORRECTION_REQUIRED: ${sym} co do dai grid khac ${REFERENCE_SYMBOLS[0]} (M15: ${d.m15All.length} vs ${ref.m15All.length}, H1: ${d.h1All.length} vs ${ref.h1All.length}) — gia dinh "4 coin dai han chia se 1 grid" SAI, dung lai.`);
    }
    for (let i = 0; i < ref.m15All.length; i++) {
      if (d.m15All[i].openTime !== ref.m15All[i].openTime) {
        throw new Error(`CORRECTION_REQUIRED: ${sym} M15 grid lech ${REFERENCE_SYMBOLS[0]} tai index ${i} (${d.m15All[i].openTime} vs ${ref.m15All[i].openTime}) — dung lai.`);
      }
    }
    for (let i = 0; i < ref.h1All.length; i++) {
      if (d.h1All[i].openTime !== ref.h1All[i].openTime) {
        throw new Error(`CORRECTION_REQUIRED: ${sym} H1 grid lech ${REFERENCE_SYMBOLS[0]} tai index ${i} (${d.h1All[i].openTime} vs ${ref.h1All[i].openTime}) — dung lai.`);
      }
    }
  }

  const m15Offset = new Map<string, number>();
  const h1Offset = new Map<string, number>();
  for (const sym of REFERENCE_SYMBOLS) {
    m15Offset.set(sym, 0);
    h1Offset.set(sym, 0);
  }

  for (const [sym, data] of allData) {
    if (REFERENCE_SYMBOLS.includes(sym)) continue;
    if (data.m15All.length === 0 || data.h1All.length === 0) {
      throw new Error(`CORRECTION_REQUIRED: ${sym} khong co du lieu — dung lai.`);
    }
    const m15Idx = ref.m15All.findIndex((c) => c.openTime === data.m15All[0].openTime);
    const h1Idx = ref.h1All.findIndex((c) => c.openTime === data.h1All[0].openTime);
    if (m15Idx < 0 || h1Idx < 0) {
      throw new Error(`CORRECTION_REQUIRED: khong tim thay candle dau tien cua ${sym} trong grid tham chieu (M15 idx=${m15Idx}, H1 idx=${h1Idx}) — dung lai, khong gia dinh offset.`);
    }
    if (m15Idx + data.m15All.length !== ref.m15All.length) {
      throw new Error(`CORRECTION_REQUIRED: ${sym} M15 offset=${m15Idx} + length=${data.m15All.length} != grid tham chieu length=${ref.m15All.length} — du lieu khong phai mot doan lien tuc o cuoi grid, dung lai.`);
    }
    if (h1Idx + data.h1All.length !== ref.h1All.length) {
      throw new Error(`CORRECTION_REQUIRED: ${sym} H1 offset=${h1Idx} + length=${data.h1All.length} != grid tham chieu length=${ref.h1All.length} — dung lai.`);
    }
    // Verify every candle inside the offset region matches the reference grid exactly (contiguity,
    // not just endpoints).
    for (let i = 0; i < data.m15All.length; i++) {
      if (data.m15All[i].openTime !== ref.m15All[m15Idx + i].openTime) {
        throw new Error(`CORRECTION_REQUIRED: ${sym} M15 khong khop grid tham chieu tai local index ${i} — dung lai.`);
      }
    }
    for (let i = 0; i < data.h1All.length; i++) {
      if (data.h1All[i].openTime !== ref.h1All[h1Idx + i].openTime) {
        throw new Error(`CORRECTION_REQUIRED: ${sym} H1 khong khop grid tham chieu tai local index ${i} — dung lai.`);
      }
    }
    m15Offset.set(sym, m15Idx);
    h1Offset.set(sym, h1Idx);
  }

  return { m15Offset, h1Offset, referenceM15Length: ref.m15All.length };
}

type Outcome = 'TP' | 'SL';

function directedDelta(direction: Direction, entryPrice: number, exitPrice: number): number {
  return direction === 'LONG' ? exitPrice - entryPrice : entryPrice - exitPrice;
}

interface PendingFvg {
  direction: Direction;
  gapLow: number;
  gapHigh: number;
  invalidationPrice: number;
  waitCount: number;
  breaksKeyZone: boolean;
}
interface OpenTrade {
  id: string;
  direction: Direction;
  entryPrice: number;
  slPrice: number;
  tpPrice: number;
  slDistance: number;
  qty: number;
  notional: number;
  entryTimestampUtc: number;
}
export interface TradeRecord {
  symbol: string;
  entryTimestampUtc: number;
  closeTime: number;
  outcome: Outcome;
  pnl: number;
}
interface SymbolState {
  data: SymbolData;
  m15Offset: number;
  h1Offset: number;
  h1Cursor: number; // local index into data.h1All
  cachedH1CursorForZones: number;
  cachedZones: KeyZone[];
  pending: PendingFvg | null;
  open: OpenTrade | null;
  nextId: number;
  emaTracker: ReturnType<typeof createEmaTracker>;
  atrTracker: ReturnType<typeof createAtrTracker>;
  currentEma: number | null;
  currentAtr: number | null;
}

function runSimulation(allData: Map<string, SymbolData>, grid: GridCheckResult, targetRMultiple: number): TradeRecord[] {
  const states: SymbolState[] = SYMBOLS.map((symbol) => ({
    data: allData.get(symbol)!,
    m15Offset: grid.m15Offset.get(symbol)!,
    h1Offset: grid.h1Offset.get(symbol)!,
    h1Cursor: 0,
    cachedH1CursorForZones: -1,
    cachedZones: [],
    pending: null,
    open: null,
    nextId: 0,
    emaTracker: createEmaTracker(EMA_PERIOD_H1),
    atrTracker: createAtrTracker(ATR_PERIOD),
    currentEma: null,
    currentAtr: null,
  }));

  const referenceM15 = allData.get(REFERENCE_SYMBOLS[0])!.m15All;
  let exposureState: ExposureTrackerState = EMPTY_EXPOSURE_STATE;
  const trades: TradeRecord[] = [];

  for (let i = 2; i < grid.referenceM15Length; i++) {
    const m15CloseTime = referenceM15[i].openTime + M15_MS;

    for (const st of states) {
      const { symbol, m15All, h1All } = st.data;
      const localI = i - st.m15Offset;
      if (localI < 2 || localI >= m15All.length) continue; // not listed yet, or (shouldn't happen) past its data

      while (st.h1Cursor < h1All.length && h1All[st.h1Cursor].openTime + H1_MS <= m15CloseTime) {
        const closePrice = h1All[st.h1Cursor].close;
        st.currentEma = st.emaTracker.next(closePrice);
        st.currentAtr = st.atrTracker.next(h1All[st.h1Cursor]);
        st.h1Cursor++;
      }
      if (st.h1Cursor === 0) continue;

      const h1Window = h1All.slice(0, st.h1Cursor); // still the TRUE full window, passed to checkNoTradeZone as-is
      const m15Window = m15All.slice(0, localI + 1);
      const closePrice = h1Window[h1Window.length - 1].close;
      const candle = m15All[localI];

      const ntz = checkNoTradeZone({
        nowMs: m15CloseTime,
        bid: closePrice,
        ask: closePrice,
        h1Candles: h1Window,
        m15Candles: m15Window,
      });

      if (st.open) {
        const o = st.open;
        const slTouched = o.direction === 'LONG' ? candle.low <= o.slPrice : candle.high >= o.slPrice;
        const tpTouched = o.direction === 'LONG' ? candle.high >= o.tpPrice : candle.low <= o.tpPrice;
        if (slTouched || tpTouched) {
          const outcome: Outcome = slTouched ? 'SL' : 'TP';
          const cost = (o.notional * FEE_PCT_SUM) / 100;
          const exitPrice = outcome === 'TP' ? o.tpPrice : o.slPrice;
          const pnl = o.qty * directedDelta(o.direction, o.entryPrice, exitPrice) - cost;
          trades.push({ symbol, entryTimestampUtc: o.entryTimestampUtc, closeTime: m15CloseTime, outcome, pnl });
          exposureState = closePosition(exposureState, o.id);
          st.open = null;
        }
        continue;
      }

      if (st.pending) {
        st.pending.waitCount++;
        const touchedGap = candle.low <= st.pending.gapHigh && candle.high >= st.pending.gapLow;

        if (touchedGap && !ntz.blocked) {
          const direction = st.pending.direction;
          const entryPrice = direction === 'LONG' ? st.pending.gapLow : st.pending.gapHigh;
          const slPrice = st.pending.invalidationPrice;
          const slDistance = Math.abs(entryPrice - slPrice);

          if (slDistance > 0) {
            const slPct = (slDistance / entryPrice) * 100;
            const tpPrice = direction === 'LONG' ? entryPrice + targetRMultiple * slDistance : entryPrice - targetRMultiple * slDistance;
            const riskUsd = BALANCE * resolveRiskPct(symbol, st.pending.breaksKeyZone);
            const sizing = calculatePositionSize({
              balance: BALANCE,
              riskUsd,
              entryPrice,
              slPrice,
              leverage: LEVERAGE[symbol],
              maxMarginPct: DEFAULT_MAX_MARGIN_PCT,
            });
            if (sizing && slPct >= FLOOR_PCT) {
              const id = `${symbol}-${st.nextId++}`;
              const { result, nextState } = admitPosition(exposureState, DEFAULT_EXPOSURE_TRACKER_CONFIG, BALANCE, {
                id,
                symbol,
                qty: sizing.qty,
                notional: sizing.notional,
                requiredMargin: sizing.requiredMargin,
                actualRiskUsd: sizing.actualRiskUsd,
              });
              exposureState = nextState;
              if (result.admitted) {
                st.open = { id, direction, entryPrice, slPrice, tpPrice, slDistance, qty: result.qty, notional: result.notional, entryTimestampUtc: candle.openTime };
              }
            }
          }
          st.pending = null;
        } else if (st.pending.waitCount >= MAX_WAIT_CANDLES) {
          st.pending = null;
        }
      }

      if (st.open) continue;
      if (ntz.blocked) continue;
      if (st.pending) continue;
      if (st.currentEma === null) continue; // not enough H1 history yet for EMA200 — mirrors classifyTrendH1() returning null

      const trendDirection: Direction = closePrice >= st.currentEma ? 'LONG' : 'SHORT';

      const fvg = detectFvg(m15All[localI - 2], m15All[localI - 1], m15All[localI], { minCandle2BodyRatio: MIN_CANDLE2_BODY_RATIO });
      if (fvg.isFvg && fvg.direction === trendDirection && fvg.gapLow !== undefined && fvg.gapHigh !== undefined && fvg.invalidationPrice !== undefined) {
        if (st.h1Cursor !== st.cachedH1CursorForZones) {
          st.cachedH1CursorForZones = st.h1Cursor;
          const atrH1 = st.currentAtr ?? 0;
          st.cachedZones = atrH1 > 0 ? findKeyZones(h1Window, atrH1, FVG_KEY_ZONE_CONFIG) : [];
        }
        const gapLow = fvg.gapLow;
        const gapHigh = fvg.gapHigh;
        const breaksKeyZone = st.cachedZones.some((z) => z.price >= gapLow && z.price <= gapHigh);
        st.pending = { direction: fvg.direction, gapLow: fvg.gapLow, gapHigh: fvg.gapHigh, invalidationPrice: fvg.invalidationPrice, waitCount: 0, breaksKeyZone };
      }
    }
  }

  return trades;
}

function summarize(trades: TradeRecord[]) {
  let pnl = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  let wins = 0;
  for (const t of trades) {
    pnl += t.pnl;
    if (t.pnl > 0) {
      grossProfit += t.pnl;
      wins++;
    } else if (t.pnl < 0) grossLoss += Math.abs(t.pnl);
  }
  const pf = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
  const winRate = trades.length > 0 ? (wins / trades.length) * 100 : 0;
  return { n: trades.length, pnl, pf, winRate };
}
function maxDrawdownPct(trades: TradeRecord[], startCapital: number): number {
  let equity = startCapital;
  let peak = startCapital;
  let maxDd = 0;
  for (const t of trades) {
    equity += t.pnl;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDd) maxDd = dd;
  }
  return (maxDd / startCapital) * 100;
}

async function main() {
  const dataDir = path.resolve(process.cwd(), 'apps/bot/data');
  const reportPath = path.resolve(process.cwd(), 'apps/bot/reports/RT-065-report.md');
  const targetR = DEFAULT_FVG_STRATEGY_CONFIG.targetRMultiple;

  console.log('=== Self-check: chay lai tren du lieu 1 nam hien co (khong doi), doi chieu RT-056/057 ===');
  const data1y = await loadAllSymbolData(dataDir, '1y');
  const grid1y = checkGridsAlignExactly(data1y);
  console.log(`Grid 1y: reference length=${grid1y.referenceM15Length}. Offset moi symbol: ${SYMBOLS.map((s) => `${s}=${grid1y.m15Offset.get(s)}`).join(', ')}`);
  const trades1y = runSimulation(data1y, grid1y, targetR);
  const s1y = summarize(trades1y);
  const dd1y = maxDrawdownPct(trades1y, 10000);
  console.log(`Ket qua 1y (script moi): n=${s1y.n}  PnL=$${s1y.pnl.toFixed(2)}  PF=${s1y.pf.toFixed(3)}  maxDD=${dd1y.toFixed(2)}%`);
  console.log('Doi chieu RT-056/057 Config B (chot): n=1217, PnL=$2628.76, PF=1.551, maxDD=1.24%');
  const matches = s1y.n === 1217 && Math.abs(s1y.pnl - 2628.76) < 0.01 && Math.abs(s1y.pf - 1.551) < 0.001 && Math.abs(dd1y - 1.24) < 0.01;
  if (!matches) {
    console.error('\nCORRECTION_REQUIRED: script moi (incremental EMA/ATR + offset-aware loop) KHONG tai tao dung RT-056/057 tren du lieu 1 nam — DUNG lai, KHONG chay tren du lieu 3 nam.');
    process.exitCode = 1;
    return;
  }
  console.log('-> KHOP 100%: incremental EMA/ATR substitution + offset-aware loop xac nhan tuong duong thiet ke goc. An toan de chay tren du lieu 3 nam.\n');

  console.log('=== Phan C: chay tren du lieu 3 nam ===');
  const data3y = await loadAllSymbolData(dataDir, '3y');
  const grid3y = checkGridsAlignExactly(data3y);
  console.log(`Grid 3y: reference length=${grid3y.referenceM15Length}. Offset moi symbol: ${SYMBOLS.map((s) => `${s}=${grid3y.m15Offset.get(s)}`).join(', ')}`);
  const startTime = Date.now();
  const trades3y = runSimulation(data3y, grid3y, targetR);
  console.log(`Chay xong trong ${((Date.now() - startTime) / 1000).toFixed(1)}s.`);

  const overall = summarize(trades3y);
  const overallDd = maxDrawdownPct(trades3y, 10000);
  console.log(`\nTong the 3 nam: n=${overall.n}  PnL=$${overall.pnl.toFixed(2)}  PF=${overall.pf.toFixed(3)}  winRate=${overall.winRate.toFixed(1)}%  maxDD=${overallDd.toFixed(2)}%`);

  const byYear = new Map<number, TradeRecord[]>();
  for (const t of trades3y) {
    const y = new Date(t.entryTimestampUtc).getUTCFullYear();
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y)!.push(t);
  }
  const years = Array.from(byYear.keys()).sort();
  for (const y of years) {
    const trades = byYear.get(y)!;
    const s = summarize(trades);
    const dd = maxDrawdownPct(trades, 10000);
    console.log(`  ${y}: n=${s.n}  PnL=$${s.pnl.toFixed(2)}  PF=${s.pf.toFixed(3)}  winRate=${s.winRate.toFixed(1)}%  maxDD=${dd.toFixed(2)}%`);
  }

  // Per-symbol breakdown too, since HYPE only covers part of the 3-year window.
  const bySymbol = new Map<string, TradeRecord[]>();
  for (const t of trades3y) {
    if (!bySymbol.has(t.symbol)) bySymbol.set(t.symbol, []);
    bySymbol.get(t.symbol)!.push(t);
  }

  let md = '# TICKET-RT-065 Part C — Xac nhan lai chien luoc goc tren du lieu 3 nam\n\n';
  md += 'Audit-only. Khong dung production, khong doi entry/risk logic (chi chay lai backtest, dung dung cac ham production khong sua).\n\n';
  md += `Tu-kiem-tra: script nay chay lai tren du lieu 1 nam HIEN CO (khong doi) truoc, khop 100% RT-056/057 (n=${s1y.n}, PnL=$${s1y.pnl.toFixed(2)}, PF=${s1y.pf.toFixed(3)}, maxDD=${dd1y.toFixed(2)}%) — xac nhan incremental EMA/ATR (RT-065 Part B) va thiet ke vong lap co-offset-cho-HYPE (RT-065 Part A) tuong duong 100% voi thiet ke backtest goc truoc khi tin dung ket qua 3 nam.\n\n`;
  md += `Du lieu: apps/bot/data/*_3y.csv (RT-065 Part A) — BTC/ETH/SOL/XRP: 3 nam day du (2023-08-27 den 2026-08-26); HYPE: tu ngay list (2025-05-30) den nay (~453 ngay), duoc xac nhan la mot doan lien tuc, khong gap, cua CUNG grid voi 4 coin kia (xem checkGridsAlignExactly trong code).\n\n`;
  md += `## Tong the 3 nam\n\n`;
  md += `| n | PnL$ | PF | Winrate | Max DD |\n|---|---|---|---|---|\n`;
  md += `| ${overall.n} | $${overall.pnl.toFixed(2)} | ${Number.isFinite(overall.pf) ? overall.pf.toFixed(3) : 'inf'} | ${overall.winRate.toFixed(1)}% | ${overallDd.toFixed(2)}% |\n\n`;

  md += `## Theo tung nam (khong gop)\n\n`;
  md += `| Nam | n | PnL$ | PF | Winrate | Max DD |\n|---|---|---|---|---|---|\n`;
  for (const y of years) {
    const trades = byYear.get(y)!;
    const s = summarize(trades);
    const dd = maxDrawdownPct(trades, 10000);
    md += `| ${y} | ${s.n} | $${s.pnl.toFixed(2)} | ${Number.isFinite(s.pf) ? s.pf.toFixed(3) : 'inf'} | ${s.winRate.toFixed(1)}% | ${dd.toFixed(2)}% |\n`;
  }
  md += `\n_(2023 va 2026 la nam khong day du — 2023 chi tu 27/8, 2026 chi den 26/8. Xem con so nhu mot phan nam, khong so sanh truc tiep voi cac nam day du.)_\n\n`;

  md += `## Theo tung coin (3 nam, hoac toan bo lich su neu ngan hon — HYPE)\n\n`;
  md += `| Coin | n | PnL$ | PF | Winrate |\n|---|---|---|---|---|\n`;
  for (const symbol of SYMBOLS) {
    const trades = bySymbol.get(symbol) ?? [];
    const s = summarize(trades);
    md += `| ${symbol} | ${s.n} | $${s.pnl.toFixed(2)} | ${Number.isFinite(s.pf) ? s.pf.toFixed(3) : 'inf'} | ${s.winRate.toFixed(1)}% |\n`;
  }
  md += '\n_(So lieu tho — bao cao PF/winrate/maxDD/PnL theo nam va theo coin, khong tu ket luan chien luoc "on dinh" hay "khong on dinh" qua cac giai doan.)_\n';

  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, md, 'utf8');
  console.log(`\nDa ghi bao cao vao ${reportPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
