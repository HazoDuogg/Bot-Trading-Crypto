import type { LiveEventRecord } from './eventRecord.js';
import { resolveLeverage } from '../positionSizing/leverageConfig.js';

const BALANCE_KINDS = new Set<LiveEventRecord['eventKind']>(['ENTRY_PLACED', 'ENTRY_FILLED', 'POSITION_CLOSED']);
const LEVERAGE_KINDS = new Set<LiveEventRecord['eventKind']>(['ENTRY_PLACED', 'ENTRY_FILLED']);

export async function enrichWithBalanceAndLeverage(record: LiveEventRecord, client: { getAvailableBalanceUsdt(): Promise<number> }): Promise<LiveEventRecord> {
  if (!BALANCE_KINDS.has(record.eventKind)) return record;

  let currentBalanceUsdt: number | null = null;
  try {
    currentBalanceUsdt = await client.getAvailableBalanceUsdt();
  } catch (err) {
    console.error(`  Khong lay duoc balance hien tai cho tin nhan ${record.eventKind} ${record.symbol} (bo qua, van gui tin nhan):`, err);
  }

  const leverage = LEVERAGE_KINDS.has(record.eventKind) ? resolveLeverage(record.symbol) : undefined;
  return { ...record, currentBalanceUsdt, leverage };
}
