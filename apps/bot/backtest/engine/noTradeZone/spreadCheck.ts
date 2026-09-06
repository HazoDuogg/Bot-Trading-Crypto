// spread% = (ask-bid) / mid-price * 100, per doc section 1.
export function isSpreadTooHigh(bid: number, ask: number, thresholdPct: number): boolean {
  const mid = (bid + ask) / 2;
  if (mid <= 0) return false;
  const spreadPct = ((ask - bid) / mid) * 100;
  return spreadPct > thresholdPct;
}
