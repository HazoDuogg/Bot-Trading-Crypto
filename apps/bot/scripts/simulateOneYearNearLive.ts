import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkNoTradeZone } from '../src/noTradeZone/noTradeZone.js';
import type { Candle } from '../src/noTradeZone/types.js';
import { classifyTrendH1 } from '../src/trend/trendH1.js';
import { detectFvg, DEFAULT_FVG_CONFIG } from '../src/entry/fvg.js';
import { DEFAULT_FVG_STRATEGY_CONFIG } from '../src/entry/fvgStrategyConfig.js';
import type { Direction } from '../src/entry/types.js';
import { calculatePositionSize } from '../src/positionSizing/positionSizing.js';
import { DEFAULT_MAX_MARGIN_PCT } from '../src/positionSizing/types.js';
import { computeAtr } from '../src/noTradeZone/atr.js';
import { findKeyZones } from '../src/zones/keyZones.js';
import type { KeyZone } from '../src/zones/keyZones.js';
import { DEFAULT_REGIME_CONFIG } from '../src/regime/types.js';
import {
  admitPosition,
  closePosition,
  EMPTY_EXPOSURE_STATE,
  DEFAULT_EXPOSURE_TRACKER_CONFIG,
  type ExposureTrackerState,
} from '../src/positionSizing/exposureTracker.js';

// TICKET-RT-051: near-live backtest on 1 year of real OHLCV data, respecting the checkpoints Vinh
// Tam confirmed:
//   1. HARD 1-open-trade-per-coin limit: a fresh FVG is never even looked for while that symbol has
//      an open (filled, not yet closed) position — see SymbolState.open below; detection is skipped
//      entirely for that symbol until it closes.
//   2. Isolated margin: each position's margin/qty is sized independently via calculatePositionSize()
//      (Buoc 5a, unmodified) — no cross-margining, no pooling of PnL across positions. Confirmed by
//      inspection: qty/notional/margin depend only on that trade's own entryPrice/slPrice/leverage.
//   3. One-way mode: automatic consequence of checkpoint 1 — a symbol can never have two positions
//      open at once (long+short or otherwise), since ANY open position blocks new detection.
//   4. Portfolio Exposure Tracker (src/positionSizing/exposureTracker.ts) IS reused here — every
//      fill is routed through admitPosition()/closePosition() against ONE shared
//      ExposureTrackerState across all 5 coins (DEFAULT_EXPOSURE_TRACKER_CONFIG, 70% margin cap of
//      ONE shared $500 balance) — unlike every RT-032..RT-050 script, which called only the bare
//      calculatePositionSize() with an implicit unlimited-relative-to-other-coins balance per coin.
//      Confirmed by grep: no RT-032..050 script references admitPosition/exposureTracker at all.
//   5. Chronological across all 5 coins simultaneously: verified all 5 symbols share IDENTICAL M15/H1
//      timestamp grids for this dataset (checked programmatically before writing this script), so a
//      single shared index loop (0..N-1) processes all 5 symbols at each global M15 timestep, in a
//      fixed order (BTC,ETH,SOL,HYPE,XRP) — not 5 independent per-symbol passes like every prior
//      script. This is what makes the shared exposure tracker meaningful (margin used by one coin's
//      open position genuinely reduces headroom available to another coin at the same real time).
//   6. No look-ahead: h1Cursor only advances while h1All[h1Cursor].openTime + H1_MS <= m15CloseTime
//      (only CLOSED H1 candles ever enter h1Window — mirrors strategy1MeasureFvg.ts L168-170
//      verbatim), m15Window/detectFvg only ever touch candle indices <= the current, already-closed
//      M15 index i (mirrors L172-173, L238) — reproduced identically below.
//
// Entry/exit rules (detectFvg, checkNoTradeZone, classifyTrendH1, calculatePositionSize, findKeyZones,
// FEE_PCT_SUM, targetRMultiple) are otherwise IDENTICAL to every RT-032..050 script — fvg.ts/
// fvgStrategyConfig.ts untouched, current production values read as-is.

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

export const FEE_PCT_SUM = 0.05 + 0.05 + 0.05 + 0.05; // same constant as every sibling script since RT-027

export const BALANCE = 500; // ONE shared portfolio balance across all 5 coins (not 5x$500 as before)
export const RISK_PCT = 0.01;
const LEVERAGE: Record<string, number> = {
  BTCUSDT: 20,
  ETHUSDT: 20,
  SOLUSDT: 10,
  HYPEUSDT: 10,
  XRPUSDT: 10,
};
export const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'HYPEUSDT', 'XRPUSDT'];

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

export interface SymbolData {
  symbol: string;
  m15All: Candle[];
  h1All: Candle[];
}

export async function loadAllSymbolData(dataDir: string): Promise<SymbolData[]> {
  const out: SymbolData[] = [];
  for (const symbol of SYMBOLS) {
    const m15All = await readCsv(path.join(dataDir, `${symbol}_15m_1y.csv`));
    const h1All = await readCsv(path.join(dataDir, `${symbol}_1h_1y.csv`));
    out.push({ symbol, m15All, h1All });
  }
  return out;
}

type Outcome = 'TP' | 'SL' | 'STILL_OPEN';

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
  entryIndex: number;
  entryPrice: number;
  slPrice: number;
  tpPrice: number;
  slDistance: number;
  qty: number;
  notional: number;
  breaksKeyZone: boolean;
  scaledDown: boolean;
}

export interface ClosedTrade {
  symbol: string;
  direction: Direction;
  entryIndex: number;
  entryPrice: number;
  slPrice: number;
  tpPrice: number;
  slDistance: number;
  qty: number;
  notional: number;
  outcome: Outcome;
  slPct: number;
  breaksKeyZone: boolean;
  scaledDown: boolean;
  closeTime: number; // openTime + M15_MS of the candle where SL/TP touched — TICKET-RT-056
}

interface SymbolState {
  data: SymbolData;
  h1Cursor: number;
  cachedH1CursorForZones: number;
  cachedZones: KeyZone[];
  pending: PendingFvg | null;
  open: OpenTrade | null;
  nextId: number;
}

export function directedDelta(direction: Direction, entryPrice: number, exitPrice: number): number {
  return direction === 'LONG' ? exitPrice - entryPrice : entryPrice - exitPrice;
}

export function computeClosedPnl(t: ClosedTrade): number {
  if (t.outcome === 'STILL_OPEN') return 0;
  const cost = (t.notional * FEE_PCT_SUM) / 100;
  const exitPrice = t.outcome === 'TP' ? t.tpPrice : t.slPrice;
  return t.qty * directedDelta(t.direction, t.entryPrice, exitPrice) - cost;
}

// riskPctResolver (TICKET-RT-056): optional per-trade risk-% override, defaulting to the fixed
// RISK_PCT (1%) every prior ticket used — passing it changes ONLY the sizing input into
// calculatePositionSize()/admitPosition(), not any entry/exit/detection logic.
export function runSimulation(
  allData: SymbolData[],
  targetRMultiple: number,
  riskPctResolver: (symbol: string, breaksKeyZone: boolean) => number = () => RISK_PCT,
): { closedTrades: ClosedTrade[]; rejectedByExposure: number; scaledDownCount: number } {
  const states: SymbolState[] = allData.map((data) => ({
    data,
    h1Cursor: 0,
    cachedH1CursorForZones: -1,
    cachedZones: [],
    pending: null,
    open: null,
    nextId: 0,
  }));

  const nCandles = states[0].data.m15All.length;
  let exposureState: ExposureTrackerState = EMPTY_EXPOSURE_STATE;
  const closedTrades: ClosedTrade[] = [];
  let rejectedByExposure = 0;
  let scaledDownCount = 0;

  for (let i = 2; i < nCandles; i++) {
    for (const st of states) {
      const { symbol, m15All, h1All } = st.data;
      const m15CloseTime = m15All[i].openTime + M15_MS;
      // checkpoint 6 (no look-ahead): only CLOSED H1 candles ever enter h1Window.
      while (st.h1Cursor < h1All.length && h1All[st.h1Cursor].openTime + H1_MS <= m15CloseTime) st.h1Cursor++;
      if (st.h1Cursor === 0) continue;

      const h1Window = h1All.slice(0, st.h1Cursor);
      const m15Window = m15All.slice(0, i + 1); // checkpoint 6: only candles <= current, already-closed index i
      const closePrice = h1Window[h1Window.length - 1].close;
      const candle = m15All[i];

      const ntz = checkNoTradeZone({
        nowMs: m15CloseTime,
        bid: closePrice,
        ask: closePrice,
        h1Candles: h1Window,
        m15Candles: m15Window,
      });

      // --- 1) if this symbol has an OPEN position, only check for its own TP/SL — no new detection
      //        at all while a position is open (checkpoint 1). ---
      if (st.open) {
        const o = st.open;
        const slTouched = o.direction === 'LONG' ? candle.low <= o.slPrice : candle.high >= o.slPrice;
        const tpTouched = o.direction === 'LONG' ? candle.high >= o.tpPrice : candle.low <= o.tpPrice;
        if (slTouched || tpTouched) {
          const outcome: Outcome = slTouched ? 'SL' : 'TP';
          closedTrades.push({
            symbol,
            direction: o.direction,
            entryIndex: o.entryIndex,
            entryPrice: o.entryPrice,
            slPrice: o.slPrice,
            tpPrice: o.tpPrice,
            slDistance: o.slDistance,
            qty: o.qty,
            notional: o.notional,
            outcome,
            slPct: (o.slDistance / o.entryPrice) * 100,
            breaksKeyZone: o.breaksKeyZone,
            scaledDown: o.scaledDown,
            closeTime: m15CloseTime,
          });
          exposureState = closePosition(exposureState, o.id);
          st.open = null;
        }
        continue; // no detection/fill logic for this symbol this candle — position occupies the slot
      }

      // --- 2) advance a pending (unfilled) FVG wait ---
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
            const riskUsd = BALANCE * riskPctResolver(symbol, st.pending.breaksKeyZone);
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
                if (result.scaledDown) scaledDownCount++;
                st.open = {
                  id,
                  direction,
                  entryIndex: i,
                  entryPrice,
                  slPrice,
                  tpPrice,
                  slDistance,
                  qty: result.qty,
                  notional: result.notional,
                  breaksKeyZone: st.pending.breaksKeyZone,
                  scaledDown: result.scaledDown,
                };
              } else {
                rejectedByExposure++;
              }
            }
          }
          st.pending = null;
        } else if (st.pending.waitCount >= MAX_WAIT_CANDLES) {
          st.pending = null;
        }
      }

      if (st.open) continue; // just got filled this candle — skip fresh detection until next candle
      if (ntz.blocked) continue;

      // --- 3) detect a fresh FVG (only when no open position and nothing already pending) ---
      if (st.pending) continue;

      const trend = classifyTrendH1(h1Window, EMA_PERIOD_H1);
      if (trend === null) continue;
      const trendDirection: Direction = trend === 'UPTREND' ? 'LONG' : 'SHORT';

      const fvg = detectFvg(m15All[i - 2], m15All[i - 1], m15All[i], { minCandle2BodyRatio: MIN_CANDLE2_BODY_RATIO });
      if (fvg.isFvg && fvg.direction === trendDirection && fvg.gapLow !== undefined && fvg.gapHigh !== undefined && fvg.invalidationPrice !== undefined) {
        if (st.h1Cursor !== st.cachedH1CursorForZones) {
          st.cachedH1CursorForZones = st.h1Cursor;
          const atrH1Values = computeAtr(h1Window, ATR_PERIOD);
          const atrH1 = atrH1Values.length > 0 ? atrH1Values[atrH1Values.length - 1] : 0;
          st.cachedZones = atrH1 > 0 ? findKeyZones(h1Window, atrH1, FVG_KEY_ZONE_CONFIG) : [];
        }
        const gapLow = fvg.gapLow;
        const gapHigh = fvg.gapHigh;
        const breaksKeyZone = st.cachedZones.some((z) => z.price >= gapLow && z.price <= gapHigh);

        st.pending = {
          direction: fvg.direction,
          gapLow: fvg.gapLow,
          gapHigh: fvg.gapHigh,
          invalidationPrice: fvg.invalidationPrice,
          waitCount: 0,
          breaksKeyZone,
        };
      }
    }
  }

  return { closedTrades, rejectedByExposure, scaledDownCount };
}

export interface Summary {
  n: number;
  tp: number;
  sl: number;
  pnl: number;
  winRate: number;
  profitFactor: number;
}

export function summarize(trades: ClosedTrade[]): Summary {
  const tp = trades.filter((t) => t.outcome === 'TP').length;
  const sl = trades.filter((t) => t.outcome === 'SL').length;
  let pnl = 0;
  let wins = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  for (const t of trades) {
    const p = computeClosedPnl(t);
    pnl += p;
    if (p > 0) {
      wins++;
      grossProfit += p;
    } else if (p < 0) {
      grossLoss += Math.abs(p);
    }
  }
  const winRate = trades.length > 0 ? (wins / trades.length) * 100 : 0;
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
  return { n: trades.length, tp, sl, pnl, winRate, profitFactor };
}

function printRow(label: string, s: Summary): void {
  console.log(
    label.padEnd(16) +
      String(s.n).padEnd(6) +
      `$${s.pnl.toFixed(2)}`.padEnd(14) +
      `${Number.isFinite(s.profitFactor) ? s.profitFactor.toFixed(2) : 'inf'}`.padEnd(8) +
      `${s.winRate.toFixed(1)}%`.padEnd(10) +
      `TP=${s.tp}/SL=${s.sl}`,
  );
}

// Wilson score interval, 90% CI — same method/rationale as RT-049.
const Z_90 = 1.6448536269514722;
function wilsonInterval(successes: number, n: number): { p: number; lower: number; upper: number } {
  if (n === 0) return { p: NaN, lower: NaN, upper: NaN };
  const p = successes / n;
  const z2 = Z_90 * Z_90;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (Z_90 * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { p, lower: Math.max(0, center - margin), upper: Math.min(1, center + margin) };
}
function overlaps(a: { lower: number; upper: number }, b: { lower: number; upper: number }): boolean {
  return a.lower <= b.upper && b.lower <= a.upper;
}
function fmtPct(x: number): string {
  return Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : 'n/a';
}

// Re-walks each ADMITTED trade's OWN candle path from its entryIndex (same admitted-trade set as the
// baseline run — same entries/qty/notional/admission decisions), applying RT-038/039's breakeven-only
// exit rule (trigger touch -> move SL to entry+feeBuffer, TP unchanged) instead of the straight
// TP/SL used in the baseline. Same SL-before-TP touch priority, same 2-leg fee (no partial size).
function simulateBreakevenOnly(m15Map: Map<string, Candle[]>, trades: ClosedTrade[], triggerR: number, bufferPct: number): number {
  let totalPnl = 0;
  for (const t of trades) {
    const m15All = m15Map.get(t.symbol)!;
    const triggerPrice = t.direction === 'LONG' ? t.entryPrice + triggerR * t.slDistance : t.entryPrice - triggerR * t.slDistance;
    const bufferPrice = t.entryPrice * bufferPct;
    const breakevenSlPrice = t.direction === 'LONG' ? t.entryPrice + bufferPrice : t.entryPrice - bufferPrice;
    const cost = (t.notional * FEE_PCT_SUM) / 100;

    const phase1 = scanTouch(m15All, t.entryIndex, t.direction, t.slPrice, triggerPrice);
    let exitPrice: number;
    if (phase1.outcome === 'SL') {
      exitPrice = t.slPrice;
    } else if (phase1.outcome === 'STILL_OPEN') {
      continue; // excluded, same as baseline's STILL_OPEN handling
    } else {
      const phase2 = scanTouch(m15All, phase1.index, t.direction, breakevenSlPrice, t.tpPrice);
      if (phase2.outcome === 'TP') exitPrice = t.tpPrice;
      else if (phase2.outcome === 'SL') exitPrice = breakevenSlPrice;
      else continue; // STILL_OPEN
    }
    totalPnl += t.qty * directedDelta(t.direction, t.entryPrice, exitPrice) - cost;
  }
  return totalPnl;
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

async function main() {
  const dataDir = path.resolve(process.cwd(), 'apps/bot/data');
  const targetR = DEFAULT_FVG_STRATEGY_CONFIG.targetRMultiple; // 2.1, production as of RT-045

  console.log('Dang load du lieu 1 nam (5 coin x H1+M15)...');
  const allData = await loadAllSymbolData(dataDir);
  const m15Map = new Map<string, Candle[]>(allData.map((d) => [d.symbol, d.m15All]));
  console.log(`Da load: n=${allData[0].m15All.length} nen M15/coin, ${allData[0].h1All.length} nen H1/coin, 5 coin.`);

  console.log(`\n=== TICKET-RT-051: near-live simulation, 1 nam du lieu, targetRMultiple=${targetR}R (production) ===`);
  const { closedTrades, rejectedByExposure, scaledDownCount } = runSimulation(allData, targetR);
  const filled = closedTrades.filter((t) => t.outcome !== 'STILL_OPEN');
  const summary = summarize(filled);

  console.log(`\nTong lenh da DONG (co outcome TP/SL): n=${summary.n}`);
  console.log(`  Bi TU CHOI boi Portfolio Exposure Tracker (het margin headroom): ${rejectedByExposure}`);
  console.log(`  Bi SCALE-DOWN (fit vao margin con lai, khong bi tu choi hoan toan): ${scaledDownCount}`);
  printRow('TONG (1 nam)', summary);

  console.log(`\n=== So sanh n: 1 nam CO gioi han 1 lenh/coin (n=${summary.n}) vs 90 ngay KHONG gioi han (RT-045: n=358) ===`);
  console.log(
    '  LUU Y: day khong phai so sanh thuan tuy "cung dieu kien" — khac ca do dai du lieu (365 vs 90 ngay) LAN' +
      ' phuong phap (gioi han 1 lenh/coin + exposure tracker portfolio-wide moi, thay vi khong gioi han truoc day).' +
      ' Chi bao cao ca hai con so, khong suy dien nhan qua don le tu chenh lech n.',
  );

  console.log('\n=== Breakdown 5 coin (targetR=' + targetR + 'R, 1 nam) ===');
  for (const symbol of SYMBOLS) {
    const symbolTrades = filled.filter((t) => t.symbol === symbol);
    printRow(symbol, summarize(symbolTrades));
  }

  console.log('\n=== Doi chieu targetRMultiple=1.5R vs 2.10R, CUNG pipeline near-live 1 nam ===');
  const { closedTrades: closed15 } = runSimulation(allData, 1.5);
  const s15 = summarize(closed15.filter((t) => t.outcome !== 'STILL_OPEN'));
  printRow('targetR=1.5R', s15);
  printRow('targetR=2.10R', summary);
  console.log(
    `  -> 2.10R ${summary.pnl > s15.pnl ? 'VAN TOT HON' : 'KHONG con tot hon'} 1.5R ve PnL$ tren du lieu 1 nam + pipeline near-live` +
      ` (${summary.pnl > s15.pnl ? 'nhat quan voi ket luan RT-042/044/045' : 'KHAC voi ket luan RT-042/044/045 tren 90 ngay — CAN BAO CAO, KHONG tu doi config'}).`,
  );

  console.log(`\n=== breaksKeyZone tren n lon hon (targetR=${targetR}R, 1 nam) — Wilson 90% CI theo coin ===`);
  const withZone = filled.filter((t) => t.breaksKeyZone);
  const withoutZone = filled.filter((t) => !t.breaksKeyZone);
  printRow('breaksKZ=true', summarize(withZone));
  printRow('breaksKZ=false', summarize(withoutZone));

  console.log(
    '\n' +
      'coin'.padEnd(12) +
      'true n'.padEnd(8) +
      'true winRate [90% CI]'.padEnd(28) +
      'false n'.padEnd(9) +
      'false winRate [90% CI]'.padEnd(28) +
      'chong lan?'.padEnd(12) +
      'ket luan',
  );
  let anyConfident = false;
  for (const symbol of SYMBOLS) {
    const t = withZone.filter((x) => x.symbol === symbol);
    const f = withoutZone.filter((x) => x.symbol === symbol);
    const tTp = t.filter((x) => x.outcome === 'TP').length;
    const fTp = f.filter((x) => x.outcome === 'TP').length;
    const tCI = wilsonInterval(tTp, t.length);
    const fCI = wilsonInterval(fTp, f.length);
    const ov = overlaps(tCI, fCI);
    if (!ov) anyConfident = true;
    console.log(
      symbol.padEnd(12) +
        String(t.length).padEnd(8) +
        `${fmtPct(tCI.p)} [${fmtPct(tCI.lower)}-${fmtPct(tCI.upper)}]`.padEnd(28) +
        String(f.length).padEnd(9) +
        `${fmtPct(fCI.p)} [${fmtPct(fCI.lower)}-${fmtPct(fCI.upper)}]`.padEnd(28) +
        (ov ? 'CO' : 'KHONG').padEnd(12) +
        (ov ? 'CHUA du tin cay' : 'DU bang chung phan biet'),
    );
  }
  console.log(`\n  -> ${anyConfident ? 'IT NHAT 1 coin' : 'KHONG coin nao'} dat du mau de tach CI 90% tren du lieu 1 nam (vs 0/5 tren RT-049's 90 ngay).`);

  console.log('\n=== Kiem tra nhat quan: breakeven-only (trigger=1.2R, buffer=0.5%) tren pipeline near-live 1 nam ===');
  const breakevenPnl = simulateBreakevenOnly(m15Map, filled, 1.2, 0.005);
  console.log(`  Baseline (khong breakeven, targetR=${targetR}R): PnL=$${summary.pnl.toFixed(2)}`);
  console.log(`  Breakeven-only (trigger=1.2R, buffer=0.5%):     PnL=$${breakevenPnl.toFixed(2)}`);
  console.log(
    `  -> ${breakevenPnl > summary.pnl ? 'VUOT' : 'KHONG vuot'} baseline — ${breakevenPnl > summary.pnl ? 'KHAC voi ket luan RT-038/039/041 (breakeven khong hieu qua) — CAN BAO CAO' : 'NHAT QUAN voi ket luan RT-038/039/041 tren 90 ngay'}.`,
  );
}

// TICKET-RT-066 Part B: guard against the import side-effect discovered in RT-058 — importing this
// module (e.g. apps/bot/scripts/research/xgbFeatureAudit.ts imports loadAllSymbolData/runSimulation/
// computeClosedPnl/BALANCE/SYMBOLS from here) used to also run this file's own main(), silently
// re-executing the full RT-051 near-live simulation and printing its report as an unwanted side
// effect. Only run main() when this file is the actual entry point, same pattern already used in
// xgbFeatureAuditV2.ts/V3.ts (RT-059/065).
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
