/**
 * TICKET-08X-A (near/far targets) + TICKET-08X-B (split-order decision).
 * The 2x far/near ratio is a working default (not from the video) — revisit
 * once there's real data to check it against, per project convention.
 */
import type { Candle } from "../core/types.js";
import type { Zone } from "./zoneRegistry.js";
import { detectSwingPoints } from "./liquidity.js";

const SPLIT_FAR_TO_NEAR_RATIO = 2;

// TICKET-27X-A — from the video "Toán Học Đằng Sau Trading Thành Công": the EV-optimal
// zone is R:R 1:3-1:5; using the conservative lower bound.
export const MIN_REWARD_RISK_RATIO = 3;
// TICKET-27X-B — same video, same EV-optimal zone: the upper bound (1:5).
export const MAX_REWARD_RISK_RATIO = 5;

export interface FarTarget {
  index: number;
  price: number;
}

export interface Targets {
  nearTarget: Zone | null;
  farTarget: FarTarget | null;
}

/** Nearest opposite-type, still-live, still-imbalanced M15 zone beyond entryPrice in the bias direction. */
function findNearTarget(bias: "UP" | "DOWN", entryPrice: number, m15Registry: Zone[]): Zone | null {
  const opposingType = bias === "UP" ? "supply" : "demand";
  const candidates = m15Registry.filter(
    (z) =>
      z.type === opposingType &&
      z.state !== "INVALIDATED" &&
      z.imbalance !== null &&
      !z.imbalanceMitigated &&
      (bias === "UP" ? z.low > entryPrice : z.high < entryPrice),
  );
  if (candidates.length === 0) return null;
  return candidates.reduce((closest, z) => ((bias === "UP" ? z.low < closest.low : z.high > closest.high) ? z : closest));
}

/** Nearest opposite D1 swing high/low beyond entryPrice in the bias direction. */
function findFarTarget(bias: "UP" | "DOWN", entryPrice: number, dailyCandles: Candle[]): FarTarget | null {
  const wantKind = bias === "UP" ? "high" : "low";
  const candidates = detectSwingPoints(dailyCandles).filter(
    (s) => s.type === wantKind && (bias === "UP" ? s.price > entryPrice : s.price < entryPrice),
  );
  if (candidates.length === 0) return null;
  const nearest = candidates.reduce((closest, s) => ((bias === "UP" ? s.price < closest.price : s.price > closest.price) ? s : closest));
  return { index: nearest.index, price: nearest.price };
}

export function computeTargets(bias: "UP" | "DOWN", entryPrice: number, m15Registry: Zone[], dailyCandles: Candle[]): Targets {
  return {
    nearTarget: findNearTarget(bias, entryPrice, m15Registry),
    farTarget: findFarTarget(bias, entryPrice, dailyCandles),
  };
}

export type SplitDecision =
  | { mode: "SPLIT"; tp1: number; tp2: number }
  | { mode: "SINGLE"; tp1: number }
  | { mode: "INSUFFICIENT_DATA" };

/**
 * No nearTarget -> nothing to aim at. Reward:risk outside [MIN_REWARD_RISK_RATIO, MAX_REWARD_RISK_RATIO]
 * -> not worth taking, regardless of what SPLIT/SINGLE would otherwise be. Then farTarget missing,
 * or not far enough, -> one full-size order at nearTarget.
 */
export function decideTradeSplit(bias: "UP" | "DOWN", entryPrice: number, slPrice: number, targets: Targets): SplitDecision {
  if (!targets.nearTarget) return { mode: "INSUFFICIENT_DATA" };

  const nearEdge = bias === "UP" ? targets.nearTarget.low : targets.nearTarget.high;
  const nearDistance = Math.abs(nearEdge - entryPrice);
  const slDistance = Math.abs(entryPrice - slPrice);
  if (nearDistance < MIN_REWARD_RISK_RATIO * slDistance || nearDistance > MAX_REWARD_RISK_RATIO * slDistance) {
    return { mode: "INSUFFICIENT_DATA" };
  }

  if (!targets.farTarget) return { mode: "SINGLE", tp1: nearEdge };

  const farDistance = Math.abs(targets.farTarget.price - entryPrice);
  if (farDistance >= SPLIT_FAR_TO_NEAR_RATIO * nearDistance) {
    return { mode: "SPLIT", tp1: nearEdge, tp2: targets.farTarget.price };
  }
  return { mode: "SINGLE", tp1: nearEdge };
}
