import {describe,expect,it} from 'vitest';
import type {CandleData} from '../regime/types.js';
import {detectObV2} from './obV2Research.js';
const c=(timestamp:number,open:number,close:number,high:number,low:number):CandleData=>({timestamp,open,close,high,low,volume:100});

describe('OB V2 lifecycle',()=>{
  it('does not trigger without a post-BOS retest',()=>{
    const five=[c(0,9,9,10,8),c(300000,11,11,15,10),c(600000,9,9,10,8),c(900000,11,9,11,9),c(1200000,9,12,12,9),c(1500000,12,16,16,12),c(1800000,16,17,18,16)];
    expect(detectObV2('BTCUSDT',five,[],'BULLISH',{mode:'OB_V2_LIFECYCLE',expiryBars:48,slBufferAtr:.1,atr:1,centralCostBps:6})).toBeNull();
  });
  it('rejects a post-BOS close through the far boundary',()=>{
    const five=[c(0,9,9,10,8),c(300000,11,11,15,10),c(600000,9,9,10,8),c(900000,11,9,11,9),c(1200000,9,12,12,9),c(1500000,12,16,16,12),c(1800000,10,8,10,7)];
    expect(detectObV2('BTCUSDT',five,[],'BULLISH',{mode:'OB_V2_LIFECYCLE',expiryBars:48,slBufferAtr:.1,atr:1,centralCostBps:6})).toBeNull();
  });
  it('mirrors structural FVG requirements for bearish candidates',()=>{
    const five=[c(0,10,10,11,9),c(300000,9,9,10,5),c(600000,10,10,11,9),c(900000,9,11,11,9),c(1200000,8,7,8,6),c(1500000,7,4,7,4)];
    expect(detectObV2('BTCUSDT',five,[],'BEARISH',{mode:'OB_V2_STRUCTURAL_RETEST',expiryBars:48,slBufferAtr:.1,atr:1,centralCostBps:6})).toBeNull();
  });
  it('emits lifecycle evidence without changing the null decision',()=>{
    const five=[c(0,9,9,10,8),c(300000,11,11,15,10),c(600000,9,9,10,8),c(900000,11,9,11,9),c(1200000,9,12,12,9),c(1500000,12,16,16,12),c(1800000,16,17,18,16)];const states:string[]=[];
    detectObV2('BTCUSDT',five,[],'BULLISH',{mode:'OB_V2_LIFECYCLE',expiryBars:48,slBufferAtr:.1,atr:1,centralCostBps:6},e=>states.push(e.state));
    expect(states).toContain('FORMED');
  });
});
