/**
 * A Strategy looks at market data and produces candidate signals. It
 * does not size positions, does not score anything with AI, and does
 * not place orders - see src/pipeline.ts for where this sits in the
 * overall flow (data -> strategy -> ai -> risk -> execution).
 *
 * Interface only - no implementation. Strategy is not locked yet; this
 * exists so a future concrete strategy (whatever it turns out to be)
 * has a shape to implement, not to presuppose what it will be.
 */

export type Side = "long" | "short";

export interface Candle {
  openTimeMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Signal {
  symbol: string;
  side: Side;
  /** The bar this signal fired on. */
  barTimeMs: number;
  /** Arbitrary strategy-specific context, e.g. gate state, entry reason. */
  context?: Record<string, unknown>;
}

export interface Strategy {
  readonly name: string;

  /**
   * Evaluate the latest market data for one symbol and return a Signal
   * if this strategy's entry conditions are met, or null otherwise.
   * Must not have side effects (no order placement, no I/O beyond
   * reading the data it's given).
   */
  evaluate(symbol: string, candles: readonly Candle[]): Signal | null;
}
