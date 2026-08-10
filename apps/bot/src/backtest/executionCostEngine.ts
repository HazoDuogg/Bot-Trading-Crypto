export type ExecutionDataQuality = 'HISTORICAL_MEASURED' | 'CONFIGURED_ACTUAL_RATE' | 'STRESS_ASSUMPTION' | 'APPROXIMATION' | 'INSUFFICIENT_DATA';
export type ExecutionSide = 'LONG' | 'SHORT';

export interface FundingRateProvider {
  getFundingRate(symbol: string, timestamp: number): number | null;
}

export interface ExecutionCostConfig {
  enabled: boolean;
  takerFeeRate: number;
  slippage: { enabled: boolean; model: 'FIXED_BPS'; bpsPerSide: number };
  spread: { enabled: boolean; model: 'FIXED_TOTAL_BPS'; totalBps: number };
  latency: { enabled: boolean; model: 'DISABLED' | 'CANDLE_DELAY'; delayMs?: number };
  funding: { enabled: boolean; model: 'DISABLED' | 'HISTORICAL'; provider?: FundingRateProvider };
}

export const IDEAL_EXECUTION_COST_CONFIG: ExecutionCostConfig = {
  enabled: false,
  takerFeeRate: 0.0004,
  slippage: { enabled: false, model: 'FIXED_BPS', bpsPerSide: 0 },
  spread: { enabled: false, model: 'FIXED_TOTAL_BPS', totalBps: 0 },
  latency: { enabled: false, model: 'DISABLED' },
  funding: { enabled: false, model: 'DISABLED' },
};

export interface ExecutionAssumptionLabels {
  fees: ExecutionDataQuality;
  slippage: ExecutionDataQuality;
  spread: ExecutionDataQuality;
  latency: ExecutionDataQuality;
  funding: ExecutionDataQuality;
}

export function executionAssumptionLabels(config: ExecutionCostConfig): ExecutionAssumptionLabels {
  return {
    fees: 'CONFIGURED_ACTUAL_RATE',
    slippage: config.enabled && config.slippage.enabled && config.slippage.bpsPerSide > 0 ? 'STRESS_ASSUMPTION' : 'CONFIGURED_ACTUAL_RATE',
    spread: config.enabled && config.spread.enabled && config.spread.totalBps > 0 ? 'STRESS_ASSUMPTION' : 'CONFIGURED_ACTUAL_RATE',
    latency: config.latency.enabled && config.latency.model === 'CANDLE_DELAY' ? 'APPROXIMATION' : 'INSUFFICIENT_DATA',
    funding: config.funding.enabled && config.funding.model === 'HISTORICAL' && config.funding.provider ? 'HISTORICAL_MEASURED' : 'INSUFFICIENT_DATA',
  };
}

function validateBps(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a finite number >= 0, got ${value}`);
}

export function validateExecutionCostConfig(config: ExecutionCostConfig): void {
  if (!Number.isFinite(config.takerFeeRate) || config.takerFeeRate < 0) throw new Error(`takerFeeRate must be >= 0, got ${config.takerFeeRate}`);
  validateBps('slippage.bpsPerSide', config.slippage.bpsPerSide);
  validateBps('spread.totalBps', config.spread.totalBps);
  if (config.latency.enabled && config.latency.model === 'DISABLED') throw new Error('enabled latency cannot use DISABLED model');
  if (config.funding.enabled && config.funding.model === 'HISTORICAL' && !config.funding.provider) throw new Error('HISTORICAL funding requires a provider');
}

export interface FillResult {
  referencePrice: number;
  executedPrice: number;
  slippagePriceDelta: number;
  spreadPriceDelta: number;
}

export function applyExecutionFill(referencePrice: number, side: ExecutionSide, isEntry: boolean, config: ExecutionCostConfig): FillResult {
  if (!(referencePrice > 0)) throw new Error(`referencePrice must be > 0, got ${referencePrice}`);
  validateExecutionCostConfig(config);
  if (!config.enabled) return { referencePrice, executedPrice: referencePrice, slippagePriceDelta: 0, spreadPriceDelta: 0 };
  const adverseDirection = (side === 'LONG') === isEntry ? 1 : -1;
  const slippagePriceDelta = config.slippage.enabled ? adverseDirection * referencePrice * config.slippage.bpsPerSide / 10_000 : 0;
  const spreadPriceDelta = config.spread.enabled ? adverseDirection * referencePrice * (config.spread.totalBps / 2) / 10_000 : 0;
  return { referencePrice, executedPrice: referencePrice + slippagePriceDelta + spreadPriceDelta, slippagePriceDelta, spreadPriceDelta };
}

export interface ExitLeg { referencePrice: number; fraction: number; timestamp?: number }
export interface TradeExecutionInput {
  symbol: string;
  side: ExecutionSide;
  entryTimestamp: number;
  referenceEntry: number;
  positionSize: number;
  exits: ExitLeg[];
}
export interface TradeExecutionAttribution {
  referenceEntry: number;
  executedEntry: number;
  referenceExit: number;
  executedExit: number;
  grossPnl: number;
  feeCost: number;
  slippageCost: number;
  spreadCost: number;
  fundingCost: number;
  totalExecutionCost: number;
  netPnl: number;
}

export function attributeTradeExecution(input: TradeExecutionInput, config: ExecutionCostConfig): TradeExecutionAttribution {
  if (!(input.positionSize > 0)) throw new Error(`positionSize must be > 0, got ${input.positionSize}`);
  const totalFraction = input.exits.reduce((sum, leg) => sum + leg.fraction, 0);
  if (Math.abs(totalFraction - 1) > 1e-9) throw new Error(`exit fractions must sum to 1, got ${totalFraction}`);
  const entry = applyExecutionFill(input.referenceEntry, input.side, true, config);
  const sideMultiplier = input.side === 'LONG' ? 1 : -1;
  let grossPnl = 0, executedGrossPnl = 0, slippageCost = 0, weightedReferenceExit = 0, weightedExecutedExit = 0;
  for (const leg of input.exits) {
    const exit = applyExecutionFill(leg.referencePrice, input.side, false, config);
    const notional = input.positionSize * leg.fraction;
    grossPnl += notional * ((leg.referencePrice - input.referenceEntry) / input.referenceEntry) * sideMultiplier;
    executedGrossPnl += notional * ((exit.executedPrice - entry.executedPrice) / entry.executedPrice) * sideMultiplier;
    const slipOnlyEntry = entry.referencePrice + entry.slippagePriceDelta;
    const slipOnlyExit = exit.referencePrice + exit.slippagePriceDelta;
    const slipOnlyPnl = notional * ((slipOnlyExit - slipOnlyEntry) / slipOnlyEntry) * sideMultiplier;
    slippageCost += notional * ((leg.referencePrice - input.referenceEntry) / input.referenceEntry) * sideMultiplier - slipOnlyPnl;
    weightedReferenceExit += leg.referencePrice * leg.fraction;
    weightedExecutedExit += exit.executedPrice * leg.fraction;
  }
  const totalFillCost = grossPnl - executedGrossPnl;
  const spreadCost = totalFillCost - slippageCost;
  const feeCost = input.positionSize * config.takerFeeRate * 2;
  let fundingCost = 0;
  if (config.enabled && config.funding.enabled && config.funding.model === 'HISTORICAL' && config.funding.provider) {
    for (const leg of input.exits) {
      const rate = config.funding.provider.getFundingRate(input.symbol, leg.timestamp ?? input.entryTimestamp);
      if (rate !== null) fundingCost += input.positionSize * leg.fraction * rate * (input.side === 'LONG' ? 1 : -1);
    }
  }
  return { referenceEntry: input.referenceEntry, executedEntry: entry.executedPrice, referenceExit: weightedReferenceExit, executedExit: weightedExecutedExit, grossPnl, feeCost, slippageCost, spreadCost, fundingCost, totalExecutionCost: feeCost + totalFillCost + fundingCost, netPnl: executedGrossPnl - feeCost - fundingCost };
}
