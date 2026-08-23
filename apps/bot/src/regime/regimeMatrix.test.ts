import { describe, it, expect } from 'vitest';
import { routeRegimeMatrix } from './regimeMatrix.js';

describe('routeRegimeMatrix', () => {
  it('routes UPTREND/UPTREND to TREND_PULLBACK LONG', () => {
    expect(routeRegimeMatrix('UPTREND', 'UPTREND')).toEqual({ strategy: 'TREND_PULLBACK', direction: 'LONG' });
  });

  it('routes DOWNTREND/DOWNTREND to TREND_PULLBACK SHORT', () => {
    expect(routeRegimeMatrix('DOWNTREND', 'DOWNTREND')).toEqual({ strategy: 'TREND_PULLBACK', direction: 'SHORT' });
  });

  it('routes SIDEWAY/SIDEWAY to RANGE_TRADING', () => {
    expect(routeRegimeMatrix('SIDEWAY', 'SIDEWAY')).toEqual({ strategy: 'RANGE_TRADING' });
  });

  it('routes UPTREND/SIDEWAY to BREAKOUT_WATCH LONG', () => {
    expect(routeRegimeMatrix('UPTREND', 'SIDEWAY')).toEqual({ strategy: 'BREAKOUT_WATCH', direction: 'LONG' });
  });

  it('routes DOWNTREND/SIDEWAY to BREAKOUT_WATCH SHORT', () => {
    expect(routeRegimeMatrix('DOWNTREND', 'SIDEWAY')).toEqual({ strategy: 'BREAKOUT_WATCH', direction: 'SHORT' });
  });

  it('routes conflicting H1 vs M15 direction to STANDBY', () => {
    expect(routeRegimeMatrix('UPTREND', 'DOWNTREND')).toEqual({ strategy: 'STANDBY' });
    expect(routeRegimeMatrix('DOWNTREND', 'UPTREND')).toEqual({ strategy: 'STANDBY' });
  });

  it('routes SIDEWAY H1 with trending M15 to STANDBY', () => {
    expect(routeRegimeMatrix('SIDEWAY', 'UPTREND')).toEqual({ strategy: 'STANDBY' });
    expect(routeRegimeMatrix('SIDEWAY', 'DOWNTREND')).toEqual({ strategy: 'STANDBY' });
  });
});
