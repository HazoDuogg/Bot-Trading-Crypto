import { describe, expect, it } from 'vitest';
import {
  computeBreakevenPlusFeeSlPrice,
  computeFeeBufferDollar,
  computeRealizedPnl,
  onCounterTrendTpHit,
  onSlHit,
  onTp1Hit,
  onTp2Hit,
  openPosition,
  type SlTpManagerInput,
} from './slTpManager.js';

// Only mandatory test kept per PM's updated test-scope memo (paper trading + analysis agent
// cover strategy correctness; this is the one money-formula check that can't be caught there).

const trendLongPlanA: SlTpManagerInput = {
  scenario: 'TREND',
  entryPrice: 100,
  slPrice: 99, // R = 1 (1% of entry)
  side: 'LONG',
  tpPlan: 'PLAN_A',
  positionSize: 990, // e.g. StaticMarginSizer: $33 margin * 30x leverage
  takerFeeRate: 0.0004, // 0.04%, TODO_CONFIRM per docs Mục 8
};

describe('Mục 6 — breakeven+fee SL covers ALL 3 tiers, and PNL stays >= 0 if SL is then hit', () => {
  it('moves SL to cover the full position fee liability, not just TP1\'s slice', () => {
    const afterTp1 = onTp1Hit(openPosition(trendLongPlanA));

    const expectedSl = computeBreakevenPlusFeeSlPrice(100, 'LONG', 0.0004);
    expect(afterTp1.currentSlPrice).toBeCloseTo(expectedSl, 10);
    expect(afterTp1.currentSlPrice).toBeCloseTo(100.08, 10); // 100 + 100*0.0004*2

    // Contrast vs the easy mistake: sizing the buffer off only TP1's 40% slice.
    const wrongTp1OnlyOffset = (trendLongPlanA.positionSize * 0.4 * trendLongPlanA.takerFeeRate * 2) / (trendLongPlanA.positionSize / 100);
    expect(afterTp1.currentSlPrice - 100).toBeGreaterThan(wrongTp1OnlyOffset);
  });

  it('nets a non-negative total PNL when TP1 fills then the rest exits at the breakeven+fee SL', () => {
    const opened = openPosition(trendLongPlanA);
    const afterTp1 = onTp1Hit(opened);
    const tp1Price = opened.tpLevels[0].price as number;

    const filledAtSl = onSlHit(afterTp1);
    expect(filledAtSl.closed).toBe(true);

    function legNetPnl(fraction: number, exitPrice: number): number {
      const gross = fraction * trendLongPlanA.positionSize * ((exitPrice - trendLongPlanA.entryPrice) / trendLongPlanA.entryPrice);
      const fee = fraction * trendLongPlanA.positionSize * trendLongPlanA.takerFeeRate * 2;
      return gross - fee;
    }

    const tp1Net = legNetPnl(0.4, tp1Price);
    const slLegNet = legNetPnl(0.6, afterTp1.currentSlPrice);
    const totalNet = tp1Net + slLegNet;

    expect(totalNet).toBeGreaterThanOrEqual(0);

    // Total fees paid across both legs equal the full-position fee buffer, regardless of the 2-fill split.
    const totalFees = 0.4 * trendLongPlanA.positionSize * trendLongPlanA.takerFeeRate * 2 + 0.6 * trendLongPlanA.positionSize * trendLongPlanA.takerFeeRate * 2;
    expect(totalFees).toBeCloseTo(computeFeeBufferDollar(trendLongPlanA.positionSize, trendLongPlanA.takerFeeRate), 10);
  });
});

// TICKET-010 — computeRealizedPnl, needed for backtest trade logging (pnlUsd/pnlPct were the 2
// fields missing in the old system). Not covered by the reduced-test-scope memo, but this is new
// money-math added for this ticket, so it gets the same rigor as Mục 6.
describe('computeRealizedPnl', () => {
  it('matches the Mục 6 mandatory test\'s own numbers for TP1-then-SL', () => {
    const afterTp1 = onTp1Hit(openPosition(trendLongPlanA));
    const closed = onSlHit(afterTp1);
    expect(computeRealizedPnl(closed, closed.currentSlPrice)).toBeCloseTo(4.4352, 4);
  });

  it('sums TP1 + TP2 + the remaining Runner portion at its own exit price', () => {
    const afterTp2 = onTp2Hit(onTp1Hit(openPosition(trendLongPlanA)));
    // TP1: 0.4*990*0.012=4.752, TP2: 0.3*990*0.025=7.425, remaining 0.3 at 105: 0.3*990*0.05=14.85
    // gross=27.027, fees=990*0.0004*2=0.792, net=26.235
    expect(computeRealizedPnl(afterTp2, 105)).toBeCloseTo(26.235, 6);
  });

  it('COUNTER_TREND: uses the tier price when TP hit, ignores the passed finalExitPrice', () => {
    const counterTrend: SlTpManagerInput = { ...trendLongPlanA, scenario: 'COUNTER_TREND', slPrice: 99.3 };
    const closed = onCounterTrendTpHit(openPosition(counterTrend));
    // TP = 100 + 1*0.7 = 100.7; gross=990*0.007=6.93; fees=0.792; net=6.138
    expect(computeRealizedPnl(closed, 999 /* unused, tier already filled */)).toBeCloseTo(6.138, 6);
  });

  it('COUNTER_TREND: uses finalExitPrice when SL hit instead (loss, still nets the same fee once)', () => {
    const counterTrend: SlTpManagerInput = { ...trendLongPlanA, scenario: 'COUNTER_TREND', slPrice: 99.3 };
    const opened = openPosition(counterTrend);
    const closed = onSlHit(opened);
    // gross=990*(99.3-100)/100=-6.93; fees=0.792; net=-7.722
    expect(computeRealizedPnl(closed, closed.currentSlPrice)).toBeCloseTo(-7.722, 6);
  });
});
