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
