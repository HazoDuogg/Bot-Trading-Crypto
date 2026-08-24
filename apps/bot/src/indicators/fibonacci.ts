export interface FibZoneResult {
  retracementPct: number; // 0 = at swingHighPrice, 1 = at swingLowPrice
  inDiscountZone: boolean; // retracementPct in [0.618, 0.786] — deep pullback toward the low, for LONG
  inPremiumZone: boolean; // retracementPct in [0.214, 0.382] — the mirrored band near the high, for SHORT
}

// INTERPRETATION CHOICE (per TICKET-RT-025 — the source doc doesn't give a direction parameter, and
// the function signature only takes plain prices, no direction): retracementPct always measures "how
// far price has pulled back from swingHighPrice toward swingLowPrice" (0 at the high, 1 at the low).
// inPremiumZone is NOT re-measured from a separate high-to-low formula — it's the mirror band on the
// SAME scale (1 - discount band = [0.214, 0.382], i.e. close to the high end) rather than the
// discount band itself, matching the standard ICT premium/discount split around the 50% midpoint.
export function computeFibZone(swingLowPrice: number, swingHighPrice: number, currentPrice: number): FibZoneResult {
  const range = swingHighPrice - swingLowPrice;
  if (range <= 0) {
    return { retracementPct: NaN, inDiscountZone: false, inPremiumZone: false };
  }

  const retracementPct = (swingHighPrice - currentPrice) / range;

  return {
    retracementPct,
    inDiscountZone: retracementPct >= 0.618 && retracementPct <= 0.786,
    inPremiumZone: retracementPct >= 1 - 0.786 && retracementPct <= 1 - 0.618,
  };
}
