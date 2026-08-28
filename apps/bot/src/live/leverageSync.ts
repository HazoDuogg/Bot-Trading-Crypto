import { resolveLeverage, DEFAULT_LEVERAGE_CONFIG, type LeverageConfig } from '../positionSizing/leverageConfig.js';
import type { ExchangeOrderClient } from './exchangeOrderClient.js';

// TICKET-RT-073 Part B: called once, before the main loop starts. Sets exchange leverage to match
// DEFAULT_LEVERAGE_CONFIG for every symbol — RT-AUDIT-001 found the exchange's REAL leverage had
// silently drifted from the design because nothing had ever done this. Sequential (not
// Promise.all) so the returned `synced` list is always an accurate prefix of what actually
// succeeded if a later call throws.
//
// Deliberately FAILS CLOSED: the first setLeverage rejection (or resolveLeverage throwing on an
// unconfigured symbol) propagates straight out, uncaught here — the caller (liveRunner.ts) must NOT
// swallow it. This is intentional per the ticket: "neu that bai cho bat ky symbol nao -> dung khoi
// dong han", not "log and continue with whatever leverage happens to already be set".
export async function syncLeverageAtStartup(
  client: Pick<ExchangeOrderClient, 'setLeverage'>,
  symbols: string[],
  config: LeverageConfig = DEFAULT_LEVERAGE_CONFIG,
): Promise<{ symbol: string; leverage: number }[]> {
  const synced: { symbol: string; leverage: number }[] = [];
  for (const symbol of symbols) {
    const leverage = resolveLeverage(symbol, config);
    await client.setLeverage(symbol, leverage);
    synced.push({ symbol, leverage });
  }
  return synced;
}
