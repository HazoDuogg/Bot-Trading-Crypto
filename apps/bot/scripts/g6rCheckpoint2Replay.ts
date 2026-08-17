/** G6R Checkpoint 2 — full-path baseline funnel. Research-only; never changes a decision. */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildBaselineConfig, makeFillModel, runReplay, type ReplayVariantHooks } from './ticket150BacktestExecutionRealismAudit.js';
import { MarketRegime, type CandleData } from '../dist/regime/types.js';
import { EntryConfig } from '../dist/entry/config.js';
import { detectOrderBlock } from '../dist/entry/detectors/orderBlock.js';
import { detectFairValueGap } from '../dist/entry/detectors/fairValueGap.js';
import { detectLiquiditySweep } from '../dist/entry/detectors/liquiditySweep.js';
import { detectBoxBreakout } from '../dist/entry/detectors/boxBreakout.js';
import { detectMarketStructureShift } from '../dist/entry/detectors/marketStructureShift.js';
import { lastDefined, wilderATRSeries, wilderDIDirectionSeries } from '../dist/regime/indicators.js';
import { RegimeConfig } from '../dist/regime/config.js';
import { candidateKey, evaluationId, reconcileG6rFunnel, type G6rCandidateRow, type G6rEvaluationRow, type G6rEventRow, type G6rFunnelLedgers, type G6rOutcome, type G6rSetupType, type G6rSide } from './g6rFullPathFunnel.js';

const STOP_STEP = 57833;
const OUT_DIR = path.resolve(process.cwd(), 'data/g6r-runs');
const DQ = 'DQ-B — COMPARABLE_WITH_LIMITATIONS' as const;

interface Pending {
  evaluationId: string; symbol: string; timestamp: number; regime: string; sequence: number;
  candidates: G6rCandidateRow[]; events: G6rEventRow[]; funnel: Array<{ stage: string; passed: boolean; reason?: string; setupType?: string }>;
}

const evaluations: G6rEvaluationRow[] = [];
const candidates: G6rCandidateRow[] = [];
const events: G6rEventRow[] = [];
const pending = new Map<string, Pending>();
const regimeByStep = new Map<string, { regime: MarketRegime; adxDirection1h: 'UP'|'DOWN'|'FLAT'|undefined; bbWidthPercentile15m:number|undefined; volumeZScore5m:number|undefined }>();
const admittedTradeKeys: string[] = [];

const lookup = (symbol: string, timestamp: number): string => `${symbol}|${timestamp}`;
function emit(p: Pending, outcome: G6rOutcome, stage: G6rEventRow['stage'], reason: string, key: string | null): void {
  const c=key===null?undefined:p.candidates.find((row)=>row.candidateKey===key);
  p.events.push({ eventId: `${p.evaluationId}|${p.sequence}`, evaluationId: p.evaluationId, candidateKey: key, symbol:p.symbol,side:c?.side??null,regime:p.regime,setupType:c?.setupType??null,evaluationTimestamp:p.timestamp,sourceTimestamp:c?.sourceTimestamp??null,decisionTimestamp:p.timestamp,stage,outcome,reason,entryPrice:c?.entryPrice??null,slPrice:c?.slPrice??null,dataQuality:DQ,sequence:p.sequence++ });
}
function addCandidate(p: Pending, setupType: G6rSetupType, side: G6rSide, sourceTimestamp: number, entryPrice: number, slPrice: number): G6rCandidateRow {
  const key = candidateKey(p.symbol, side, setupType, p.timestamp, sourceTimestamp);
  const row: G6rCandidateRow = { candidateKey: key, evaluationId: p.evaluationId, symbol: p.symbol, side, regime: p.regime, setupType, sourceTimestamp, decisionTimestamp: p.timestamp, entryPrice, slPrice, dataQuality: DQ };
  p.candidates.push(row); return row;
}
function trendCandidate(p: Pending, setupType: 'OB'|'FVG'|'SWEEP', side: G6rSide, sourceIndex: number, rawSl: number, candles5m: CandleData[], candles1m: CandleData[], obBuffer: number): G6rCandidateRow | null {
  const sourceTimestamp = candles5m[sourceIndex].timestamp;
  const mssWindow = candles1m.filter((c) => c.timestamp >= sourceTimestamp);
  const direction = side === 'LONG' ? 'BULLISH' : 'BEARISH';
  const mssIndex = detectMarketStructureShift(mssWindow, direction, { fractalN: EntryConfig.FRACTAL_N });
  if (mssIndex === null || mssWindow.length - 1 - mssIndex >= EntryConfig.MSS_STALENESS_TOLERANCE_CANDLES) return null;
  const atr = lastDefined(wilderATRSeries(candles5m, RegimeConfig.ATR_PERIOD_5M));
  if (atr === undefined) return null;
  const buffer = atr * (setupType === 'OB' ? obBuffer : EntryConfig.SL_BUFFER_ATR_MULTIPLIER);
  return addCandidate(p, setupType, side, sourceTimestamp, mssWindow[mssIndex].close, side === 'LONG' ? rawSl - buffer : rawSl + buffer);
}
function analyzeRaw(p: Pending, ctx: Parameters<NonNullable<ReplayVariantHooks['onBeforeProcessCandle']>>[0]): void {
  const shadow = regimeByStep.get(lookup(ctx.symbol, ctx.timestamp));
  if (!shadow) throw new Error(`G6R_CP2_MISSING_REGIME_CONTEXT ${ctx.symbol}|${ctx.timestamp}`);
  const cfg = ctx.config.entryRouterConfig;
  const trendStyle = shadow.regime === MarketRegime.TREND_RIDER || (shadow.regime === MarketRegime.NEUTRAL_TRANSITION && cfg.entryStyleForNeutral === 'TREND_STYLE');
  const boxStyle = shadow.regime === MarketRegime.SIDEWAY_SCALPER || shadow.regime === MarketRegime.COMPRESSION || (shadow.regime === MarketRegime.NEUTRAL_TRANSITION && cfg.entryStyleForNeutral === 'SIDEWAY_STYLE');
  if (trendStyle && shadow.adxDirection1h !== undefined && shadow.adxDirection1h !== 'FLAT') {
    const direction = shadow.adxDirection1h === 'UP' ? 'BULLISH' : 'BEARISH'; const side: G6rSide = direction === 'BULLISH' ? 'LONG' : 'SHORT';
    const ob = cfg.obEnabled === false || cfg.obDisabledSymbols.includes(ctx.symbol) ? null : detectOrderBlock(ctx.input.candles5m, direction, { fractalN: EntryConfig.FRACTAL_N, lookforwardK: cfg.obBosLookforwardK });
    const fvg = detectFairValueGap(ctx.input.candles5m, direction);
    const sweep = detectLiquiditySweep(ctx.input.candles5m, direction, { fractalN: EntryConfig.FRACTAL_N, wickRatioThreshold: EntryConfig.LIQUIDITY_SWEEP_WICK_RATIO_THRESHOLD });
    const found: Array<{ type:'OB'|'FVG'|'SWEEP'; sourceIndex:number; rawSl:number; row:G6rCandidateRow|null }> = [];
    if (ob) found.push({ type:'OB', sourceIndex:ob.candleIndex, rawSl:side==='LONG'?ob.low:ob.high, row:null });
    if (fvg) found.push({ type:'FVG', sourceIndex:fvg.candleIndex, rawSl:side==='LONG'?fvg.bottom:fvg.top, row:null });
    if (sweep) { const c=ctx.input.candles5m[sweep.candleIndex]; found.push({ type:'SWEEP', sourceIndex:sweep.candleIndex, rawSl:side==='LONG'?c.low:c.high, row:null }); }
    const selected = found[0];
    if (selected) selected.row=trendCandidate(p,selected.type,side,selected.sourceIndex,selected.rawSl,ctx.input.candles5m,ctx.input.candles1m,cfg.obSlBufferAtrMultiplier);
    for (const type of ['OB','FVG','SWEEP'] as const) { const f=found.find((x)=>x.type===type); emit(p,f?'DETECTOR_FOUND':'DETECTOR_NOT_FOUND','RAW_DETECTOR_EVALUATION',f?`${type}_FOUND`:`${type}_NOT_FOUND`,f?.row?.candidateKey??null); }
    for (const f of found) emit(p, f===selected?'SELECTED_BY_ROUTER':'PREEMPTED_BY_HIGHER_PRIORITY','ROUTER_SELECTION',f===selected?'CASCADE_PRIORITY':'HIGHER_PRIORITY_FOUND',f.row?.candidateKey??null);
    if (selected) emit(p,selected.row?'MSS_PASS':'MSS_FAIL','MSS',selected.row?'MSS_CONFIRMED':'MSS_NOT_CONFIRMED_OR_STALE',selected.row?.candidateKey??null);
  } else if (boxStyle) {
    const b=shadow.bbWidthPercentile15m===undefined||shadow.volumeZScore5m===undefined?null:detectBoxBreakout(ctx.input.candles15m,ctx.input.candles5m,shadow.bbWidthPercentile15m,shadow.volumeZScore5m,{boxLookbackM:EntryConfig.BOX_LOOKBACK_M,maxBbwPercentile:EntryConfig.BOX_MAX_BBW_PERCENTILE,minBodyRatio:EntryConfig.BOX_BREAKOUT_MIN_BODY_RATIO,minVolumeZScore:EntryConfig.BOX_BREAKOUT_MIN_VOLUME_ZSCORE});
    if(b){const side:G6rSide=b.direction==='UP'?'LONG':'SHORT';const row=addCandidate(p,'BOX_BREAKOUT',side,ctx.input.candles5m[b.breakoutCandleIndex].timestamp,ctx.input.candles5m[b.breakoutCandleIndex].close,b.direction==='UP'?b.boxLow:b.boxHigh);emit(p,'DETECTOR_FOUND','RAW_DETECTOR_EVALUATION','BOX_BREAKOUT_FOUND',row.candidateKey);emit(p,'SELECTED_BY_ROUTER','ROUTER_SELECTION','BOX_BREAKOUT_SELECTED',row.candidateKey);}else emit(p,'DETECTOR_NOT_FOUND','RAW_DETECTOR_EVALUATION','BOX_BREAKOUT_NOT_FOUND',null);
  }
}

function finalize(p: Pending, terminalOutcome: G6rEvaluationRow['terminalOutcome'], reason: string, key: string|null): void {
  emit(p,terminalOutcome,'ADMISSION',reason,key);
  evaluations.push({ evaluationId:p.evaluationId,symbol:p.symbol,regime:p.regime,evaluationTimestamp:p.timestamp,routeInvocationOrdinal:0,terminalOutcome,terminalReason:reason,dataQuality:DQ });
  candidates.push(...p.candidates); events.push(...p.events);
}

const hooks: ReplayVariantHooks = {
  onStepContext: (ctx) => regimeByStep.set(lookup(ctx.symbol,ctx.timestamp),{regime:ctx.regime,adxDirection1h:ctx.adxDirection1h,bbWidthPercentile15m:ctx.bbWidthPercentile15m,volumeZScore5m:ctx.volumeZScore5m}),
  onBeforeProcessCandle: (ctx) => { const s=regimeByStep.get(lookup(ctx.symbol,ctx.timestamp)); if(!s) throw new Error('missing shadow context'); const id=evaluationId(ctx.symbol,ctx.timestamp,s.regime,0); const p:Pending={evaluationId:id,symbol:ctx.symbol,timestamp:ctx.timestamp,regime:s.regime,sequence:0,candidates:[],events:[],funnel:[]}; pending.set(lookup(ctx.symbol,ctx.timestamp),p); analyzeRaw(p,ctx); },
  onFunnelEvent: (symbol,timestamp,event) => { const p=pending.get(lookup(symbol,timestamp)); if(!p) throw new Error('orphan funnel event'); p.funnel.push(event as never); },
  onMomentumGateEvaluation: (e) => { const x=e as {symbol:string;timestamp:number;side:G6rSide;setupType:G6rSetupType;passed:boolean;entryPriceCandidate:number;slPriceCandidate:number}; if(!x.passed) return; const p=pending.get(lookup(x.symbol,x.timestamp)); if(p&&!p.candidates.some((c)=>c.setupType===x.setupType&&c.side===x.side)) addCandidate(p,x.setupType,x.side,x.timestamp,x.entryPriceCandidate,x.slPriceCandidate); },
  onAfterProcessCandle: (ctx) => { const p=pending.get(lookup(ctx.symbol,ctx.timestamp)); if(!p) throw new Error('missing pending evaluation'); const open=ctx.result.events.find((e)=>e.type==='OPEN'); const skipped=ctx.result.events.find((e)=>e.type==='SKIPPED'); if(open&&open.type==='OPEN'){ let c=p.candidates.find((x)=>x.setupType===open.setupType&&x.side===open.side); if(!c)c=addCandidate(p,open.setupType,open.side,ctx.timestamp,open.entryPrice,open.slPrice); admittedTradeKeys.push(`${open.entryTimestamp}|${open.symbol}|${open.side}`); finalize(p,'ADMITTED_AS_TRADE','OPEN_EVENT',c.candidateKey); } else if(ctx.stateBefore.openPositions.length>=ctx.config.maxConcurrentPositionsPerSymbol) finalize(p,'BLOCKED_BY_SAME_SIDE_OR_CONCURRENCY','MAX_CONCURRENT_POSITIONS',null); else if(skipped&&skipped.type==='SKIPPED') finalize(p,skipped.reason==='RISK_POOL_EXCEEDED'||skipped.reason==='MAX_TOTAL_MARGIN_EXCEEDED'?'BLOCKED_BY_RISK_OR_MARGIN':'BLOCKED_BY_REGIME_OR_HTF',skipped.reason,null); else { const last=p.funnel[p.funnel.length-1]; finalize(p,last?.stage==='MSS'&&!last.passed?'MSS_FAIL':p.candidates.length===0?'DETECTOR_NOT_FOUND':'BLOCKED_BY_REGIME_OR_HTF',last?.reason??'NO_ADMITTED_CANDIDATE',p.candidates[0]?.candidateKey??null); } pending.delete(lookup(ctx.symbol,ctx.timestamp)); },
};

const csv=(rows:Record<string,unknown>[])=>rows.length===0?'':`${Object.keys(rows[0]).join(',')}\n${rows.map(r=>Object.keys(rows[0]).map(k=>JSON.stringify(r[k]??'')).join(',')).join('\n')}\n`;
async function main():Promise<void>{
  const config={...buildBaselineConfig(),sameSideDuplicateGuardEnabled:true};
  const replay=await runReplay(config,makeFillModel('CENTRAL',2/10000,2/10000),STOP_STEP,hooks);
  const ledgers:G6rFunnelLedgers={evaluations,candidates,events}; const reconciliation=reconcileG6rFunnel(ledgers); const {admittedCandidateKeys,...reconciliationCounts}=reconciliation;
  const canonical=new Set(replay.trades.map(t=>`${t.entryTimestamp}|${t.symbol}|${t.side}`)); const admitted=new Set(admittedTradeKeys);
  const onlyAdmitted=[...admitted].filter(k=>!canonical.has(k)); const onlyTrades=[...canonical].filter(k=>!admitted.has(k));
  if(canonical.size!==211||onlyTrades.length) throw new Error(`G6R_CP2_ADMISSION_PARITY_FAILED canonical=${canonical.size} admitted=${admitted.size} openAtStop=${onlyAdmitted.length} onlyTrades=${onlyTrades.length}`);
  mkdirSync(OUT_DIR,{recursive:true});
  writeFileSync(path.join(OUT_DIR,'g6r-cp2-evaluations.csv'),csv(evaluations as unknown as Record<string,unknown>[]));
  writeFileSync(path.join(OUT_DIR,'g6r-cp2-candidates.csv'),csv(candidates as unknown as Record<string,unknown>[]));
  writeFileSync(path.join(OUT_DIR,'g6r-cp2-events.csv'),csv(events as unknown as Record<string,unknown>[]));
  const countBy=(field:keyof G6rCandidateRow):Record<string,number>=>Object.fromEntries([...new Set(candidates.map(r=>String(r[field])))].sort().map(value=>[value,candidates.filter(r=>String(r[field])===value).length]));
  const byMonth:Record<string,number>={}; for(const row of candidates){const month=new Date(row.decisionTimestamp).toISOString().slice(0,7);byMonth[month]=(byMonth[month]??0)+1;}
  const terminalByOutcome:Record<string,number>={}; for(const row of evaluations)terminalByOutcome[row.terminalOutcome]=(terminalByOutcome[row.terminalOutcome]??0)+1;
  writeFileSync(path.join(OUT_DIR,'g6r-cp2-summary.json'),JSON.stringify({status:'PASS',reconciliation:{...reconciliationCounts,admittedCandidateKeyCount:admittedCandidateKeys.length},admissionParity:{freshClosedBaseline:canonical.size,admittedTotal:admitted.size,closedMatched:canonical.size-onlyTrades.length,openAtStop:onlyAdmitted.length,missingClosedTrades:onlyTrades.length,note:'Fresh C0 ledger contains closed trades only; admitted positions still open at STOP_STEP are retained separately and are not false unmatched rows.'},breakdown:{candidateBySetupType:countBy('setupType'),candidateBySymbol:countBy('symbol'),candidateByMonth:byMonth,candidateByRegime:countBy('regime'),candidateBySide:countBy('side'),terminalByOutcome}},null,2)+'\n');
}
main().catch(e=>{console.error(e);process.exit(1)});
