import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildBaselineConfig, runReplay, makeFillModel, computeMetrics, type ClosedTrade } from './ticket150BacktestExecutionRealismAudit.js';

type Scenario = 'ZERO_COST'|'ZERO_COST_REPEAT'|'LIGHT'|'CENTRAL'|'CONSERVATIVE';
const scenario=(process.env.T153B_SCENARIO??'') as Scenario;
if(!['ZERO_COST','ZERO_COST_REPEAT','LIGHT','CENTRAL','CONSERVATIVE'].includes(scenario)) throw new Error('Set T153B_SCENARIO');
const params={ZERO_COST:[0,0],ZERO_COST_REPEAT:[0,0],LIGHT:[1,1],CENTRAL:[2,2],CONSERVATIVE:[5,5]} as const;
const [slip,spread]=params[scenario];
const cfg={...buildBaselineConfig(),sameSideDuplicateGuardEnabled:true};
const out=path.resolve(process.cwd(),'data');
const stopStep=57833;
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const esc=(v:unknown)=>{const s=String(v??'');return /[",\n]/.test(s)?`"${s.replace(/"/g,'""')}"`:s};
function csv(file:string,rows:Record<string,unknown>[]):void{const h=Object.keys(rows[0]??{});writeFileSync(path.join(out,file),[h.join(','),...rows.map(r=>h.map(k=>esc(r[k])).join(','))].join('\n'));}

async function main():Promise<void>{
 const model=slip===0&&spread===0?null:makeFillModel(scenario,slip/10000,spread/10000);
 const replay=await runReplay(cfg,model,stopStep);
 const pnl=(t:ClosedTrade)=>replay.slippedPnlByEntryTs.get(`${t.symbol}|${t.entryTimestamp}`)??t.pnlUsdTheoretical;
 const m=computeMetrics(replay.trades,pnl,100),wins=replay.trades.filter(t=>pnl(t)>0).length;
 const fees=replay.trades.reduce((s,t)=>s+t.positionSize*cfg.takerFeeRate*2,0);
 const fillDrag=replay.trades.reduce((s,t)=>s+t.pnlUsdTheoretical-pnl(t),0);
 const grossPnl=replay.trades.reduce((s,t)=>s+t.pnlUsdTheoretical+t.positionSize*cfg.takerFeeRate*2,0);
 const runId=`T153B-${scenario}-${hash(JSON.stringify({commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),cfg,stopStep,slip,spread})).slice(0,12)}`;
 const summary={runId,scenario,status:'COMPLETED',dataQuality:'DQ-B — COMPARABLE_WITH_LIMITATIONS',signals:'NOT_INSTRUMENTED',submittedOrders:replay.trades.length,fills:replay.trades.length,closedTrades:m.n,wins,losses:m.n-wins,winRate:m.wr,profitFactor:m.pf,grossPnl,feeCost:fees,slippageCost:fillDrag*2/3,spreadCost:fillDrag/3,fundingCost:0,totalExecutionCost:fees+fillDrag,netPnl:m.netPnl,returnPct:m.netPnl,maxDdPct:m.maxDdPct,maxDdUsd:m.maxDdUsd,averageTrade:m.expectancy,finalEquity:m.finalBalance,sharpe:'NOT_SUPPORTED',stopStep,startTimestamp:1770779700000,endTimestamp:1786100400000,t152SameSideGuard:true,latency:'MISSING',funding:'MISSING',spreadData:spread===0?'NOT_APPLICABLE':'ASSUMED',slippageData:slip===0?'NOT_APPLICABLE':'ASSUMED',feesData:'MODELED_CONFIGURED_RATE'};
 writeFileSync(path.join(out,`ticket153b-${scenario.toLowerCase()}-summary.json`),JSON.stringify(summary,null,2)+'\n');
 const ledger=replay.trades.map((t,i)=>{const net=pnl(t),drag=t.pnlUsdTheoretical-net,adverse=(slip+spread/2)/10000,dir=t.side==='LONG'?1:-1;return{runId,scenario,tradeId:i+1,orderId:`${t.symbol}-${t.entryTimestamp}`,symbol:t.symbol,side:t.side,setup:t.setupType,regime:t.regime,entryTimestamp:t.entryTimestamp,exitTimestamp:t.exitTimestamp,referenceEntry:t.entryPriceTheoretical,executedEntry:t.entryPriceTheoretical*(1+dir*adverse),referenceExit:t.exitPriceTheoretical,executedExit:t.exitPriceTheoretical*(1-dir*adverse),exitReason:t.exitReason,positionSize:t.positionSize,feeCost:t.positionSize*cfg.takerFeeRate*2,slippageCost:drag*2/3,spreadCost:drag/3,fundingCost:0,totalExecutionCost:t.positionSize*cfg.takerFeeRate*2+drag,netPnl:net,dataQuality:'DQ-B — COMPARABLE_WITH_LIMITATIONS'};});
 csv(`ticket153b-${scenario.toLowerCase()}-ledger.csv`,ledger);
 let equity=100,peak=100;const curve=ledger.sort((a,b)=>Number(a.exitTimestamp)-Number(b.exitTimestamp)).map((r,i)=>{equity+=Number(r.netPnl);peak=Math.max(peak,equity);return{runId,scenario,index:i+1,timestamp:r.exitTimestamp,equity,drawdownUsd:peak-equity,drawdownPct:peak?((peak-equity)/peak)*100:0};});csv(`ticket153b-${scenario.toLowerCase()}-equity-drawdown.csv`,curve);
 console.log(JSON.stringify(summary,null,2));
}
main().catch(e=>{console.error(e);process.exit(1)});
