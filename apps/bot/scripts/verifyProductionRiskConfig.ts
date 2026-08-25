import path from 'node:path';
import { DEFAULT_FVG_STRATEGY_CONFIG } from '../src/entry/fvgStrategyConfig.js';
import { resolveRiskPct } from '../src/positionSizing/riskConfig.js';
import { loadAllSymbolData, runSimulation, computeClosedPnl } from './simulateOneYearNearLive.js';

// TICKET-RT-057: re-runs the exact RT-056 Config B backtest, but sourcing risk% from the NEW
// production module (src/positionSizing/riskConfig.ts's resolveRiskPct/DEFAULT_RISK_CONFIG) instead
// of RT-056's ad-hoc local closure — confirms the production config produces byte-identical numbers
// to what was backtest-confirmed before landing it, per the ticket's explicit "Xac nhan" requirement.

const START_CAPITAL = 10000;

interface Summary {
  n: number;
  pnl: number;
  winRate: number;
  profitFactor: number;
}

function summarize(trades: ReturnType<typeof runSimulation>['closedTrades']): Summary {
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
  return { n: trades.length, pnl, winRate, profitFactor };
}

function computeMaxDrawdownPct(trades: ReturnType<typeof runSimulation>['closedTrades'], startCapital: number): number {
  let equity = startCapital;
  let peak = startCapital;
  let maxDrawdownDollar = 0;
  for (const t of trades) {
    equity += computeClosedPnl(t);
    if (equity > peak) peak = equity;
    const drawdown = peak - equity;
    if (drawdown > maxDrawdownDollar) maxDrawdownDollar = drawdown;
  }
  return (maxDrawdownDollar / startCapital) * 100;
}

async function main() {
  const dataDir = path.resolve(process.cwd(), 'apps/bot/data');
  const targetR = DEFAULT_FVG_STRATEGY_CONFIG.targetRMultiple;

  console.log('Dang load du lieu 1 nam (da fix RT-054)...');
  const allData = await loadAllSymbolData(dataDir);

  console.log('Chay backtest dung PRODUCTION riskConfig.ts (resolveRiskPct)...');
  const { closedTrades } = runSimulation(allData, targetR, (symbol, breaksKeyZone) => resolveRiskPct(symbol, breaksKeyZone));
  const filled = closedTrades.filter((t) => t.outcome !== 'STILL_OPEN');
  const s = summarize(filled);
  const maxDD = computeMaxDrawdownPct(filled, START_CAPITAL);

  console.log(`\nn=${s.n}  PnL=$${s.pnl.toFixed(2)}  PF=${Number.isFinite(s.profitFactor) ? s.profitFactor.toFixed(3) : 'inf'}  maxDD=${maxDD.toFixed(2)}%`);
  console.log('Doi chieu RT-056 Config B: n=1217, PnL=$2628.76, PF=1.551, maxDD=1.24%');

  const matches =
    s.n === 1217 && Math.abs(s.pnl - 2628.76) < 0.01 && Math.abs(s.profitFactor - 1.551) < 0.001 && Math.abs(maxDD - 1.24) < 0.01;
  console.log(matches ? '-> KHOP 100% voi RT-056 Config B.' : '-> LECH — CAN DIEU TRA truoc khi coi la chot.');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
