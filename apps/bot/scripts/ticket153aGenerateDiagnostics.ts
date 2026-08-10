import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const data = path.resolve(process.cwd(), 'data');
const ohlcv = path.join(data, 'ohlcv');
function hash(file: string): string { return createHash('sha256').update(readFileSync(file)).digest('hex'); }
function parse(file: string): Record<string,string>[] { const lines=readFileSync(file,'utf8').trim().split(/\r?\n/); const h=lines.shift()!.split(','); return lines.map((line)=>Object.fromEntries(line.split(',').map((v,i)=>[h[i],v]))); }
function csv(file:string,rows:Record<string,unknown>[]):void{const h=Object.keys(rows[0]);writeFileSync(path.join(data,file),[h.join(','),...rows.map(r=>h.map(k=>String(r[k]??'')).join(','))].join('\n'));}

const files = readdirSync(ohlcv).filter((f)=>f.endsWith('.csv')).sort();
const fingerprint = {
  gitCommit: execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
  compiledOrchestratorSha256: hash(path.resolve(process.cwd(),'apps/bot/dist/orchestrator/orchestrator.js')),
  datasetFiles: Object.fromEntries(files.map((f)=>[f,{sha256:hash(path.join(ohlcv,f)),firstTimestamp:readFileSync(path.join(ohlcv,f),'utf8').split(/\r?\n/)[1].split(',')[0],lastTimestamp:readFileSync(path.join(ohlcv,f),'utf8').trim().split(/\r?\n/).at(-1)!.split(',')[0]}])),
  lockedReplay: { stopStep:54523,startTimestamp:1770779700000,endTimestamp:1785107100000,startBalance:100,symbols:['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT'],matrixV2:true,ood:{mode:'RISK_REDUCTION',emaRatioSlowThreshold:1.037776,riskReductionMultiplier:0.3},risk:{riskDollarOrPercent:15,riskPoolMaxPct:15,maxMarginCap:37.5,leverage:30,maxConcurrentPositionsPerSymbol:2,sameSideDuplicateGuardEnabled:false},fee:{takerFeeRate:0.0004,roundTripRate:0.0008},execution:{enabled:false,slippageBpsPerSide:0,spreadBpsTotal:0,latency:'DISABLED',funding:'DISABLED'}},
  preFixReplay: { sameSideDuplicateGuardEnabled:true,trades:211,pf:1.4458,finalBalance:741.0174 },
};
writeFileSync(path.join(data,'ticket153a-baseline-fingerprint.json'),JSON.stringify(fingerprint,null,2)+'\n');

csv('ticket153a-first-divergence.csv',[{firstDivergenceStep:6766,firstDivergenceTimestamp:1770780000000,isoUtc:'2026-02-11T03:20:00.000Z',symbol:'BTCUSDT',legacyEvent:'CONTINUE_LEGACY_ADMISSION_PIPELINE',t153Event:'ADMISSION_BLOCK:SAME_SIDE_POSITION_BLOCKED:SHORT:openSameSideCount=1',rootCauseCategory:'BUILD_ARTIFACT',rootCause:'T152 same-side duplicate guard was added after the locked T150 checkpoint; T153 rebuilt dist from current HEAD instead of pinning pre-T152 replay semantics.'}]);

const legacy=parse(path.join(data,'ticket153a-legacy-event-trace.csv')).filter(r=>r.eventType==='OPEN');
const current=parse(path.join(data,'ticket153a-t153-event-trace.csv')).filter(r=>r.eventType==='OPEN');
const currentKeys=new Set(current.map(r=>`${r.symbol}|${r.candidateSide}|${r.candidateSetup}|${r.timestamp}`));
const legacyKeys=new Set(legacy.map(r=>`${r.symbol}|${r.candidateSide}|${r.candidateSetup}|${r.timestamp}`));
const rows:Record<string,unknown>[]=[];
for(const r of legacy){const key=`${r.symbol}|${r.candidateSide}|${r.candidateSetup}|${r.timestamp}`;rows.push({matchKey:key,status:currentKeys.has(key)?'MATCH':'MISSING_FROM_PRE_FIX_T153',symbol:r.symbol,side:r.candidateSide,setup:r.candidateSetup,legacyEntryTimestamp:r.timestamp,t153EntryTimestamp:currentKeys.has(key)?r.timestamp:''});}
for(const r of current){const key=`${r.symbol}|${r.candidateSide}|${r.candidateSetup}|${r.timestamp}`;if(!legacyKeys.has(key))rows.push({matchKey:key,status:'EXTRA_IN_PRE_FIX_T153',symbol:r.symbol,side:r.candidateSide,setup:r.candidateSetup,legacyEntryTimestamp:'',t153EntryTimestamp:r.timestamp});}
csv('ticket153a-trade-reconciliation.csv',rows);
