import type { Candle, RegimeSnapshot } from "../core/types.js";
import { computeAdxDi, calculateTR } from "./adxDiCompare.js";

const MIN_CANDLES = 28; // ADX/ATR need 14+14 bars before values are past the zero-padded warm-up
const ADX_THRESHOLD = 25;
const ATR_ANOMALY_MULTIPLE = 3;

/** 3 fixed rules (TICKET-05X-B..D verdict), applied to the latest candle only. */
export function detectRegime(candles: Candle[]): RegimeSnapshot {
  if (candles.length < MIN_CANDLES) {
    throw new Error(`insufficient candles for regime detection, need >= ${MIN_CANDLES}`);
  }

  const i = candles.length - 1;
  const { adx, plusDI, minusDI, atr } = computeAdxDi(candles);
  const trueRange = calculateTR(candles[i].high, candles[i].low, candles[i - 1].close);

  let state: RegimeSnapshot["state"];
  if (trueRange > ATR_ANOMALY_MULTIPLE * atr[i]) {
    state = "DANGER_ZONE";
  } else if (adx[i] >= ADX_THRESHOLD && plusDI[i] > minusDI[i]) {
    state = "UPTREND";
  } else if (adx[i] >= ADX_THRESHOLD && minusDI[i] > plusDI[i]) {
    state = "DOWNTREND";
  } else {
    state = "SIDEWAY";
  }

  return { state, detectedAt: candles[i].closeTime };
}
