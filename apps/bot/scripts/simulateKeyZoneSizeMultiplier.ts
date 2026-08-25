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
import { computeAtr } from '../src/noTradeZone/atr.js';
import { findKeyZones } from '../src/zones/keyZones.js';
import type { KeyZone } from '../src/zones/keyZones.js';
import { DEFAULT_REGIME_CONFIG } from '../src/regime/types.js';

// TICKET-RT-050: simulate a size multiplier on the breaksKeyZone=true group, applied POST-HOC to the
// already-computed 358-trade PnL — NOT a new entry backtest. Trade generation (entry-scan,
// breaksKeyZone labeling) is duplicated verbatim from RT-048's measureKeyZoneCorrelation210.ts (same
// FVG_KEY_ZONE_CONFIG, same findKeyZones() call unmodified, same detectFvg/checkNoTradeZone/
// classifyTrendH1/calculatePositionSize/config imports), run ONCE to reproduce the identical n=358
// (51 true / 307 false) set, then multiplied — same pattern as RT-028's "post-hoc filter is exactly
// equivalent" reasoning, just multiplying instead of filtering. No production position-sizing code
// is touched or invoked with the multiplier — this is backtest-only.

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
const TARGET_R = DEFAULT_FVG_STRATEGY_CONFIG.targetRMultiple; // 2.1, production as of RT-045
const SWEEP_CONFIG = {
  minCandle2BodyRatio: DEFAULT_FVG_CONFIG.minCandle2BodyRatio,
  maxWaitCandles: DEFAULT_FVG_STRATEGY_CONFIG.maxWaitCandles,
  targetRMultiple: TARGET_R,
};

const FEE_PCT_SUM = 0.05 + 0.05 + 0.05 + 0.05; // same constant as every sibling script since RT-027

const BALANCE = 500;
const RISK_PCT = 0.01; // nominal target risk per trade, 1% of balance — same as production sizing
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
  breaksKeyZone: boolean;
}

interface Trade {
  symbol: string;
  direction: Direction;
  entryPrice: number;
  slPrice: number;
  tpPrice: number;
  qty: number;
  notional: number;
  outcome: Outcome;
  slPct: number;
  breaksKeyZone: boolean;
}

async function findTrades(symbol: string, dataDir: string): Promise<Trade[]> {
  const h1All = await readCsv(path.join(dataDir, `${symbol}_1h.csv`));
  const m15All = await readCsv(path.join(dataDir, `${symbol}_15m.csv`));
  const leverage = LEVERAGE[symbol];

  let h1Cursor = 0;
  const trades: Trade[] = [];
  let pending: PendingFvg | null = null;

  let cachedH1Cursor = -1;
  let cachedZones: KeyZone[] = [];

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
            pending.direction === 'LONG'
              ? entryPrice + SWEEP_CONFIG.targetRMultiple * slDistance
              : entryPrice - SWEEP_CONFIG.targetRMultiple * slDistance;
          const sizing = calculatePositionSize({
            balance: BALANCE,
            riskUsd: RISK_USD,
            entryPrice,
            slPrice,
            leverage,
            maxMarginPct: DEFAULT_MAX_MARGIN_PCT,
          });
          if (sizing) {
            const outcome = scanOutcome(m15All, i, pending.direction, slPrice, tpPrice);
            trades.push({
              symbol,
              direction: pending.direction,
              entryPrice,
              slPrice,
              tpPrice,
              qty: sizing.qty,
              notional: sizing.notional,
              outcome,
              slPct: (slDistance / entryPrice) * 100,
              breaksKeyZone: pending.breaksKeyZone,
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
      if (h1Cursor !== cachedH1Cursor) {
        cachedH1Cursor = h1Cursor;
        const atrH1Values = computeAtr(h1Window, ATR_PERIOD);
        const atrH1 = atrH1Values.length > 0 ? atrH1Values[atrH1Values.length - 1] : 0;
        cachedZones = atrH1 > 0 ? findKeyZones(h1Window, atrH1, FVG_KEY_ZONE_CONFIG) : [];
      }
      const gapLow = fvg.gapLow;
      const gapHigh = fvg.gapHigh;
      const breaksKeyZone = cachedZones.some((z) => z.price >= gapLow && z.price <= gapHigh);

      pending = {
        direction: fvg.direction,
        gapLow: fvg.gapLow,
        gapHigh: fvg.gapHigh,
        invalidationPrice: fvg.invalidationPrice,
        waitCount: 0,
        breaksKeyZone,
      };
    }
  }

  return trades;
}

function scanOutcome(m15All: Candle[], entryIndex: number, direction: Direction, slPrice: number, tpPrice: number): Outcome {
  for (let j = entryIndex + 1; j < m15All.length; j++) {
    const candle = m15All[j];
    const slTouched = direction === 'LONG' ? candle.low <= slPrice : candle.high >= slPrice;
    const tpTouched = direction === 'LONG' ? candle.high >= tpPrice : candle.low <= tpPrice;
    if (slTouched) return 'SL';
    if (tpTouched) return 'TP';
  }
  return 'STILL_OPEN';
}

function directedDelta(direction: Direction, entryPrice: number, exitPrice: number): number {
  return direction === 'LONG' ? exitPrice - entryPrice : entryPrice - exitPrice;
}

// Baseline PnL at 1.0x — identical formula to every sibling script's computePnl.
function baselinePnl(t: Trade): number {
  if (t.outcome === 'STILL_OPEN') return 0;
  const costDollars = (t.notional * FEE_PCT_SUM) / 100;
  const exitPrice = t.outcome === 'TP' ? t.tpPrice : t.slPrice;
  return t.qty * directedDelta(t.direction, t.entryPrice, exitPrice) - costDollars;
}

// Applies multiplier M to the breaksKeyZone=true group's PnL (both wins and losses scale), leaves
// breaksKeyZone=false untouched at 1.0x — exactly what the ticket specifies (post-hoc PnL scaling,
// not a re-run with a different position size, which would also change fees/qty in ways the ticket
// doesn't ask for).
function multipliedPnl(t: Trade, M: number): number {
  const base = baselinePnl(t);
  return t.breaksKeyZone ? base * M : base;
}

interface Summary {
  n: number;
  pnl: number;
  profitFactor: number;
}

function summarize(pnls: number[]): Summary {
  let pnl = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  for (const p of pnls) {
    pnl += p;
    if (p > 0) grossProfit += p;
    else if (p < 0) grossLoss += Math.abs(p);
  }
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
  return { n: pnls.length, pnl, profitFactor };
}

async function main() {
  const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'HYPEUSDT', 'XRPUSDT'];
  const dataDir = path.resolve(process.cwd(), 'apps/bot/data');

  let allTrades: Trade[] = [];
  for (const symbol of symbols) {
    const trades = await findTrades(symbol, dataDir);
    allTrades = allTrades.concat(trades);
  }

  const filled = allTrades.filter((t) => t.slPct >= FLOOR_PCT).filter((t) => t.outcome !== 'STILL_OPEN');
  const trueGroup = filled.filter((t) => t.breaksKeyZone);
  const falseGroup = filled.filter((t) => !t.breaksKeyZone);
  console.log(
    `Tong lenh (targetR=${TARGET_R}, da co outcome): n=${filled.length} (ky vong 358, breaksKZ=true:${trueGroup.length}, breaksKZ=false:${falseGroup.length} — doi chieu RT-048: 51/307)`,
  );

  const baselineSummary = summarize(filled.map((t) => baselinePnl(t)));
  console.log(`\nBASELINE (M=1.0, khong doi gi): PnL=$${baselineSummary.pnl.toFixed(2)}  PF=${Number.isFinite(baselineSummary.profitFactor) ? baselineSummary.profitFactor.toFixed(2) : 'inf'}`);
  console.log(`  (doi chieu RT-048: PnL=$653.72, PF=1.61 — tong 358 lenh o targetR=2.10R KHONG tach nhom; so voi day, ket qua nay chi tinh tren ${filled.length} lenh co outcome, giong nhau vi 0 STILL_OPEN)`);

  const MULTIPLIERS = [1.0, 1.2, 1.3, 1.5, 1.75, 2.0];

  console.log('\n=== Sweep size-multiplier M cho nhom breaksKeyZone=true (n=51) ===');
  console.log(
    'M'.padEnd(8) +
      'PnL$ tong'.padEnd(14) +
      'PF tong'.padEnd(10) +
      'dPnL$ vs baseline'.padEnd(20) +
      'rui ro/lenh nhom true'.padEnd(24) +
      'rui ro chuan',
  );
  const rows: { M: number; total: Summary; trueContribution: number }[] = [];
  for (const M of MULTIPLIERS) {
    const totalPnls = filled.map((t) => multipliedPnl(t, M));
    const total = summarize(totalPnls);
    const truePnls = trueGroup.map((t) => multipliedPnl(t, M));
    const trueContribution = truePnls.reduce((a, b) => a + b, 0);
    rows.push({ M, total, trueContribution });

    const dPnl = total.pnl - baselineSummary.pnl;
    const riskPerTradeTrue = M * RISK_PCT * 100; // % of balance
    console.log(
      `${M}x`.padEnd(8) +
        `$${total.pnl.toFixed(2)}`.padEnd(14) +
        `${Number.isFinite(total.profitFactor) ? total.profitFactor.toFixed(3) : 'inf'}`.padEnd(10) +
        `${dPnl >= 0 ? '+' : ''}$${dPnl.toFixed(2)}`.padEnd(20) +
        `${riskPerTradeTrue.toFixed(2)}% von/lenh`.padEnd(24) +
        `${(RISK_PCT * 100).toFixed(2)}% von/lenh`,
    );
  }

  console.log('\n=== Dong gop rieng cua nhom breaksKeyZone=true (51 lenh) vao tong tang truong ===');
  console.log('M'.padEnd(8) + 'PnL$ nhom true'.padEnd(18) + 'PnL$ nhom false (co dinh)'.padEnd(26) + '% dong gop tu true trong PHAN TANG THEM');
  const falseFixedPnl = summarize(falseGroup.map((t) => baselinePnl(t))).pnl; // never scaled, same at every M
  for (const row of rows) {
    const dPnlFromBaseline = row.total.pnl - baselineSummary.pnl;
    const trueContributionAboveBaseline = row.trueContribution - summarize(trueGroup.map((t) => baselinePnl(t))).pnl;
    const pctOfGrowthFromTrue = dPnlFromBaseline !== 0 ? (trueContributionAboveBaseline / dPnlFromBaseline) * 100 : 0;
    console.log(
      `${row.M}x`.padEnd(8) +
        `$${row.trueContribution.toFixed(2)}`.padEnd(18) +
        `$${falseFixedPnl.toFixed(2)}`.padEnd(26) +
        `${row.M === 1.0 ? '-' : pctOfGrowthFromTrue.toFixed(1) + '%'}`,
    );
  }

  console.log(
    '\n*** CANH BAO CO MAU (RT-049): n=51 (breaksKeyZone=true) CHUA du bang chung thong ke o muc coin rieng le' +
      ' (khong coin nao co CI 90% khong chong lan voi nhom false). Cac so tren CHI dang tin o muc GOP toan danh muc' +
      ' (5 coin), KHONG nen dien giai "multiplier X la chac chan toi uu" — day la MO PHONG tham khao huong di,' +
      ' khong phai ket luan da xac nhan robust. Khong code multiplier vao production trong ticket nay.',
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
