import { readFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { loadAllSymbolData, runInstrumentedSimulation } from './xgbFeatureAuditV2.js';
import { DEFAULT_FVG_STRATEGY_CONFIG } from '../../src/entry/fvgStrategyConfig.js';

// TICKET-RT-059 Part B: month-by-month PF/winrate regime audit over the RT-058 dataset
// (apps/bot/data/xgbAuditDataset.csv) — no NEW backtest/detection logic, no production code
// touched.
//
// METHODOLOGY NOTE (flagging per CLAUDE.md — the ticket's literal "khong chay lai backtest" wording
// conflicts with needing exact PF/PnL$, and the user picked the resolution below over chat):
// a first version of this script tried to derive each trade's $ PnL purely from columns already in
// xgbAuditDataset.csv (slPct/breaksKeyZone/won) via the risk-based sizing formula (riskUsd = BALANCE
// x resolveRiskPct(...); PnL = won ? riskUsd*targetR - fees : -riskUsd - fees). That is exact ONLY
// when a trade's sizing was unclamped by calculatePositionSize's maxMarginPct and un-scaled by the
// portfolio exposure tracker — self-checking the aggregate against the RT-056/057 confirmed total
// ($2628.76) showed a $1.71 (0.065%) gap, proving a small number of trades WERE clamped/scaled, which
// the CSV has no way to represent. Presented that finding to the user; they chose to rerun the exact
// same self-checked mirrored simulation already built and verified for Part A
// (xgbFeatureAuditV2.ts's runInstrumentedSimulation, imported here — NOT scripts/
// simulateOneYearNearLive.ts, which has the RT-058-discovered import-side-effect problem, and NOT a
// new/different simulation) to recover the real per-trade qty/notional-derived $ PnL. This reruns the
// production-function-only mirrored loop (still zero production code touched), not a fresh
// re-derivation of a different trade set — self-checked below against the same RT-056/057 constants
// before any month-by-month number is trusted.
export const BALANCE = 500;

async function main() {
  const csvPath = path.resolve(process.cwd(), 'apps/bot/data/xgbAuditDataset.csv');
  const reportPath = path.resolve(process.cwd(), 'apps/bot/reports/RT-059-report.md');
  const dataDir = path.resolve(process.cwd(), 'apps/bot/data');
  const targetR = DEFAULT_FVG_STRATEGY_CONFIG.targetRMultiple;

  console.log(`Doi chieu voi ${csvPath} (dataset RT-058 co san) de xac nhan cung 1217 lenh...`);
  const csvRowCount = (await readFile(csvPath, 'utf8')).trim().split('\n').length - 1;
  if (csvRowCount !== 1217) {
    console.error(`CORRECTION_REQUIRED: xgbAuditDataset.csv co ${csvRowCount} dong, khong phai 1217 — DUNG lai.`);
    process.exitCode = 1;
    return;
  }

  console.log('Dang chay lai mirrored simulation (giong Part A, KHONG qua simulateOneYearNearLive.ts) de lay PnL$ chinh xac tung lenh...');
  const allData = await loadAllSymbolData(dataDir);
  const { closed } = runInstrumentedSimulation(allData, targetR);

  let totalPnl = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  for (const t of closed) {
    totalPnl += t.pnl;
    if (t.pnl > 0) grossProfit += t.pnl;
    else if (t.pnl < 0) grossLoss += Math.abs(t.pnl);
  }
  const totalPf = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

  console.log(`\nn=${closed.length}  PnL=$${totalPnl.toFixed(2)}  PF=${totalPf.toFixed(3)}`);
  console.log('Doi chieu RT-056/057 Config B (chot): n=1217, PnL=$2628.76, PF=1.551');

  const matches = closed.length === 1217 && Math.abs(totalPnl - 2628.76) < 0.01 && Math.abs(totalPf - 1.551) < 0.001;
  if (!matches) {
    console.error('\nCORRECTION_REQUIRED: mirrored simulation (Part B) KHONG khop voi RT-056/057 da chot — DUNG lai, khong ghi bang thang.');
    process.exitCode = 1;
    return;
  }
  console.log('-> KHOP 100%: PnL$ chinh xac tung lenh dung duoc cho breakdown theo thang.');

  const monthKey = (ts: number) => {
    const d = new Date(ts);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  };

  const byMonth = new Map<string, { pnl: number; won: number }[]>();
  for (const t of closed) {
    const m = monthKey(t.features.entryTimestampUtc);
    if (!byMonth.has(m)) byMonth.set(m, []);
    byMonth.get(m)!.push({ pnl: t.pnl, won: t.outcome === 'TP' ? 1 : 0 });
  }
  const months = Array.from(byMonth.keys()).sort();

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

  let md = '\n## Part B — Audit regime theo thang (khong can model, tren toan bo 1217 lenh goc RT-058)\n\n';
  md +=
    'PnL$/tung lenh lay tu viec chay lai mirrored simulation da tu-kiem-tra cua Part A (xgbFeatureAuditV2.ts, KHONG qua simulateOneYearNearLive.ts) — ' +
    'khop 100% voi RT-056/057 Config B da chot ' +
    `(n=${closed.length}, PnL=$${totalPnl.toFixed(2)}, PF=${totalPf.toFixed(3)}). ` +
    'Mot phien ban dau thu tai-tao PnL$ CHI tu cac cot da co san trong apps/bot/data/xgbAuditDataset.csv (slPct/breaksKeyZone/won, khong chay lai gi) bang cong thuc risk-based — ' +
    'tu-kiem-tra phat hien lech $1.71 (0.065%) so voi tong da chot, chung to mot so lenh bi clamp boi maxMarginPct hoac scale-down boi exposure tracker (cong thuc do khong the bieu dien). ' +
    'Da bao cao cho nguoi dung; nguoi dung chon chay lai mirrored simulation da tu-kiem-tra (giong het Part A, khong dung lai) de lay PnL$ chinh xac thay vi dung cong thuc gan dung.\n\n';

  md += '| Thang | n | Winrate | Wilson 90% CI | PF | PnL$ |\n';
  md += '|---|---|---|---|---|---|\n';
  for (const m of months) {
    const trades = byMonth.get(m)!;
    const n = trades.length;
    const wins = trades.reduce((s, t) => s + t.won, 0);
    const gp = trades.filter((t) => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
    const gl = trades.filter((t) => t.pnl < 0).reduce((s, t) => s + Math.abs(t.pnl), 0);
    const pf = gl > 0 ? gp / gl : gp > 0 ? Infinity : 0;
    const pnl = trades.reduce((s, t) => s + t.pnl, 0);
    const ci = wilsonInterval(wins, n);
    md += `| ${m} | ${n} | ${fmtPct(ci.p)} | [${fmtPct(ci.lower)}-${fmtPct(ci.upper)}] | ${Number.isFinite(pf) ? pf.toFixed(2) : 'inf'} | $${pnl.toFixed(2)} |\n`;
  }

  const pfValues = months
    .map((m) => {
      const trades = byMonth.get(m)!;
      const gp = trades.filter((t) => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
      const gl = trades.filter((t) => t.pnl < 0).reduce((s, t) => s + Math.abs(t.pnl), 0);
      return gl > 0 ? gp / gl : gp > 0 ? Infinity : 0;
    })
    .filter((pf) => Number.isFinite(pf));
  const winRates = months.map((m) => {
    const trades = byMonth.get(m)!;
    return trades.reduce((s, t) => s + t.won, 0) / trades.length;
  });
  const meanPf = pfValues.reduce((a, b) => a + b, 0) / pfValues.length;
  const stdPf = Math.sqrt(pfValues.reduce((s, x) => s + (x - meanPf) ** 2, 0) / pfValues.length);
  const meanWr = winRates.reduce((a, b) => a + b, 0) / winRates.length;
  const stdWr = Math.sqrt(winRates.reduce((s, x) => s + (x - meanWr) ** 2, 0) / winRates.length);

  md += `\nPF theo thang: trung binh=${meanPf.toFixed(2)}, std=${stdPf.toFixed(2)}, min=${Math.min(...pfValues).toFixed(2)}, max=${Math.max(...pfValues).toFixed(2)} (${pfValues.length}/${months.length} thang co PF huu han).\n`;
  md += `Winrate theo thang: trung binh=${fmtPct(meanWr)}, std=${fmtPct(stdWr)}, min=${fmtPct(Math.min(...winRates))}, max=${fmtPct(Math.max(...winRates))}.\n\n`;

  md += '### Nhan dinh (Gia thuyet 3 — regime drift)\n\n';
  md +=
    '_(Dien thu cong sau khi doc bang tren: PF/winrate dao dong giua cac thang co doc lap voi lua chon model/feature khong — neu co, ung ho Gia thuyet 3 rang su bat on cua AUC o Phan A la do regime drift that qua thoi gian, cong huong voi co mau mong/fold, khong phai loi cach train. KHONG ket luan thay Gia thuyet 1/2 — chi trinh bay bang chung ung ho/phan bac tung gia thuyet dua tren so do duoc.)_\n';

  await appendFile(reportPath, md, 'utf8');
  console.log(`\nDa append Part B vao ${reportPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
