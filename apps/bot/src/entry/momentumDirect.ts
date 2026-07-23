/**
 * TICKET-059 Phần A — the AI momentum score used DIRECTLY as an entry signal, bypassing the
 * OB/FVG/Sweep/Box Breakout/MSS cascade entirely. Deliberately minimal: this function does NOT
 * compute the score itself (orchestrator.ts reuses scoreMomentumForSide(), never re-derived here)
 * and does NOT build a DraftSetup (that's Phần B, in orchestrator.ts) — just the threshold check.
 */
export function detectMomentumDirect(momentumScore: number, side: 'LONG' | 'SHORT', threshold: number): boolean {
  return momentumScore >= threshold;
}
