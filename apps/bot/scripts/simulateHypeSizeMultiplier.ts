import path from 'node:path';
import { DEFAULT_FVG_STRATEGY_CONFIG } from '../src/entry/fvgStrategyConfig.js';
import {
  SYMBOLS,
  RISK_PCT,
  loadAllSymbolData,
  runSimulation,
  computeClosedPnl,
  type ClosedTrade,
} from './simulateOneYearNearLive.js';

// TICKET-RT-052: simulate a size multiplier on breaksKeyZone=true, applied POST-HOC to PnL and
// ONLY on HYPEUSDT (the only coin with a non-overlapping 90% Wilson CI per RT-051/054 — true n=45,
// winRate 68.9% [56.7-78.9%] vs false n=532, winRate 49.4% [45.9-53.0%]). BTC/ETH/SOL/XRP are left
// completely untouched (still 1.0x on every trade) — not enough evidence per RT-051.
//
// Reuses RT-051's near-live simulation (loadAllSymbolData/runSimulation/computeClosedPnl, now
// exported from simulateOneYearNearLive.ts, not duplicated — same 1-year data post-RT-054 fix, same
// Isolated/One-way/1-trade-per-coin/exposure-tracker pipeline, same targetRMultiple=2.10 production
// value) run ONCE, then multiplies each closed trade's PnL post-hoc — same "post-hoc scaling is
// exactly equivalent to a re-run with different sizing, for every already-computed exit price"
// reasoning as RT-028/RT-050. No production position-sizing code is touched or invoked with the
// multiplier — backtest-only, per the ticket's "Khong lam".
//
// NOTE ON BASELINE NUMBER: the ticket cites RT-051's original baseline PnL=$1990.14. RT-054 found and
// fixed an in-progress-candle bug affecting exactly 1 row per data file, and re-ran RT-051's pipeline
// on the corrected data: n=1220->1217, PnL=$1990.14->$1993.60 (all conclusions unchanged). This script
// uses the CORRECTED (RT-054) data and its own freshly-computed baseline, not the now-superseded
// $1990.14 — flagged explicitly here and in the report rather than silently matching the stale number.

const MULTIPLIERS = [1.0, 1.2, 1.3, 1.5, 1.75, 2.0];

function multipliedPnl(t: ClosedTrade, M: number): number {
  const base = computeClosedPnl(t);
  return t.symbol === 'HYPEUSDT' && t.breaksKeyZone ? base * M : base;
}

interface Stats {
  n: number;
  pnl: number;
  profitFactor: number;
}

function summarizePnls(pnls: number[]): Stats {
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
  const dataDir = path.resolve(process.cwd(), 'apps/bot/data');
  const targetR = DEFAULT_FVG_STRATEGY_CONFIG.targetRMultiple; // 2.1, production as of RT-045

  console.log('Dang load du lieu 1 nam (da fix RT-054)...');
  const allData = await loadAllSymbolData(dataDir);
  const { closedTrades } = runSimulation(allData, targetR);
  const filled = closedTrades.filter((t) => t.outcome !== 'STILL_OPEN');

  const baseline = summarizePnls(filled.map((t) => computeClosedPnl(t)));
  console.log(`\nTong lenh (targetR=${targetR}, 1 nam, da fix RT-054): n=${filled.length}`);
  console.log(
    `BASELINE (M=1.0, khong doi gi): PnL=$${baseline.pnl.toFixed(2)}  PF=${Number.isFinite(baseline.profitFactor) ? baseline.profitFactor.toFixed(2) : 'inf'}` +
      `  (doi chieu RT-054 da fix: $1993.60 — KHONG phai $1990.14 cua RT-051 goc, xem ghi chu dau file)`,
  );

  const hypeTrades = filled.filter((t) => t.symbol === 'HYPEUSDT');
  const hypeTrue = hypeTrades.filter((t) => t.breaksKeyZone);
  const hypeFalse = hypeTrades.filter((t) => !t.breaksKeyZone);
  console.log(`HYPEUSDT: n=${hypeTrades.length} (breaksKZ=true: ${hypeTrue.length}, breaksKZ=false: ${hypeFalse.length})`);

  console.log('\n=== Sweep size-multiplier M cho breaksKeyZone=true, CHI HYPEUSDT ===');
  console.log(
    'M'.padEnd(8) +
      'PnL$ toan danh muc'.padEnd(20) +
      'PF toan danh muc'.padEnd(18) +
      'dPnL$ vs baseline'.padEnd(20) +
      'rui ro/lenh true-HYPE'.padEnd(24) +
      'rui ro chuan',
  );

  const otherCoinsFixedPnl = summarizePnls(filled.filter((t) => t.symbol !== 'HYPEUSDT').map((t) => computeClosedPnl(t))).pnl;
  const hypeFalseFixedPnl = summarizePnls(hypeFalse.map((t) => computeClosedPnl(t))).pnl;
  const hypeTrueBaselinePnl = summarizePnls(hypeTrue.map((t) => computeClosedPnl(t))).pnl;

  const rows: { M: number; total: Stats; hypeTrueContribution: number; hypeTotal: Stats }[] = [];
  for (const M of MULTIPLIERS) {
    const totalPnls = filled.map((t) => multipliedPnl(t, M));
    const total = summarizePnls(totalPnls);
    const hypeTruePnls = hypeTrue.map((t) => multipliedPnl(t, M));
    const hypeTrueContribution = hypeTruePnls.reduce((a, b) => a + b, 0);
    const hypeTotalPnls = hypeTrades.map((t) => multipliedPnl(t, M));
    const hypeTotal = summarizePnls(hypeTotalPnls);
    rows.push({ M, total, hypeTrueContribution, hypeTotal });

    const dPnl = total.pnl - baseline.pnl;
    const riskPerTradeTrueHype = M * RISK_PCT * 100;
    console.log(
      `${M}x`.padEnd(8) +
        `$${total.pnl.toFixed(2)}`.padEnd(20) +
        `${Number.isFinite(total.profitFactor) ? total.profitFactor.toFixed(3) : 'inf'}`.padEnd(18) +
        `${dPnl >= 0 ? '+' : ''}$${dPnl.toFixed(2)}`.padEnd(20) +
        `${riskPerTradeTrueHype.toFixed(2)}% von/lenh`.padEnd(24) +
        `${(RISK_PCT * 100).toFixed(2)}% von/lenh`,
    );
  }

  console.log('\n=== Rieng HYPEUSDT: PnL$/PF dong gop o moi muc M ===');
  console.log('M'.padEnd(8) + 'HYPE PnL$ tong'.padEnd(18) + 'HYPE PF tong'.padEnd(16) + 'PnL$ nhom true-HYPE'.padEnd(22) + 'PnL$ nhom false-HYPE (co dinh)');
  for (const row of rows) {
    console.log(
      `${row.M}x`.padEnd(8) +
        `$${row.hypeTotal.pnl.toFixed(2)}`.padEnd(18) +
        `${Number.isFinite(row.hypeTotal.profitFactor) ? row.hypeTotal.profitFactor.toFixed(3) : 'inf'}`.padEnd(16) +
        `$${row.hypeTrueContribution.toFixed(2)}`.padEnd(22) +
        `$${hypeFalseFixedPnl.toFixed(2)}`,
    );
  }

  console.log('\n=== % tang truong toan danh muc den tu dung 45 lenh true-HYPE (muc do tap trung rui ro) ===');
  console.log('M'.padEnd(8) + 'dPnL$ toan danh muc'.padEnd(22) + 'dPnL$ tu 45 lenh true-HYPE'.padEnd(28) + '% tang truong tu 45 lenh nay');
  for (const row of rows) {
    if (row.M === 1.0) {
      console.log('1x'.padEnd(8) + '+$0.00'.padEnd(22) + '+$0.00'.padEnd(28) + '-');
      continue;
    }
    const dTotal = row.total.pnl - baseline.pnl;
    const dFromHypeTrue = row.hypeTrueContribution - hypeTrueBaselinePnl;
    const pct = dTotal !== 0 ? (dFromHypeTrue / dTotal) * 100 : 0;
    console.log(`${row.M}x`.padEnd(8) + `+$${dTotal.toFixed(2)}`.padEnd(22) + `+$${dFromHypeTrue.toFixed(2)}`.padEnd(28) + `${pct.toFixed(1)}%`);
  }

  console.log(
    `\n(Kiem tra: other 4 coin PnL co dinh $${otherCoinsFixedPnl.toFixed(2)} + HYPE false-KZ co dinh $${hypeFalseFixedPnl.toFixed(2)} + HYPE true-KZ (scaled) = tong toan danh muc o moi M — khop voi cong thuc "chi HYPE true-KZ doi", 4 coin con lai va HYPE false-KZ luon co dinh.)`,
  );

  console.log(
    '\n*** CANH BAO: day la mo phong tham khao, KHONG code multiplier vao production/positionSizing thuc te.' +
      ' Rui ro tap trung vao dung 45 lenh cua 1 coin (HYPEUSDT) — neu HYPEUSDT tuong lai khong con giu duoc' +
      ' tuong quan breaksKeyZone nhu qua khu, phan tang PnL$ nay se khong xay ra hoac dao nguoc thanh lo them.' +
      ' 4 coin BTC/ETH/SOL/XRP giu nguyen 1.0x hoan toan, khong doi gi, dung pham vi ticket.',
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
