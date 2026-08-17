import { describe, expect, it } from 'vitest';
import { candidateKey, evaluationId, reconcileG6rFunnel, type G6rFunnelLedgers } from './g6rFullPathFunnel.js';

const dq = 'DQ-B — COMPARABLE_WITH_LIMITATIONS' as const;

function validLedgers(): G6rFunnelLedgers {
  const evalId = evaluationId('BTCUSDT', 1000, 'TREND_RIDER', 0);
  const key = candidateKey('BTCUSDT', 'LONG', 'OB', 1000, 500);
  return {
    evaluations: [{ evaluationId: evalId, symbol: 'BTCUSDT', regime: 'TREND_RIDER', evaluationTimestamp: 1000, routeInvocationOrdinal: 0, terminalOutcome: 'ADMITTED_AS_TRADE', terminalReason: 'OPEN_EVENT', dataQuality: dq }],
    candidates: [{ candidateKey: key, evaluationId: evalId, symbol: 'BTCUSDT', side: 'LONG', regime: 'TREND_RIDER', setupType: 'OB', sourceTimestamp: 500, decisionTimestamp: 1000, entryPrice: 10, slPrice: 9, dataQuality: dq }],
    events: [
      { eventId: `${evalId}|0`, evaluationId: evalId, candidateKey: key, symbol:'BTCUSDT',side:'LONG',regime:'TREND_RIDER',setupType:'OB',evaluationTimestamp:1000,sourceTimestamp:500,decisionTimestamp:1000,stage: 'RAW_DETECTOR_EVALUATION', outcome: 'DETECTOR_FOUND', reason: 'OB_FOUND',entryPrice:10,slPrice:9,dataQuality:dq,sequence: 0 },
      { eventId: `${evalId}|1`, evaluationId: evalId, candidateKey: key, symbol:'BTCUSDT',side:'LONG',regime:'TREND_RIDER',setupType:'OB',evaluationTimestamp:1000,sourceTimestamp:500,decisionTimestamp:1000,stage: 'ADMISSION', outcome: 'ADMITTED_AS_TRADE', reason: 'OPEN_EVENT',entryPrice:10,slPrice:9,dataQuality:dq,sequence: 1 },
    ],
  };
}

describe('G6R Checkpoint 2 reconciliation', () => {
  it('accepts unique, fully joined ledgers with exactly one terminal event', () => {
    expect(reconcileG6rFunnel(validLedgers())).toMatchObject({ duplicateEvaluationIds: 0, duplicateCandidateKeys: 0, missingEvaluationJoins: 0, missingCandidateJoins: 0, evaluationsWithoutExactlyOneTerminal: 0 });
  });

  it('fails closed on duplicate IDs, missing joins, or multiple terminals', () => {
    const ledgers = validLedgers();
    ledgers.evaluations.push({ ...ledgers.evaluations[0] });
    ledgers.events.push({ ...ledgers.events[1], eventId: `${ledgers.events[1].eventId}-second`, outcome: 'BLOCKED_BY_RISK_OR_MARGIN' });
    expect(() => reconcileG6rFunnel(ledgers)).toThrow(/G6R_CP2_INVALID_LEDGER/);
  });
});
