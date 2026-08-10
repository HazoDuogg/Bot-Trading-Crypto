import type { CandleData } from '../regime/types.js';
import type { Direction } from '../entry/types.js';
import { detectSwingPoints, latestSwingPointBefore } from '../entry/detectors/swingPoints.js';
import { detectMarketStructureShiftWithLevel } from '../entry/detectors/marketStructureShift.js';

export type ObResearchMode='OB_V2_LIFECYCLE'|'OB_V2_STRUCTURAL_RETEST'|'OB_V2_STRUCTURAL_RETEST_REWARD';
export type ObLifecycleState='FORMED'|'BOS_CONFIRMED'|'WAIT_RETEST'|'RETESTED'|'WAIT_CONFIRMATION'|'TRIGGERED'|'INVALIDATED'|'EXPIRED';
export interface ObV2Config{mode:ObResearchMode;expiryBars:24|48|96;slBufferAtr:number;atr:number;centralCostBps:number}
export interface ObV2Result{zoneId:string;state:ObLifecycleState;side:'LONG'|'SHORT';high:number;low:number;sourceTimestamp:number;bosTimestamp:number;retestTimestamp:number;confirmationTimestamp:number;entryPrice:number;slPrice:number;structureBreakLevel:number;bodyAtr:number;volumeRatio:number;entryExtensionAtr:number;availableRewardR:number}
export interface ObLifecycleEvent{zoneId:string;state:ObLifecycleState;timestamp:number}

export function detectObV2(symbol:string,c5:CandleData[],c1:CandleData[],direction:Direction,config:ObV2Config,onEvent?:(event:ObLifecycleEvent)=>void):ObV2Result|null{
  const swings=detectSwingPoints(c5,2),side=direction==='BULLISH'?'LONG':'SHORT',structural=config.mode!=='OB_V2_LIFECYCLE';
  const oldestCandidate=Math.max(2,c5.length-1-config.expiryBars-10);
  for(let i=c5.length-3;i>=oldestCandidate;i--){
    const source=c5[i],opposite=direction==='BULLISH'?source.close<source.open:source.close>source.open;if(!opposite)continue;const zoneId=`${symbol}:OBV2:${side}:${source.timestamp}:${source.high}:${source.low}`;onEvent?.({zoneId,state:'FORMED',timestamp:source.timestamp});
    const swing=latestSwingPointBefore(swings,direction==='BULLISH'?'HIGH':'LOW',i);if(!swing)continue;
    const limit=Math.min(i+(structural?3:10),c5.length-1);let bos=-1;
    for(let j=i+1;j<=limit;j++){if(direction==='BULLISH'?c5[j].low<source.low:c5[j].high>source.high)break;if(direction==='BULLISH'?c5[j].close>swing.price:c5[j].close<swing.price){bos=j;break;}}
    if(bos<0)continue;onEvent?.({zoneId,state:'BOS_CONFIRMED',timestamp:c5[bos].timestamp});
    if(structural){const fvg=c5[i+2]&&(direction==='BULLISH'?c5[i+2].low>source.high:c5[i+2].high<source.low);if(!fvg)continue;}
    const age=c5.length-1-bos;if(age>config.expiryBars){onEvent?.({zoneId,state:'EXPIRED',timestamp:c5.at(-1)!.timestamp});continue;}
    const after=c5.slice(bos+1),invalid=after.some(c=>direction==='BULLISH'?c.close<source.low:c.close>source.high);if(invalid){onEvent?.({zoneId,state:'INVALIDATED',timestamp:c5.at(-1)!.timestamp});continue;}
    const retestOffset=after.findIndex(c=>c.low<=source.high&&c.high>=source.low);if(retestOffset<0){onEvent?.({zoneId,state:'WAIT_RETEST',timestamp:c5.at(-1)!.timestamp});continue;}const retestIndex=bos+1+retestOffset,retest=c5[retestIndex];onEvent?.({zoneId,state:'RETESTED',timestamp:retest.timestamp});
    const afterRetest=c1.filter(c=>c.timestamp>=retest.timestamp+300_000),rejectionIndex=afterRetest.findIndex(c=>c.low<=source.high&&c.high>=source.low&&(direction==='BULLISH'?c.close>c.open:c.close<c.open));if(rejectionIndex<0)continue;
    const confirmationWindow=afterRetest.slice(rejectionIndex),mss=detectMarketStructureShiftWithLevel(confirmationWindow,direction,{fractalN:2});if(!mss)continue;
    const confirmation=confirmationWindow[mss.index],late=confirmationWindow.length-1-mss.index;if(late>=5)continue;
    const entry=confirmation.close,sl=direction==='BULLISH'?source.low-config.slBufferAtr*config.atr:source.high+config.slBufferAtr*config.atr,r=Math.abs(entry-sl);if(!r)continue;
    const prior=c5.slice(Math.max(0,i-50),i),boundary=direction==='BULLISH'?Math.max(...prior.map(c=>c.high)):Math.min(...prior.map(c=>c.low)),reward=direction==='BULLISH'?boundary-entry:entry-boundary,extension=(direction==='BULLISH'?entry-source.high:source.low-entry)/config.atr,availableRewardR=reward/r;
    if(config.mode==='OB_V2_STRUCTURAL_RETEST_REWARD'&&(extension>1||availableRewardR<1.2||1.2*r/entry*10_000<=config.centralCostBps))continue;
    const bosCandle=c5[bos],volumeMean=c5.slice(Math.max(0,bos-20),bos).reduce((s,c)=>s+c.volume,0)/Math.max(1,Math.min(20,bos)),range=bosCandle.high-bosCandle.low;
    onEvent?.({zoneId,state:'TRIGGERED',timestamp:confirmation.timestamp});return{zoneId,state:'TRIGGERED',side,high:source.high,low:source.low,sourceTimestamp:source.timestamp,bosTimestamp:bosCandle.timestamp,retestTimestamp:retest.timestamp,confirmationTimestamp:confirmation.timestamp,entryPrice:entry,slPrice:sl,structureBreakLevel:mss.levelPrice,bodyAtr:Math.abs(bosCandle.close-bosCandle.open)/config.atr,volumeRatio:bosCandle.volume/Math.max(volumeMean,1e-12),entryExtensionAtr:extension,availableRewardR};
  }
  return null;
}
