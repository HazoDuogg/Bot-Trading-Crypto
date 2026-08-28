import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { checkNoTradeZone } from '../../src/noTradeZone/noTradeZone.js';
import type { Candle } from '../../src/noTradeZone/types.js';
import { createEmaTracker } from '../../src/regime/ema.js';
import { createAtrTracker } from '../../src/noTradeZone/atr.js';
import { detectFvg, DEFAULT_FVG_CONFIG } from '../../src/entry/fvg.js';
import { DEFAULT_FVG_STRATEGY_CONFIG } from '../../src/entry/fvgStrategyConfig.js';
import type { Direction } from '../../src/entry/types.js';
import { calculatePositionSize } from '../../src/positionSizing/positionSizing.js';
import { DEFAULT_MAX_MARGIN_PCT } from '../../src/positionSizing/types.js';
import { findKeyZones } from '../../src/zones/keyZones.js';
import type { KeyZone } from '../../src/zones/keyZones.js';
import { DEFAULT_REGIME_CONFIG } from '../../src/regime/types.js';
import { resolveRiskPct } from '../../src/positionSizing/riskConfig.js';
import {
  admitPosition,
  closePosition,
  EMPTY_EXPOSURE_STATE,
  DEFAULT_EXPOSURE_TRACKER_CONFIG,
  type ExposureTrackerState,
} from '../../src/positionSizing/exposureTracker.js';

// TICKET-RT-DOGE-001 Buoc 2: xac nhan chien luoc goc (FVG H1+M15 entry, targetR=2.10, risk qua
// resolveRiskPct — KHONG doi entry/risk logic) tren lineup 5 coin MOI: BTC/ETH/SOL/HYPE/DOGE
// (XRPUSDT -> DOGEUSDT), dung du lieu 3 nam (Buoc 1: DOGEUSDT co day du ~1095 ngay, 0 gap, cung
// so nen H1/M15 voi BTC/ETH/SOL — xac nhan boi fetchOhlcvThreeYear.ts).
//
// Day la BAN SAO co dieu chinh cua scripts/research/rt065ThreeYearBacktest.ts (RT-065 Part C),
// KHONG sua file goc do (giu nguyen bang chung lich su RT-065). Toan bo ham entry/risk/sizing van
// la production code khong sua (detectFvg, checkNoTradeZone, calculatePositionSize,
// admitPosition/closePosition, resolveRiskPct, findKeyZones).
//
// Tu-kiem-tra (giong RT-065): chay lai script nay tren BO 5 COIN GOC (voi XRPUSDT, du lieu 1y
// KHONG doi) truoc, doi chieu dung RT-056/057 Config B (n=1217, PnL=$2628.76, PF=1.551,
// maxDD=1.24%) de xac nhan logic mo phong/sizing khong bi doi khi refactor thanh ham nhan tham so
// (symbols/referenceSymbols/leverage) o file nay. Neu khop, moi chay tiep tren bo 5 coin DOGE.
//
// GIA DINH CAN XAC NHAN (TODO_CONFIRM): DOGEUSDT leverage dung tam 10x — GIONG leverage XRPUSDT cu
// (khong co gia tri DOGE rieng trong bat ky ticket truoc). Day la gia dinh, khong phai so da xac
// nhan — neu Vinh Tam muon leverage DOGE khac, ket qua Buoc 2 duoi day se doi.

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

const ORIGINAL_LEVERAGE: Record<string, number> = {
  BTCUSDT: 20,
  ETHUSDT: 20,
  SOLUSDT: 10,
  HYPEUSDT: 10,
  XRPUSDT: 10,
};
const ORIGINAL_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'HYPEUSDT', 'XRPUSDT'];
const ORIGINAL_REFERENCE_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'];

const DOGE_LEVERAGE: Record<string, number> = {
  BTCUSDT: 20,
  ETHUSDT: 20,
  SOLUSDT: 10,
  HYPEUSDT: 10,
  DOGEUSDT: 10, // TODO_CONFIRM — see header note
};
const DOGE_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'HYPEUSDT', 'DOGEUSDT'];
const DOGE_REFERENCE_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'DOGEUSDT'];

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

async function loadAllSymbolData(dataDir: string, suffix: string, symbols: string[]): Promise<Map<string, SymbolData>> {
  const out = new Map<string, SymbolData>();
  for (const symbol of symbols) {
    const m15All = await readCsv(path.join(dataDir, `${symbol}_15m_${suffix}.csv`));
    const h1All = await readCsv(path.join(dataDir, `${symbol}_1h_${suffix}.csv`));
    out.set(symbol, { symbol, m15All, h1All });
  }
  return out;
}

interface GridCheckResult {
  m15Offset: Map<string, number>;
  h1Offset: Map<string, number>;
  referenceM15Length: number;
}

function checkGridsAlignExactly(allData: Map<string, SymbolData>, referenceSymbols: string[]): GridCheckResult {
  const ref = allData.get(referenceSymbols[0])!;
  for (const sym of referenceSymbols.slice(1)) {
    const d = allData.get(sym)!;
    if (d.m15All.length !== ref.m15All.length || d.h1All.length !== ref.h1All.length) {
      throw new Error(`CORRECTION_REQUIRED: ${sym} co do dai grid khac ${referenceSymbols[0]} (M15: ${d.m15All.length} vs ${ref.m15All.length}, H1: ${d.h1All.length} vs ${ref.h1All.length}) — dung lai.`);
    }
    for (let i = 0; i < ref.m15All.length; i++) {
      if (d.m15All[i].openTime !== ref.m15All[i].openTime) {
        throw new Error(`CORRECTION_REQUIRED: ${sym} M15 grid lech ${referenceSymbols[0]} tai index ${i} — dung lai.`);
      }
    }
    for (let i = 0; i < ref.h1All.length; i++) {
      if (d.h1All[i].openTime !== ref.h1All[i].openTime) {
        throw new Error(`CORRECTION_REQUIRED: ${sym} H1 grid lech ${referenceSymbols[0]} tai index ${i} — dung lai.`);
      }
    }
  }

  const m15Offset = new Map<string, number>();
  const h1Offset = new Map<string, number>();
  for (const sym of referenceSymbols) {
    m15Offset.set(sym, 0);
    h1Offset.set(sym, 0);
  }

  for (const [sym, data] of allData) {
    if (referenceSymbols.includes(sym)) continue;
    if (data.m15All.length === 0 || data.h1All.length === 0) {
      throw new Error(`CORRECTION_REQUIRED: ${sym} khong co du lieu — dung lai.`);
    }
    const m15Idx = ref.m15All.findIndex((c) => c.openTime === data.m15All[0].openTime);
    const h1Idx = ref.h1All.findIndex((c) => c.openTime === data.h1All[0].openTime);
    if (m15Idx < 0 || h1Idx < 0) {
      throw new Error(`CORRECTION_REQUIRED: khong tim thay candle dau tien cua ${sym} trong grid tham chieu — dung lai.`);
    }
    if (m15Idx + data.m15All.length !== ref.m15All.length) {
      throw new Error(`CORRECTION_REQUIRED: ${sym} M15 offset+length != grid tham chieu length — dung lai.`);
    }
    if (h1Idx + data.h1All.length !== ref.h1All.length) {
      throw new Error(`CORRECTION_REQUIRED: ${sym} H1 offset+length != grid tham chieu length — dung lai.`);
    }
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
  h1Cursor: number;
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

function runSimulation(
  allData: Map<string, SymbolData>,
  grid: GridCheckResult,
  targetRMultiple: number,
  symbols: string[],
  referenceSymbols: string[],
  leverage: Record<string, number>,
): TradeRecord[] {
  const states: SymbolState[] = symbols.map((symbol) => ({
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

  const referenceM15 = allData.get(referenceSymbols[0])!.m15All;
  let exposureState: ExposureTrackerState = EMPTY_EXPOSURE_STATE;
  const trades: TradeRecord[] = [];

  for (let i = 2; i < grid.referenceM15Length; i++) {
    const m15CloseTime = referenceM15[i].openTime + M15_MS;

    for (const st of states) {
      const { symbol, m15All, h1All } = st.data;
      const localI = i - st.m15Offset;
      if (localI < 2 || localI >= m15All.length) continue;

      while (st.h1Cursor < h1All.length && h1All[st.h1Cursor].openTime + H1_MS <= m15CloseTime) {
        const closePrice = h1All[st.h1Cursor].close;
        st.currentEma = st.emaTracker.next(closePrice);
        st.currentAtr = st.atrTracker.next(h1All[st.h1Cursor]);
        st.h1Cursor++;
      }
      if (st.h1Cursor === 0) continue;

      const h1Window = h1All.slice(0, st.h1Cursor);
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
              leverage: leverage[symbol],
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
      if (st.currentEma === null) continue;

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
  const reportPath = path.resolve(process.cwd(), 'apps/bot/reports/RT-DOGE-001-report.md');
  const targetR = DEFAULT_FVG_STRATEGY_CONFIG.targetRMultiple;

  console.log('=== Tu-kiem-tra: chay lai tren bo 5 coin GOC (voi XRPUSDT, du lieu 1 nam khong doi), doi chieu RT-056/057 ===');
  const data1y = await loadAllSymbolData(dataDir, '1y', ORIGINAL_SYMBOLS);
  const grid1y = checkGridsAlignExactly(data1y, ORIGINAL_REFERENCE_SYMBOLS);
  const trades1y = runSimulation(data1y, grid1y, targetR, ORIGINAL_SYMBOLS, ORIGINAL_REFERENCE_SYMBOLS, ORIGINAL_LEVERAGE);
  const s1y = summarize(trades1y);
  const dd1y = maxDrawdownPct(trades1y, 10000);
  console.log(`Ket qua 1y (script nay, bo coin GOC): n=${s1y.n}  PnL=$${s1y.pnl.toFixed(2)}  PF=${s1y.pf.toFixed(3)}  maxDD=${dd1y.toFixed(2)}%`);
  console.log('Doi chieu RT-056/057 Config B (chot): n=1217, PnL=$2628.76, PF=1.551, maxDD=1.24%');
  const matches = s1y.n === 1217 && Math.abs(s1y.pnl - 2628.76) < 0.01 && Math.abs(s1y.pf - 1.551) < 0.001 && Math.abs(dd1y - 1.24) < 0.01;
  if (!matches) {
    console.error('\nCORRECTION_REQUIRED: script nay (refactor thanh ham nhan tham so) KHONG tai tao dung RT-056/057 — DUNG lai, KHONG chay tren du lieu DOGE.');
    process.exitCode = 1;
    return;
  }
  console.log('-> KHOP 100%: refactor thanh ham nhan tham so khong doi hanh vi. An toan de chay tren lineup DOGE.\n');

  console.log('=== Buoc 2: chay tren lineup MOI BTC/ETH/SOL/HYPE/DOGE, du lieu 3 nam ===');
  const dataDoge = await loadAllSymbolData(dataDir, '3y', DOGE_SYMBOLS);
  const gridDoge = checkGridsAlignExactly(dataDoge, DOGE_REFERENCE_SYMBOLS);
  console.log(`Grid 3y (DOGE lineup): reference length=${gridDoge.referenceM15Length}. Offset moi symbol: ${DOGE_SYMBOLS.map((s) => `${s}=${gridDoge.m15Offset.get(s)}`).join(', ')}`);
  const startTime = Date.now();
  const tradesDoge = runSimulation(dataDoge, gridDoge, targetR, DOGE_SYMBOLS, DOGE_REFERENCE_SYMBOLS, DOGE_LEVERAGE);
  console.log(`Chay xong trong ${((Date.now() - startTime) / 1000).toFixed(1)}s.`);

  const overall = summarize(tradesDoge);
  const overallDd = maxDrawdownPct(tradesDoge, 10000);
  console.log(`\nTong the (BTC/ETH/SOL/HYPE/DOGE, 3 nam): n=${overall.n}  PnL=$${overall.pnl.toFixed(2)}  PF=${overall.pf.toFixed(3)}  winRate=${overall.winRate.toFixed(1)}%  maxDD=${overallDd.toFixed(2)}%`);

  const bySymbol = new Map<string, TradeRecord[]>();
  for (const t of tradesDoge) {
    if (!bySymbol.has(t.symbol)) bySymbol.set(t.symbol, []);
    bySymbol.get(t.symbol)!.push(t);
  }

  let md = '# TICKET-RT-DOGE-001 Buoc 1+2 — DOGEUSDT thay XRPUSDT, backtest 5-coin lineup moi\n\n';
  md += 'Audit-only. Khong dung production, khong doi entry/risk logic (chi chay lai backtest, dung dung cac ham production khong sua).\n\n';
  md += `Tu-kiem-tra: script nay chay lai tren bo 5 coin GOC (voi XRPUSDT) tren du lieu 1 nam HIEN CO (khong doi) truoc, khop 100% RT-056/057 (n=${s1y.n}, PnL=$${s1y.pnl.toFixed(2)}, PF=${s1y.pf.toFixed(3)}, maxDD=${dd1y.toFixed(2)}%) — xac nhan viec refactor thanh ham nhan tham so khong lam thay doi hanh vi mo phong truoc khi tin dung ket qua DOGE.\n\n`;
  md += `Du lieu: apps/bot/data/*_3y.csv, fetch lai ${new Date().toISOString()} (fetchOhlcvThreeYear.ts, XRPUSDT -> DOGEUSDT). BTC/ETH/SOL/DOGE: day du 3 nam (2023-08-28 den 2026-08-27, 26279 nen H1 / 105119 nen M15 moi coin, 0 gap); HYPE: tu ngay list (2025-05-30) den nay (~454 ngay), la mot doan lien tuc khong gap cua CUNG grid.\n\n`;
  md += `**GIA DINH CAN XAC NHAN (TODO_CONFIRM):** DOGEUSDT leverage dung tam 10x, lay theo leverage XRPUSDT cu — chua co gia tri DOGE rieng duoc xac nhan. Neu Vinh Tam muon gia tri khac, ket qua duoi day se doi va can chay lai.\n\n`;
  md += `## Tong the (3 nam, BTC/ETH/SOL/HYPE/DOGE)\n\n`;
  md += `| n | PnL$ | PF | Winrate | Max DD |\n|---|---|---|---|---|\n`;
  md += `| ${overall.n} | $${overall.pnl.toFixed(2)} | ${Number.isFinite(overall.pf) ? overall.pf.toFixed(3) : 'inf'} | ${overall.winRate.toFixed(1)}% | ${overallDd.toFixed(2)}% |\n\n`;

  md += `## Theo tung coin\n\n`;
  md += `| Coin | n | PnL$ | PF | Winrate | Max DD |\n|---|---|---|---|---|---|\n`;
  for (const symbol of DOGE_SYMBOLS) {
    const trades = bySymbol.get(symbol) ?? [];
    const s = summarize(trades);
    const dd = maxDrawdownPct(trades, 10000);
    md += `| ${symbol} | ${s.n} | $${s.pnl.toFixed(2)} | ${Number.isFinite(s.pf) ? s.pf.toFixed(3) : 'inf'} | ${s.winRate.toFixed(1)}% | ${dd.toFixed(2)}% |\n`;
  }
  md += '\n_(So lieu tho — bao cao PF/winrate/maxDD/PnL tong the va theo coin, khong tu ket luan.)_\n';

  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, md, 'utf8');
  console.log(`\nDa ghi bao cao vao ${reportPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
