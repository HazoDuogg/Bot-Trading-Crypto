import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { checkNoTradeZone } from '../../src/noTradeZone/noTradeZone.js';
import type { Candle } from '../../src/noTradeZone/types.js';
import { classifyTrendH1 } from '../../src/trend/trendH1.js';
import { detectFvg, DEFAULT_FVG_CONFIG } from '../../src/entry/fvg.js';
import { DEFAULT_FVG_STRATEGY_CONFIG } from '../../src/entry/fvgStrategyConfig.js';
import type { Direction } from '../../src/entry/types.js';
import { calculatePositionSize } from '../../src/positionSizing/positionSizing.js';
import { DEFAULT_MAX_MARGIN_PCT } from '../../src/positionSizing/types.js';
import { computeAtr } from '../../src/noTradeZone/atr.js';
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

// TICKET-RT-060 Part A + B: purge/embargo boundary-straddle count + class imbalance check.
// Audit-only. Does NOT modify/delete any RT-058 or RT-059 file (xgbFeatureAudit.ts,
// xgbWalkForwardAudit.ts, xgbAuditDataset.csv, xgbFeatureAuditV2.ts, xgbWalkForwardAuditV2.ts,
// monthlyRegimeAudit.ts, xgbAuditDatasetV2.csv are all untouched).
//
// closeTime is NOT exposed by xgbFeatureAuditV2.ts's runInstrumentedSimulation (RT-059, frozen —
// cannot be extended without editing a frozen file), so this script is its own self-contained
// structural mirror of the SAME production pipeline (same pattern as xgbFeatureAudit.ts/
// xgbFeatureAuditV2.ts: own CSV reader, own loop, importing ONLY pure production functions from
// src/, none modified), instrumented to also capture each trade's closeTime (the M15 candle-close
// timestamp at which SL/TP actually touched — identical definition to RT-058's internal ClosedTrade
// .closeTime field). Self-checked below against the RT-056/057 confirmed constants before trusting
// any straddle count.

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

async function loadAllSymbolData(dataDir: string): Promise<SymbolData[]> {
  const out: SymbolData[] = [];
  for (const symbol of SYMBOLS) {
    const m15All = await readCsv(path.join(dataDir, `${symbol}_15m_1y.csv`));
    const h1All = await readCsv(path.join(dataDir, `${symbol}_1h_1y.csv`));
    out.push({ symbol, m15All, h1All });
  }
  return out;
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
  h1Cursor: number;
  cachedH1CursorForZones: number;
  cachedZones: KeyZone[];
  pending: PendingFvg | null;
  open: OpenTrade | null;
  nextId: number;
}

function runInstrumentedSimulation(allData: SymbolData[], targetRMultiple: number): TradeRecord[] {
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
  const trades: TradeRecord[] = [];

  for (let i = 2; i < nCandles; i++) {
    for (const st of states) {
      const { symbol, m15All, h1All } = st.data;
      const m15CloseTime = m15All[i].openTime + M15_MS;
      while (st.h1Cursor < h1All.length && h1All[st.h1Cursor].openTime + H1_MS <= m15CloseTime) st.h1Cursor++;
      if (st.h1Cursor === 0) continue;

      const h1Window = h1All.slice(0, st.h1Cursor);
      const m15Window = m15All.slice(0, i + 1);
      const closePrice = h1Window[h1Window.length - 1].close;
      const candle = m15All[i];

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
                st.open = {
                  id,
                  direction,
                  entryPrice,
                  slPrice,
                  tpPrice,
                  slDistance,
                  qty: result.qty,
                  notional: result.notional,
                  entryTimestampUtc: candle.openTime,
                };
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

  return trades;
}

function monthKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

interface FoldDef {
  foldIndex: number;
  trainMonths: string[];
  lastTrainMonth: string;
  testMonth: string;
}

function buildFolds(monthsPresent: string[]): FoldDef[] {
  const K = monthsPresent.length;
  const lastTestMonth = Math.min(K, 12);
  const folds: FoldDef[] = [];
  for (let testMonthIdx = 7; testMonthIdx <= lastTestMonth; testMonthIdx++) {
    const trainMonthIndices = Array.from({ length: testMonthIdx - 1 }, (_, i) => i + 1);
    folds.push({
      foldIndex: testMonthIdx - 6,
      trainMonths: trainMonthIndices.map((idx) => monthsPresent[idx - 1]),
      lastTrainMonth: monthsPresent[testMonthIdx - 2],
      testMonth: monthsPresent[testMonthIdx - 1],
    });
  }
  return folds;
}

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
function fmtPct(x: number): string {
  return Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : 'n/a';
}

async function main() {
  const dataDir = path.resolve(process.cwd(), 'apps/bot/data');
  const reportPath = path.resolve(process.cwd(), 'apps/bot/reports/RT-060-report.md');
  const targetR = DEFAULT_FVG_STRATEGY_CONFIG.targetRMultiple;

  console.log('Dang load du lieu 1 nam (5 coin x H1+M15)...');
  const allData = await loadAllSymbolData(dataDir);
  console.log(`Da load: n=${allData[0].m15All.length} nen M15/coin, 5 coin.`);

  console.log('\nDang chay mirrored simulation (co closeTime, khong qua simulateOneYearNearLive.ts, khong sua RT-058/059)...');
  const trades = runInstrumentedSimulation(allData, targetR);

  let totalPnl = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  for (const t of trades) {
    totalPnl += t.pnl;
    if (t.pnl > 0) grossProfit += t.pnl;
    else if (t.pnl < 0) grossLoss += Math.abs(t.pnl);
  }
  const totalPf = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
  console.log(`\nKet qua: n=${trades.length}  PnL=$${totalPnl.toFixed(2)}  PF=${totalPf.toFixed(3)}`);
  console.log('Doi chieu RT-056/057 Config B (chot): n=1217, PnL=$2628.76, PF=1.551');

  const matches = trades.length === 1217 && Math.abs(totalPnl - 2628.76) < 0.01 && Math.abs(totalPf - 1.551) < 0.001;
  if (!matches) {
    console.error('\nCORRECTION_REQUIRED: mirrored loop (RT-060) KHONG khop voi RT-056/057 da chot — DUNG lai, khong ghi bao cao.');
    process.exitCode = 1;
    return;
  }
  console.log('-> KHOP 100%: dung duoc entryTimestampUtc/closeTime chinh xac cho purge/embargo audit.');

  const monthsPresent = Array.from(new Set(trades.map((t) => monthKey(t.entryTimestampUtc)))).sort();
  const folds = buildFolds(monthsPresent);
  console.log(`\nCac thang: ${monthsPresent.join(', ')} (${monthsPresent.length} thang). ${folds.length} fold.`);

  // --- Part A: boundary straddle count ---
  interface StraddleTrade extends TradeRecord {
    entryMonth: string;
    closeMonth: string;
  }
  const foldStraddles: { fold: FoldDef; straddles: StraddleTrade[]; earlierMonthStraddles: StraddleTrade[] }[] = [];
  for (const fold of folds) {
    const trainTrades = trades.filter((t) => fold.trainMonths.includes(monthKey(t.entryTimestampUtc)));
    const straddles: StraddleTrade[] = [];
    const earlierMonthStraddles: StraddleTrade[] = [];
    for (const t of trainTrades) {
      const entryMonth = monthKey(t.entryTimestampUtc);
      const closeMonth = monthKey(t.closeTime);
      if (closeMonth === fold.testMonth && entryMonth !== closeMonth) {
        const rec = { ...t, entryMonth, closeMonth };
        if (entryMonth === fold.lastTrainMonth) straddles.push(rec);
        else earlierMonthStraddles.push(rec);
      }
    }
    foldStraddles.push({ fold, straddles, earlierMonthStraddles });
    console.log(`Fold ${fold.foldIndex} (train ket thuc ${fold.lastTrainMonth}, test ${fold.testMonth}): straddle (entry=thang train cuoi, close=thang test) = ${straddles.length}; straddle tu thang train som hon (bonus, ngoai dinh nghia ticket) = ${earlierMonthStraddles.length}`);
  }

  // --- Part B: class imbalance ---
  const winsAll = trades.filter((t) => t.outcome === 'TP').length;
  const ciAll = wilsonInterval(winsAll, trades.length);

  interface FoldImbalance {
    fold: FoldDef;
    trainN: number;
    trainWinRate: number;
    trainFlag: boolean;
    testN: number;
    testWinRate: number;
    testFlag: boolean;
  }
  const foldImbalances: FoldImbalance[] = folds.map((fold) => {
    const trainTrades = trades.filter((t) => fold.trainMonths.includes(monthKey(t.entryTimestampUtc)));
    const testTrades = trades.filter((t) => monthKey(t.entryTimestampUtc) === fold.testMonth);
    const trainWinRate = trainTrades.filter((t) => t.outcome === 'TP').length / trainTrades.length;
    const testWinRate = testTrades.filter((t) => t.outcome === 'TP').length / testTrades.length;
    return {
      fold,
      trainN: trainTrades.length,
      trainWinRate,
      trainFlag: trainWinRate < 0.4 || trainWinRate > 0.6,
      testN: testTrades.length,
      testWinRate,
      testFlag: testWinRate < 0.4 || testWinRate > 0.6,
    };
  });

  // --- Report ---
  let md = '# TICKET-RT-060 — Phase 1 hoan tat: Purge/Embargo Verification + Class Imbalance Check\n\n';
  md += 'Audit-only. Khong sua entryRouter/fvg.ts/positionSizing/* hay bat ky code production nao. Khong sua/xoa bat ky file RT-058/RT-059 nao.\n\n';
  md += `Nguon du lieu: mirrored simulation tu-kiem-tra rieng cua ticket nay (purgeEmbargoAudit.ts — KHONG qua simulateOneYearNearLive.ts, KHONG sua xgbFeatureAuditV2.ts vi file do bi dong bang theo RT-059). `;
  md += `Ly do can rerun: closeTime khong duoc xgbFeatureAuditV2.ts (RT-059) xuat ra, va khong the bo sung ma khong sua file da dong bang. Tu-kiem-tra khop 100% voi RT-056/057 (n=${trades.length}, PnL=$${totalPnl.toFixed(2)}, PF=${totalPf.toFixed(3)}).\n\n`;
  md += `Cac thang co trong du lieu: ${monthsPresent.join(', ')} (${monthsPresent.length} thang), cung fold split (expanding window theo thang) nhu RT-058/059.\n\n`;

  md += '## Part A — Purge/Embargo: boundary straddle count\n\n';
  md += 'Dinh nghia "straddle" (dung nhu ticket yeu cau): lenh co `entryTimestampUtc` roi vao THANG TRAIN CUOI CUNG cua fold (thang train ngay truoc thang test), NHUNG `closeTime` roi vao THANG TEST cua chinh fold do. Day la dieu kien can cho purge/embargo — neu lenh nhu vay ton tai, nhan (won/lost) cua no duoc dung de train mang thong tin gia ca da xay ra MOT PHAN trong ky test, du feature cua no (co dinh tai thoi diem entry) khong bi anh huong.\n\n';
  md += '| Fold | Thang train cuoi | Thang test | So lenh straddle (dung dinh nghia ticket) | Bonus: straddle tu thang train som hon |\n';
  md += '|---|---|---|---|---|\n';
  let totalStraddle = 0;
  for (const { fold, straddles, earlierMonthStraddles } of foldStraddles) {
    totalStraddle += straddles.length;
    md += `| ${fold.foldIndex} | ${fold.lastTrainMonth} | ${fold.testMonth} | ${straddles.length} | ${earlierMonthStraddles.length} |\n`;
  }
  md += `\nTong so lenh straddle (dung dinh nghia ticket) qua ca ${folds.length} fold: **${totalStraddle}**.\n\n`;

  if (totalStraddle > 0) {
    md += '### Chi tiet lenh straddle\n\n';
    md += '| Fold | Symbol | entryTimestampUtc (UTC) | closeTime (UTC) | Outcome |\n';
    md += '|---|---|---|---|---|\n';
    for (const { fold, straddles } of foldStraddles) {
      for (const s of straddles) {
        md += `| ${fold.foldIndex} | ${s.symbol} | ${new Date(s.entryTimestampUtc).toISOString()} | ${new Date(s.closeTime).toISOString()} | ${s.outcome} |\n`;
      }
    }
    md += '\n';
  }

  md += '### Xac minh khong ro ri qua rollingWinRateSameSymbol20 / concurrentOpenPositionsCount (doc code, khong chay lai)\n\n';
  md +=
    'Ca 2 feature phu thuoc trang thai lenh khac deu duoc doc trong file apps/bot/scripts/research/xgbFeatureAuditV2.ts (RT-059, khong sua o ticket nay; duong dan da cap nhat sau RT-066 Phan A archive — noi dung file khong doi). ' +
    'Trich dan bang so dong hien tai cua file do:\n\n';
  md += '- **Vong lap chinh la mot duong di THOI GIAN THUC don le, khong phai theo thu tu mang:** `for (let i = 2; i < nCandles; i++) { for (const st of states) { ... } }` (xgbFeatureAuditV2.ts dong 210-211). `i` la chi so nen M15 tang dan don dieu — moi trang thai (mo/dong lenh, pastOutcomes, exposureState) chi duoc cap nhat khi vong lap di toi dung chi so `i` tuong ung voi thoi diem that. Khong co buoc nao trong file duyet lai theo "thu tu lenh trong mang ket qua" — mang `rows`/`closed` chi la NOI GHI output, khong phai nguon doc.\n';
  md +=
    '- **rollingWinRateSameSymbol20 (dong 321-324):** doc tu `st.pastOutcomes`, va `st.pastOutcomes.push(outcome === "TP")` CHI xay ra o dong 265, BEN TRONG nhanh `if (slTouched || tpTouched)` (dong 258) — tuc la CHI khi vong lap da di toi dung chi so `i` ma gia thuc su cham SL/TP cua lenh do. Vi mot symbol CHI co toi da 1 lenh mo tai mot thoi diem (phat hien bi khoa hoan toan trong khi `st.open` khac null — dong 254 `if (st.open) { ... continue; }` chay TRUOC ca nhanh phat hien lenh moi o duoi), moi lenh trong lich su cua 1 symbol chac chan da DONG (that su, theo `i`) truoc khi lenh ke tiep cua CHINH symbol do co the duoc phat hien — nen doc `pastOutcomes` tai thoi diem fill khong bao gio thay outcome cua chinh lenh dang mo hoac bat ky lenh nao chua thuc su dong.\n';
  md +=
    '- **concurrentOpenPositionsCount (dong 296):** `const concurrentOpenPositionsCount = exposureState.openPositions.length;` doc TRUOC dong 297 (`admitPosition(...)`) — tuc la trang thai truoc-khi-nhan lenh hien tai. `exposureState` chi thay doi qua `closePosition()` (dong 266, trong nhanh dong lenh, cung dieu kien "da thuc su cham SL/TP" nhu tren) va qua `admitPosition()` (dong 297, khi mot lenh KHAC da duoc nhan truoc do trong CHINH vong lap `i` nay hoac som hon). Vi cac symbol duoc duyet theo thu tu co dinh trong `states` (BTC, ETH, SOL, HYPE, XRP — xgbFeatureAuditV2.ts dong 84) NHUNG cung mot gia tri `i` (cung mot moc thoi gian M15), mot lenh dong/mo cua symbol duyet TRUOC trong cung buoc `i` se duoc phan anh dung cho symbol duyet SAU trong CUNG buoc `i` — dung voi ngu nghia "dong thoi tai thoi diem nay", khong phai loi thu tu.\n';
  md +=
    '- **Ket luan doc code:** ca 2 feature deu chi doc trang thai da duoc cap nhat boi CHINH vong lap thoi gian thuc (`i` tang don dieu), khong co duong nao trong file cho phep doc outcome cua mot lenh TRUOC khi vong lap thuc su di toi chi so `i` ma lenh do cham SL/TP. Dieu nay dung KHONG PHU THUOC vao viec co ton tai lenh straddle hay khong — lenh straddle (neu co) van tuan thu dung quy tac nay, no chi co nghia la NHAN (label) cua no duoc gan cho mot lenh nam trong fold train nhung outcome cua no chi "hoan tat" (closeTime) sau khi thang test da bat dau — day la diem Vinh Tam/AI reviewer can tu danh gia co chap nhan duoc hay can them buoc purge/embargo, KHONG phai mot loi feature-level leak nhu preview truoc.\n\n';

  md += '## Part B — Class imbalance check\n\n';
  md += `Toan bo ${trades.length} lenh: ${winsAll} TP / ${trades.length - winsAll} SL. Winrate = ${fmtPct(ciAll.p)} [Wilson 90% CI: ${fmtPct(ciAll.lower)}-${fmtPct(ciAll.upper)}].\n\n`;
  md += '| Fold | Train n | Train winrate | Train flag (ngoai 40-60%) | Test n | Test winrate | Test flag (ngoai 40-60%) |\n';
  md += '|---|---|---|---|---|---|---|\n';
  for (const fi of foldImbalances) {
    md += `| ${fi.fold.foldIndex} | ${fi.trainN} | ${fmtPct(fi.trainWinRate)} | ${fi.trainFlag ? '**CO**' : 'khong'} | ${fi.testN} | ${fmtPct(fi.testWinRate)} | ${fi.testFlag ? '**CO**' : 'khong'} |\n`;
  }
  const anyFlag = foldImbalances.some((fi) => fi.trainFlag || fi.testFlag);
  md += `\n${anyFlag ? 'CO it nhat 1 fold (train hoac test) lech ngoai khoang 40-60% winrate — xem cot flag o tren de biet fold nao.' : 'KHONG co fold nao (train hoac test) lech ngoai khoang 40-60% winrate.'} `;
  md += 'Luu y: `XGBClassifier` mac dinh (nhu dung trong RT-058/059) khong tu can bang class — mot fold lech xa 50/50 co the anh huong AUC/decile cua fold do, can Vinh Tam/AI reviewer tu danh gia muc do anh huong.\n\n';

  md += '## Khong ket luan Phase 1 dat/khong dat\n\n';
  md += 'Ticket nay chi bao cao so do duoc (so lenh straddle + trich dan code + ty le class imbalance). Khong tu ket luan thay Vinh Tam/AI reviewer, va khong bat dau bat ky phan nao cua Shadow Mode (Phase 4).\n';

  const reportsDir = path.dirname(reportPath);
  await mkdir(reportsDir, { recursive: true });
  await writeFile(reportPath, md, 'utf8');
  console.log(`\nDa ghi bao cao vao ${reportPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
