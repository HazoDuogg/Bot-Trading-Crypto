import { describe, expect, it } from 'vitest';
import { OB_RESEARCH_SCHEMA_VERSION, validateObDecisionResearchRecord, type ObDecisionResearchRecord } from './obResearchSchema.js';

const valid: ObDecisionResearchRecord = { schemaVersion:OB_RESEARCH_SCHEMA_VERSION, orderId:'BTC-1', obZoneId:'BTC:OB:LONG:0:11:9', symbol:'BTCUSDT', side:'LONG', decisionTimestamp:600_000, sourceCandleTimestamp:0, zoneHigh:11, zoneLow:9, proposedEntry:12, proposedStop:8.9, missingFields:[] };

describe('OB research schema', () => {
  it('accepts a complete closed-candle record', () => expect(validateObDecisionResearchRecord(valid)).toEqual([]));
  it('rejects future source candles and inverted zones', () => expect(validateObDecisionResearchRecord({...valid,sourceCandleTimestamp:600_000,zoneLow:12})).toEqual(['zoneGeometry','sourceCandleNotClosed']));
});
