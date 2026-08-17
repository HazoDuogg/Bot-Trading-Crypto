/** G6R Checkpoint 2 — research-only event-ledger contract and fail-closed reconciliation. */
export type G6rSetupType = 'OB' | 'FVG' | 'SWEEP' | 'BOX_BREAKOUT' | 'MOMENTUM_DIRECT';
export type G6rSide = 'LONG' | 'SHORT';

export type G6rStage =
  | 'RAW_DETECTOR_EVALUATION'
  | 'ROUTER_SELECTION'
  | 'MSS'
  | 'ADMISSION';

export type G6rOutcome =
  | 'DETECTOR_FOUND'
  | 'DETECTOR_NOT_FOUND'
  | 'SELECTED_BY_ROUTER'
  | 'PREEMPTED_BY_HIGHER_PRIORITY'
  | 'MSS_PASS'
  | 'MSS_FAIL'
  | 'BLOCKED_BY_REGIME_OR_HTF'
  | 'BLOCKED_BY_CIRCUIT_BREAKER'
  | 'BLOCKED_BY_SAME_SIDE_OR_CONCURRENCY'
  | 'BLOCKED_BY_RISK_OR_MARGIN'
  | 'ADMITTED_AS_TRADE';

export interface G6rEvaluationRow {
  evaluationId: string;
  symbol: string;
  regime: string;
  evaluationTimestamp: number;
  routeInvocationOrdinal: number;
  terminalOutcome: Extract<G6rOutcome,
    | 'DETECTOR_NOT_FOUND'
    | 'MSS_FAIL'
    | 'BLOCKED_BY_REGIME_OR_HTF'
    | 'BLOCKED_BY_CIRCUIT_BREAKER'
    | 'BLOCKED_BY_SAME_SIDE_OR_CONCURRENCY'
    | 'BLOCKED_BY_RISK_OR_MARGIN'
    | 'ADMITTED_AS_TRADE'>;
  terminalReason: string;
  dataQuality: 'DQ-B — COMPARABLE_WITH_LIMITATIONS';
}

export interface G6rCandidateRow {
  candidateKey: string;
  evaluationId: string;
  symbol: string;
  side: G6rSide;
  regime: string;
  setupType: G6rSetupType;
  sourceTimestamp: number;
  decisionTimestamp: number;
  entryPrice: number;
  slPrice: number;
  dataQuality: 'DQ-B — COMPARABLE_WITH_LIMITATIONS';
}

export interface G6rEventRow {
  eventId: string;
  evaluationId: string;
  candidateKey: string | null;
  symbol: string;
  side: G6rSide | null;
  regime: string;
  setupType: G6rSetupType | null;
  evaluationTimestamp: number;
  sourceTimestamp: number | null;
  decisionTimestamp: number;
  stage: G6rStage;
  outcome: G6rOutcome;
  reason: string;
  entryPrice: number | null;
  slPrice: number | null;
  dataQuality: 'DQ-B — COMPARABLE_WITH_LIMITATIONS';
  sequence: number;
}

export interface G6rFunnelLedgers {
  evaluations: G6rEvaluationRow[];
  candidates: G6rCandidateRow[];
  events: G6rEventRow[];
}

export interface G6rReconciliation {
  evaluationRows: number;
  candidateRows: number;
  eventRows: number;
  duplicateEvaluationIds: number;
  duplicateCandidateKeys: number;
  duplicateEventIds: number;
  missingEvaluationJoins: number;
  missingCandidateJoins: number;
  evaluationsWithoutExactlyOneTerminal: number;
  admittedCandidateKeys: string[];
}

const terminalOutcomes = new Set<G6rOutcome>([
  'DETECTOR_NOT_FOUND',
  'MSS_FAIL',
  'BLOCKED_BY_REGIME_OR_HTF',
  'BLOCKED_BY_CIRCUIT_BREAKER',
  'BLOCKED_BY_SAME_SIDE_OR_CONCURRENCY',
  'BLOCKED_BY_RISK_OR_MARGIN',
  'ADMITTED_AS_TRADE',
]);

function duplicateCount(values: string[]): number {
  return values.length - new Set(values).size;
}

export function evaluationId(symbol: string, evaluationTimestamp: number, regime: string, routeInvocationOrdinal: number): string {
  return `${symbol}|${evaluationTimestamp}|${regime}|${routeInvocationOrdinal}`;
}

export function candidateKey(symbol: string, side: G6rSide, setupType: G6rSetupType, decisionTimestamp: number, sourceTimestamp: number): string {
  return `${symbol}|${side}|${setupType}|${decisionTimestamp}|${sourceTimestamp}`;
}

export function reconcileG6rFunnel(ledgers: G6rFunnelLedgers): G6rReconciliation {
  const evaluationIds = new Set(ledgers.evaluations.map((row) => row.evaluationId));
  const candidateKeys = new Set(ledgers.candidates.map((row) => row.candidateKey));
  const terminalCounts = new Map<string, number>();
  let missingEvaluationJoins = 0;
  let missingCandidateJoins = 0;

  for (const candidate of ledgers.candidates) {
    if (!evaluationIds.has(candidate.evaluationId)) missingEvaluationJoins++;
  }
  for (const event of ledgers.events) {
    if (!evaluationIds.has(event.evaluationId)) missingEvaluationJoins++;
    if (event.candidateKey !== null && !candidateKeys.has(event.candidateKey)) missingCandidateJoins++;
    if (event.stage === 'ADMISSION' && terminalOutcomes.has(event.outcome)) {
      terminalCounts.set(event.evaluationId, (terminalCounts.get(event.evaluationId) ?? 0) + 1);
    }
  }

  const result: G6rReconciliation = {
    evaluationRows: ledgers.evaluations.length,
    candidateRows: ledgers.candidates.length,
    eventRows: ledgers.events.length,
    duplicateEvaluationIds: duplicateCount(ledgers.evaluations.map((row) => row.evaluationId)),
    duplicateCandidateKeys: duplicateCount(ledgers.candidates.map((row) => row.candidateKey)),
    duplicateEventIds: duplicateCount(ledgers.events.map((row) => row.eventId)),
    missingEvaluationJoins,
    missingCandidateJoins,
    evaluationsWithoutExactlyOneTerminal: ledgers.evaluations.filter((row) => terminalCounts.get(row.evaluationId) !== 1).length,
    admittedCandidateKeys: ledgers.events.filter((row) => row.outcome === 'ADMITTED_AS_TRADE' && row.candidateKey !== null).map((row) => row.candidateKey as string),
  };

  const failures = Object.entries(result)
    .filter(([key, value]) => key !== 'evaluationRows' && key !== 'candidateRows' && key !== 'eventRows' && key !== 'admittedCandidateKeys' && value !== 0)
    .map(([key, value]) => `${key}=${value}`);
  if (failures.length > 0) throw new Error(`G6R_CP2_INVALID_LEDGER: ${failures.join(', ')}`);
  return result;
}
