/**
 * TICKET-142 — shared result shape for all 4 setup-specific thesis modules. Each module (momentum/
 * pullback/breakout/reversal) implements its OWN rules and returns this same shape, never a common
 * pipeline. See momentumThesis.ts/pullbackThesis.ts/breakoutThesis.ts/reversalThesis.ts.
 */
import type { HTFContext, SafetyState5m } from '../../regime/htfSafetyTypes.js';

export type SetupThesisType = 'MOMENTUM_DIRECT' | 'OB' | 'FVG' | 'BOX_BREAKOUT' | 'SWEEP';
export type ThesisSide = 'LONG' | 'SHORT';
export type ThesisState = 'VALID' | 'WEAK' | 'NONE';

export interface SetupThesisResult {
  symbol: string;
  timestamp: number;
  setupType: SetupThesisType;
  side: ThesisSide;
  /** Stable identity for dedup: zoneId (OB/FVG), sweep-event id (SWEEP), or timestamp-qualified (BOX_BREAKOUT/MOMENTUM_DIRECT). */
  candidateId: string;
  thesisState: ThesisState;
  /** null = no real production score/confidence exists for this field — never synthesized. */
  qualityScore: number | null;
  reasons: string[];
  entryPrice: number | null;
  stopLoss: number | null;
  riskReward: number | null;
  htfContext: HTFContext;
  safetyState5m: SafetyState5m;
}

/** Fields computed ONCE per candle by the orchestrator and shared across all 4 modules. */
export interface SetupThesisCommonInput {
  symbol: string;
  timestamp: number;
  htfContext: HTFContext;
  safetyState5m: SafetyState5m;
}
