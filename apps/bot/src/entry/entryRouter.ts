import { MarketRegime, type CandleData } from '../regime/types.js';
import { RegimeConfig } from '../regime/config.js';
import { lastDefined, wilderATRSeries } from '../regime/indicators.js';
import { EntryConfig } from './config.js';
import type { Direction, DraftSetup, EntryRouterConfig } from './types.js';
import { detectOrderBlock } from './detectors/orderBlock.js';
import { detectFairValueGap } from './detectors/fairValueGap.js';
import { detectLiquiditySweep } from './detectors/liquiditySweep.js';
import { detectMarketStructureShift } from './detectors/marketStructureShift.js';
import { detectBoxBreakout } from './detectors/boxBreakout.js';

export const DEFAULT_ENTRY_ROUTER_CONFIG: EntryRouterConfig = {
  // TICKET-036: re-enabled — picks the cascade routeEntry() runs for NEUTRAL_TRANSITION.
  entryStyleForNeutral: 'SIDEWAY_STYLE',
  // TICKET-017/018: off by default — baseline behavior unchanged unless a caller (backtest.ts CLI) opts in.
  macroTrendFilterEnabled: false,
  obDisabledSymbols: [],
  macroTrendFilterAppliesToBoxBreakout: false,
  // TICKET-040: matches EntryConfig.MSS_STALENESS_TOLERANCE_CANDLES (5, TICKET-011) — baseline
  // behavior unchanged unless a caller (backtest.ts CLI) opts into a different value.
  mssStalenessToleranceCandles: EntryConfig.MSS_STALENESS_TOLERANCE_CANDLES,
  // TICKET-041: matches EntryConfig.OB_BOS_LOOKFORWARD_K (10, TICKET-008) — baseline behavior
  // unchanged unless a caller (backtest.ts CLI) opts into a different value.
  obBosLookforwardK: EntryConfig.OB_BOS_LOOKFORWARD_K,
  regimeRiskMultiplier: {
    [MarketRegime.TREND_RIDER]: 1.0,
    [MarketRegime.SIDEWAY_SCALPER]: 1.0,
    // TICKET-036: was a fixed 0.5 (TICKET-012, dead value while NEUTRAL_TRANSITION never entered).
    // Now that it enters again, gated by orchestrator.ts's hard Momentum Gate instead — this fixed
    // risk-reduction idea is retired for good, not reused; 1.0 matches every other entering regime's baseline.
    [MarketRegime.NEUTRAL_TRANSITION]: 1.0,
    [MarketRegime.VOLATILE_CHOP]: 1.0,
    [MarketRegime.EVENT_RISK]: 1.0,
    [MarketRegime.DANGER_ZONE]: 1.0,
    [MarketRegime.CORRELATED_RISK]: 1.0,
    [MarketRegime.COMPRESSION]: 1.0,
    [MarketRegime.LOW_LIQUIDITY]: 1.0,
    [MarketRegime.MANIPULATED]: 1.0,
  },
};

export interface EntryRouterInput {
  regime: MarketRegime;
  /** TICKET-017 Phần B: needed to check EntryRouterConfig.obDisabledSymbols. */
  symbol: string;
  /** From RegimeOutput.adxDirection1h — drives OB/FVG direction for the TREND-style path. */
  adxDirection1h: 'UP' | 'DOWN' | 'FLAT' | undefined;
  /** TICKET-017 Phần A: 1D direction (same wilderDIDirectionSeries as adxDirection1h, on daily candles), only used by the TREND_RIDER path when EntryRouterConfig.macroTrendFilterEnabled is true. */
  macroDirection: 'UP' | 'DOWN' | 'FLAT' | undefined;
  candles5m: CandleData[];
  candles15m: CandleData[];
  /**
   * 1m or 3m candles available up to now, per EntryConfig.MSS_TIMEFRAME — the LAST element must be
   * the most recently closed 1m/3m candle ("now"), since staleness is judged relative to it. Caller
   * does NOT need to pre-slice to "since setup formed": runTrendStyle anchors the window to the
   * zone's (OB/FVG/Sweep) 5m timestamp internally (TICKET-010), and additionally only accepts an
   * MSS confirmation within the last EntryConfig.MSS_STALENESS_TOLERANCE_CANDLES of that window
   * (TICKET-011 — detectMarketStructureShift returns the FIRST match, which can be an arbitrarily
   * old historical confirmation otherwise; found live up to ~85 minutes stale). Passing more history
   * than needed is fine, it gets filtered out; passing a window that DOESN'T end at "now" will
   * silently make every confirmation look stale.
   */
  candlesMss: CandleData[];
  /** From RegimeOutput.computedMetrics — not recomputed here. */
  bbWidthPercentile15m: number | undefined;
  volumeZScore5m: number | undefined;
}

function runTrendStyle(input: EntryRouterInput, config: EntryRouterConfig, regime: MarketRegime): DraftSetup | null {
  if (input.adxDirection1h === undefined || input.adxDirection1h === 'FLAT') return null; // no clear direction, no entry
  const direction: Direction = input.adxDirection1h === 'UP' ? 'BULLISH' : 'BEARISH';
  const side: 'LONG' | 'SHORT' = direction === 'BULLISH' ? 'LONG' : 'SHORT';

  // TICKET-017 Phần A: only take entries aligned with the 1D macro trend when the filter is enabled.
  // FLAT (or unknown) macroDirection does not block — only an outright opposing daily trend does.
  if (config.macroTrendFilterEnabled && ((side === 'LONG' && input.macroDirection === 'DOWN') || (side === 'SHORT' && input.macroDirection === 'UP'))) {
    return null;
  }

  // Priority per PM: OB -> FVG -> Sweep (fallback signal #3, only when neither zone-based setup exists).
  let setupType: 'OB' | 'FVG' | 'SWEEP';
  let rawSlPrice: number; // the SL anchor before the ATR buffer is applied
  let zoneCandleIndex: number;

  // TICKET-017 Phần B: OB disabled per-symbol (evidence: XRPUSDT OB loses in both directions) —
  // falls through to FVG/Sweep exactly as if no OB were found.
  // TICKET-041: lookforwardK reads config.obBosLookforwardK (defaults to EntryConfig.OB_BOS_LOOKFORWARD_K)
  // instead of the constant directly, so backtest.ts's CLI can A/B test it without touching config.ts.
  const ob = config.obDisabledSymbols.includes(input.symbol)
    ? null
    : detectOrderBlock(input.candles5m, direction, { fractalN: EntryConfig.FRACTAL_N, lookforwardK: config.obBosLookforwardK });
  if (ob) {
    setupType = 'OB';
    rawSlPrice = direction === 'BULLISH' ? ob.low : ob.high;
    zoneCandleIndex = ob.candleIndex;
  } else {
    const fvg = detectFairValueGap(input.candles5m, direction);
    if (fvg) {
      setupType = 'FVG';
      rawSlPrice = direction === 'BULLISH' ? fvg.bottom : fvg.top;
      zoneCandleIndex = fvg.candleIndex;
    } else {
      const sweep = detectLiquiditySweep(input.candles5m, direction, {
        fractalN: EntryConfig.FRACTAL_N,
        wickRatioThreshold: EntryConfig.LIQUIDITY_SWEEP_WICK_RATIO_THRESHOLD,
      });
      if (!sweep) return null; // no OB, no FVG, no Sweep — nothing to trade
      setupType = 'SWEEP';
      const sweepCandle = input.candles5m[sweep.candleIndex];
      rawSlPrice = direction === 'BULLISH' ? sweepCandle.low : sweepCandle.high;
      zoneCandleIndex = sweep.candleIndex;
    }
  }

  // Restrict MSS candles to "since the zone formed" — the caller passes whatever 1m/3m history it
  // has available; using older history risks confirming MSS off a reversal unrelated to this zone.
  const zoneTimestamp = input.candles5m[zoneCandleIndex].timestamp;
  const mssWindow = input.candlesMss.filter((c) => c.timestamp >= zoneTimestamp);

  // OB/FVG/Sweep all go through the same MSS confirmation gate — no shortcut for Sweep.
  const mssConfirmedIndex = detectMarketStructureShift(mssWindow, direction, { fractalN: EntryConfig.FRACTAL_N });
  if (mssConfirmedIndex === null) return null; // setup found, but no reversal confirmation yet — don't enter

  // TICKET-011: detectMarketStructureShift returns the FIRST confirming candle in the window,
  // which can be an arbitrarily old historical point (found live: up to ~85 minutes stale) — a
  // live bot only acts on a confirmation the moment it happens, not a rediscovered old one. Only
  // accept a confirmation within the last mssStalenessToleranceCandles of the window (i.e. "now").
  // TICKET-040: reads config.mssStalenessToleranceCandles (defaults to EntryConfig.MSS_STALENESS_TOLERANCE_CANDLES)
  // instead of the constant directly, so backtest.ts's CLI can A/B test it without touching config.ts.
  const candlesFromEnd = mssWindow.length - 1 - mssConfirmedIndex;
  if (candlesFromEnd >= config.mssStalenessToleranceCandles) return null; // confirmation is stale — don't act on it

  const entryPrice = mssWindow[mssConfirmedIndex].close;

  const atr = lastDefined(wilderATRSeries(input.candles5m, RegimeConfig.ATR_PERIOD_5M));
  if (atr === undefined) return null; // not enough 5m history to size the SL buffer

  const buffer = EntryConfig.SL_BUFFER_ATR_MULTIPLIER * atr;
  const slPrice = direction === 'BULLISH' ? rawSlPrice - buffer : rawSlPrice + buffer;

  return { side, entryPrice, slPrice, setupType, regime, riskMultiplier: config.regimeRiskMultiplier[regime] };
}

function runBoxBreakoutStyle(input: EntryRouterInput, config: EntryRouterConfig, regime: MarketRegime): DraftSetup | null {
  if (input.bbWidthPercentile15m === undefined || input.volumeZScore5m === undefined) return null;

  const breakout = detectBoxBreakout(input.candles15m, input.candles5m, input.bbWidthPercentile15m, input.volumeZScore5m, {
    boxLookbackM: EntryConfig.BOX_LOOKBACK_M,
    maxBbwPercentile: EntryConfig.BOX_MAX_BBW_PERCENTILE,
    minBodyRatio: EntryConfig.BOX_BREAKOUT_MIN_BODY_RATIO,
    minVolumeZScore: EntryConfig.BOX_BREAKOUT_MIN_VOLUME_ZSCORE,
  });
  if (!breakout) return null; // SIDEWAY_SCALPER: no breakout yet; COMPRESSION: still "armed"

  const side: 'LONG' | 'SHORT' = breakout.direction === 'UP' ? 'LONG' : 'SHORT';

  // TICKET-018: extends the TICKET-017 macro trend filter to Box Breakout — requires BOTH flags on
  // (independent of the TREND_RIDER filter above). Returning null here is a no-op for SIDEWAY_SCALPER
  // (no Draft Setup this candle) and correctly leaves COMPRESSION "armed" (same as the `!breakout` case
  // above) — neither regime tracks any extra state, so no separate "armed" bookkeeping is needed.
  if (
    config.macroTrendFilterEnabled &&
    config.macroTrendFilterAppliesToBoxBreakout &&
    ((side === 'LONG' && input.macroDirection === 'DOWN') || (side === 'SHORT' && input.macroDirection === 'UP'))
  ) {
    return null;
  }

  const entryPrice = input.candles5m[breakout.breakoutCandleIndex].close;
  const slPrice = breakout.direction === 'UP' ? breakout.boxLow : breakout.boxHigh;

  return { side, entryPrice, slPrice, setupType: 'BOX_BREAKOUT', regime, riskMultiplier: config.regimeRiskMultiplier[regime] };
}

/**
 * Part C — maps a confirmed Tầng 1 regime to the detector(s) that run. `null` is a valid, expected
 * result (no entry this candle), not an error — unlike regime/, which throws for NOT_IMPLEMENTED.
 * Does NOT call risk/ or xgbFilter/ — only returns a DraftSetup for the orchestrator (not built
 * this sprint) to size and place.
 */
export function routeEntry(input: EntryRouterInput, config: EntryRouterConfig = DEFAULT_ENTRY_ROUTER_CONFIG): DraftSetup | null {
  switch (input.regime) {
    case MarketRegime.TREND_RIDER:
      return runTrendStyle(input, config, input.regime);
    case MarketRegime.SIDEWAY_SCALPER:
      return runBoxBreakoutStyle(input, config, input.regime);
    case MarketRegime.COMPRESSION:
      return runBoxBreakoutStyle(input, config, input.regime); // "armed" — same call, null until breakout confirms
    // TICKET-036: re-enabled (was `return null` since TICKET-012) — PM wants another attempt now
    // that the Momentum model exists, this time gated behind orchestrator.ts's hard Momentum Gate
    // instead of just a soft risk-multiplier. Same cascade choice as TREND_RIDER/SIDEWAY_SCALPER.
    case MarketRegime.NEUTRAL_TRANSITION:
      return config.entryStyleForNeutral === 'TREND_STYLE'
        ? runTrendStyle(input, config, input.regime)
        : runBoxBreakoutStyle(input, config, input.regime);
    default:
      return null;
  }
}
