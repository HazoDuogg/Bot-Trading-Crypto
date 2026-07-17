import { describe, expect, it } from 'vitest';
import {
  computeBreakevenPlusFeeSlPrice,
  computeFeeBufferDollar,
  onSlHit,
  onTp1Hit,
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
