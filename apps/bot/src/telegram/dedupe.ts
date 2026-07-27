/**
 * TICKET-078 — idempotency: prevents sending the same notification twice when a live poll loop
 * re-observes the same underlying state (e.g. re-reads the same closed candle, or re-detects a
 * regime that hasn't actually changed since the last check). Keys are the caller's responsibility —
 * suggested natural keys (per the ticket): `orderId`/`algoId` for live order events, or
 * `symbol+regime-transition-timestamp` for regime-change notifications; for the backtest/event-driven
 * data this module currently has, `symbol+entryTimestamp+type` (OPEN) / `symbol+exitTimestamp+exitReason`
 * (CLOSE) / `symbol+timestamp+tier` (PARTIAL_CLOSE) work the same way — anything that's identical
 * across a duplicate observation of the SAME real-world event, different across two distinct ones.
 *
 * In-memory only (a Set) — fine for a single long-running process. A restart resets it, so a crash
 * immediately after sending (but before the caller would've recorded that externally) could in theory
 * resend once on restart; persisting this to disk (mirroring the risk_state.json pattern already used
 * elsewhere in this project) is a follow-up for when this gets wired into a real live loop, not
 * needed for the sample/format-review scope of this ticket.
 */
export class SentEventTracker {
  private readonly sentKeys = new Set<string>();

  hasSent(key: string): boolean {
    return this.sentKeys.has(key);
  }

  /** Returns true if this is the first time `key` is marked (i.e. the caller should actually send); false if already sent (caller should skip). */
  markSent(key: string): boolean {
    if (this.sentKeys.has(key)) return false;
    this.sentKeys.add(key);
    return true;
  }

  reset(): void {
    this.sentKeys.clear();
  }
}
