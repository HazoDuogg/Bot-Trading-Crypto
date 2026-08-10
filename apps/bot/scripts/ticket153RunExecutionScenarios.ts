import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { config, runReplay, makeFillModel, computeMetrics, type ClosedTrade, type ReplayResult } from './ticket150BacktestExecutionRealismAudit.js';

const OUT = path.resolve(process.cwd(), 'data');
const FEE = config.takerFeeRate;
function esc(v: unknown): string { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }
function csv(file: string, rows: Record<string, unknown>[]): void { const h = Object.keys(rows[0] ?? {}); writeFileSync(path.join(OUT, file), [h.join(','), ...rows.map((r) => h.map((k) => esc(r[k])).join(','))].join('\n')); }
function pnl(replay: ReplayResult, t: ClosedTrade): number { return replay.slippedPnlByEntryTs.get(`${t.symbol}|${t.entryTimestamp}`) ?? t.pnlUsdTheoretical; }

async function main(): Promise<void> {
  const ideal = await runReplay(config, null, null);
  if (ideal.trades.length !== 319) throw new Error(`Locked baseline drift: expected 319, got ${ideal.trades.length}`);
  const defs = [
    { name: 'IDEAL', slip: 0, spread: 0, replay: ideal },
    { name: 'LIGHT', slip: 1, spread: 1, replay: await runReplay(config, makeFillModel('LIGHT', .0001, .0001), ideal.stopStep) },
    { name: 'CENTRAL', slip: 2, spread: 2, replay: await runReplay(config, makeFillModel('CENTRAL', .0002, .0002), ideal.stopStep) },
    { name: 'CONSERVATIVE', slip: 5, spread: 5, replay: await runReplay(config, makeFillModel('CONSERVATIVE', .0005, .0005), ideal.stopStep) },
  ];
  const summary = defs.map((d) => { const m = computeMetrics(d.replay.trades, (t) => pnl(d.replay, t), 100); const wins = d.replay.trades.filter((t) => pnl(d.replay, t) > 0).length; const fees = d.replay.trades.reduce((s,t)=>s+t.positionSize*FEE*2,0); const drag=d.replay.trades.reduce((s,t)=>s+t.pnlUsdTheoretical-pnl(d.replay,t),0); return { scenario:d.name,slippageBpsPerSide:d.slip,spreadBpsTotal:d.spread,dataQuality:d.name==='IDEAL'?'CONFIGURED_ACTUAL_RATE':'STRESS_ASSUMPTION',trades:m.n,wins,losses:m.n-wins,wr:m.wr.toFixed(4),pf:m.pf.toFixed(4),fees:fees.toFixed(4),slippageCost:(drag*2/3).toFixed(4),spreadCost:(drag/3).toFixed(4),fundingCost:'0.0000',netPnl:m.netPnl.toFixed(4),finalBalance:m.finalBalance.toFixed(4),maxDdPct:m.maxDdPct.toFixed(4),maxDdUsd:m.maxDdUsd.toFixed(4),latencyDataQuality:'INSUFFICIENT_DATA',fundingDataQuality:'INSUFFICIENT_DATA'}; });
  csv('ticket153-execution-scenario-summary.csv',summary);
  const costs:Record<string,unknown>[]=[]; for(const d of defs) for(const t of d.replay.trades){const net=pnl(d.replay,t),drag=t.pnlUsdTheoretical-net,adverse=(d.slip+d.spread/2)/10000,dir=((t.side==='LONG')?1:-1); costs.push({scenario:d.name,symbol:t.symbol,side:t.side,setup:t.setupType,regime:t.regime,exitReason:t.exitReason,entryTimestamp:t.entryTimestamp,exitTimestamp:t.exitTimestamp,referenceEntry:t.entryPriceTheoretical,executedEntry:t.entryPriceTheoretical*(1+dir*adverse),referenceExit:t.exitPriceTheoretical,executedExit:t.exitPriceTheoretical*(1-dir*adverse),feeCost:(t.positionSize*FEE*2).toFixed(4),slippageCost:(drag*2/3).toFixed(4),spreadCost:(drag/3).toFixed(4),fundingCost:'0.0000',totalExecutionCost:(t.positionSize*FEE*2+drag).toFixed(4),netPnl:net.toFixed(4)});} csv('ticket153-execution-cost-by-trade.csv',costs);
  const breakdown:Record<string,unknown>[]=[]; for(const d of defs) for(const [dimension,key] of [['symbol',(t:ClosedTrade)=>t.symbol],['side',(t:ClosedTrade)=>t.side],['setup',(t:ClosedTrade)=>t.setupType],['regime',(t:ClosedTrade)=>t.regime],['exitReason',(t:ClosedTrade)=>t.exitReason]] as const){const groups=new Map<string,ClosedTrade[]>();for(const t of d.replay.trades){const k=key(t);groups.set(k,[...(groups.get(k)??[]),t]);}for(const [group,trades] of groups){const m=computeMetrics(trades,(t)=>pnl(d.replay,t),0);breakdown.push({scenario:d.name,dimension,group,trades:m.n,wr:m.wr.toFixed(4),pf:Number.isFinite(m.pf)?m.pf.toFixed(4):'Infinity',netPnl:m.netPnl.toFixed(4)});}} csv('ticket153-execution-breakdown.csv',breakdown);
  console.log(summary);
}
main().catch((e)=>{console.error(e);process.exit(1)});
