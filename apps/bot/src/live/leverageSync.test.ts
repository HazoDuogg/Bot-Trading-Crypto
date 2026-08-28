import { describe, it, expect } from 'vitest';
import { syncLeverageAtStartup } from './leverageSync.js';

class MockLeverageClient {
  calls: { symbol: string; leverage: number }[] = [];
  failOnSymbol: string | null = null;

  async setLeverage(symbol: string, leverage: number): Promise<void> {
    this.calls.push({ symbol, leverage });
    if (symbol === this.failOnSymbol) {
      throw new Error(`Binance signed request failed: POST /fapi/v1/leverage -> 400 {"code":-1000,"msg":"simulated failure for ${symbol}"}`);
    }
  }
}

describe('syncLeverageAtStartup', () => {
  it('sets leverage for every symbol per DEFAULT_LEVERAGE_CONFIG (BTC/ETH=20x, SOL/HYPE/XRP=10x)', async () => {
    const client = new MockLeverageClient();
    const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'HYPEUSDT', 'XRPUSDT'];
    const result = await syncLeverageAtStartup(client, symbols);

    expect(result).toEqual([
      { symbol: 'BTCUSDT', leverage: 20 },
      { symbol: 'ETHUSDT', leverage: 20 },
      { symbol: 'SOLUSDT', leverage: 10 },
      { symbol: 'HYPEUSDT', leverage: 10 },
      { symbol: 'XRPUSDT', leverage: 10 },
    ]);
    expect(client.calls).toEqual(result);
  });

  // Ticket acceptance scenario: "gia lap set-leverage that bai -> xac nhan engine dung khoi dong".
  it('rejects (propagates the exchange error) when setLeverage fails for ANY symbol — never resolves with a partial/silent success', async () => {
    const client = new MockLeverageClient();
    client.failOnSymbol = 'SOLUSDT';
    const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'HYPEUSDT', 'XRPUSDT'];

    await expect(syncLeverageAtStartup(client, symbols)).rejects.toThrow(/simulated failure for SOLUSDT/);

    // Sequential, fail-fast: symbols AFTER the failing one must never have been called.
    expect(client.calls.map((c) => c.symbol)).toEqual(['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
    expect(client.calls.some((c) => c.symbol === 'HYPEUSDT' || c.symbol === 'XRPUSDT')).toBe(false);
  });

  it('rejects for a symbol with no configured leverage at all (fail loud, matches resolveLeverage)', async () => {
    const client = new MockLeverageClient();
    await expect(syncLeverageAtStartup(client, ['DOGEUSDT'])).rejects.toThrow(/CORRECTION_REQUIRED/);
    expect(client.calls).toHaveLength(0);
  });
});
