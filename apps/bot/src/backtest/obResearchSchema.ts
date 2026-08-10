export const OB_RESEARCH_SCHEMA_VERSION = '1.0.0';

export interface ObDecisionResearchRecord {
  schemaVersion: typeof OB_RESEARCH_SCHEMA_VERSION;
  orderId: string;
  obZoneId: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  decisionTimestamp: number;
  sourceCandleTimestamp: number;
  zoneHigh: number;
  zoneLow: number;
  proposedEntry: number;
  proposedStop: number;
  missingFields: string[];
}

export function validateObDecisionResearchRecord(record: ObDecisionResearchRecord): string[] {
  const errors: string[] = [];
  if (record.schemaVersion !== OB_RESEARCH_SCHEMA_VERSION) errors.push('schemaVersion');
  if (!record.orderId || !record.obZoneId) errors.push('identity');
  if (record.zoneLow >= record.zoneHigh) errors.push('zoneGeometry');
  if (record.sourceCandleTimestamp + 300_000 > record.decisionTimestamp) errors.push('sourceCandleNotClosed');
  if (![record.zoneHigh, record.zoneLow, record.proposedEntry, record.proposedStop].every(Number.isFinite)) errors.push('numericField');
  return errors;
}
