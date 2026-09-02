export const TICK_INFERENCE_MAX_DECIMAL_PLACES = 8;
export const TICK_INFERENCE_MIN_REPEATED_PRICES = 3;
export const TICK_ALIGNMENT_TOLERANCE = 1e-6;
// Diagnostic p95/max was 1 outlier across 32 scanned coin-windows (30×0, 2×1).
export const TICK_OUTLIER_EXCLUSION_MAX_COUNT = 1;

export interface TickSizeInferenceResult {
  tickSize: number;
  supportingPrices: number;
  outlierPrices: number;
  source: 'M1_CLOSE_DECIMAL_GRID';
}

export interface TickSizeOutlier {
  index: number;
  price: number;
}

export interface TickOutlierExclusionPlan {
  outliers: TickSizeOutlier[];
  outliersExcluded: number;
}

function decimalPlaces(value: number): number {
  const fixed = value.toFixed(TICK_INFERENCE_MAX_DECIMAL_PLACES);
  return fixed.replace(/0+$/u, '').split('.')[1]?.length ?? 0;
}

function alignsToTick(price: number, tickSize: number): boolean {
  const scaled = price / tickSize;
  return Math.abs(scaled - Math.round(scaled)) <= TICK_ALIGNMENT_TOLERANCE;
}

export function inferTickSize(prices: readonly number[]): TickSizeInferenceResult {
  if (prices.length === 0 || prices.some((price) => !Number.isFinite(price) || price <= 0)) {
    throw new Error('Tick inference requires at least one positive finite price');
  }
  const counts = Array.from({ length: TICK_INFERENCE_MAX_DECIMAL_PLACES + 1 }, () => 0);
  for (const price of prices) counts[decimalPlaces(price)] += 1;
  const minimumSupport = Math.min(TICK_INFERENCE_MIN_REPEATED_PRICES, prices.length);
  let inferredDecimals = 0;
  for (let decimals = counts.length - 1; decimals >= 0; decimals -= 1) {
    if (counts[decimals] >= minimumSupport) {
      inferredDecimals = decimals;
      break;
    }
  }
  const tickSize = Number((10 ** -inferredDecimals).toFixed(inferredDecimals));
  const supportingPrices = prices.filter((price) => alignsToTick(price, tickSize)).length;
  return {
    tickSize,
    supportingPrices,
    outlierPrices: prices.length - supportingPrices,
    source: 'M1_CLOSE_DECIMAL_GRID',
  };
}

export function validatePricesAlignToTickSize(
  prices: readonly number[],
  tickSize: number,
): void {
  if (!Number.isFinite(tickSize) || tickSize <= 0) {
    throw new Error('tickSize must be positive and finite');
  }
  const misaligned = prices.filter((price) => !alignsToTick(price, tickSize));
  if (misaligned.length > 0) {
    throw new Error(
      `Price series contains ${misaligned.length} value(s) that do not align with inferred ` +
        `tickSize ${tickSize}; sample=${misaligned.slice(0, 3).join(',')}`,
    );
  }
}

export function createTickOutlierExclusionPlan(
  prices: readonly number[],
  tickSize: number,
  maximumOutliers = TICK_OUTLIER_EXCLUSION_MAX_COUNT,
): TickOutlierExclusionPlan {
  if (!Number.isSafeInteger(maximumOutliers) || maximumOutliers < 0) {
    throw new Error('maximumOutliers must be a non-negative integer');
  }
  if (!Number.isFinite(tickSize) || tickSize <= 0) {
    throw new Error('tickSize must be positive and finite');
  }
  const outliers = prices.flatMap((price, index) =>
    alignsToTick(price, tickSize) ? [] : [{ index, price }],
  );
  if (outliers.length > maximumOutliers) {
    throw new Error(
      `Tick-size outlier count ${outliers.length} exceeds exclusion threshold ${maximumOutliers}; ` +
        `sample=${outliers.slice(0, 3).map(({ price }) => price).join(',')}`,
    );
  }
  return { outliers, outliersExcluded: outliers.length };
}
