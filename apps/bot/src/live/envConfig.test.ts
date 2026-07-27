import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadBinanceEnvConfig } from './envConfig.js';

describe('loadBinanceEnvConfig', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
  });

  it('defaults to testnet when ENV is unset (safety default)', () => {
    delete process.env.ENV;
    process.env.BINANCE_TESTNET_URL = 'https://demo-fapi.binance.com';
    process.env.BINANCE_TESTNET_KEY_ENC = 'test-key';
    process.env.BINANCE_TESTNET_SECRET_ENC = 'test-secret';
    const config = loadBinanceEnvConfig();
    expect(config.env).toBe('testnet');
    expect(config.baseUrl).toBe('https://demo-fapi.binance.com');
  });

  it('uses mainnet credentials only when ENV=mainnet is explicit', () => {
    process.env.ENV = 'mainnet';
    process.env.BINANCE_URL = 'https://fapi.binance.com';
    process.env.BINANCE_LIVE_KEY = 'live-key';
    process.env.BINANCE_LIVE_SECRET = 'live-secret';
    const config = loadBinanceEnvConfig();
    expect(config.env).toBe('mainnet');
    expect(config.apiKey).toBe('live-key');
  });

  it('throws a clear error for an invalid ENV value instead of silently falling back', () => {
    process.env.ENV = 'production';
    expect(() => loadBinanceEnvConfig()).toThrow(/không hợp lệ/);
  });

  it('throws a clear error when a required testnet env var is missing (never silently proceeds with undefined credentials)', () => {
    process.env.ENV = 'testnet';
    delete process.env.BINANCE_TESTNET_URL;
    expect(() => loadBinanceEnvConfig()).toThrow(/BINANCE_TESTNET_URL/);
  });

  it('logs a distinct, unmissable banner for mainnet vs testnet', () => {
    process.env.ENV = 'mainnet';
    process.env.BINANCE_URL = 'https://fapi.binance.com';
    process.env.BINANCE_LIVE_KEY = 'k';
    process.env.BINANCE_LIVE_SECRET = 's';
    const logSpy = vi.spyOn(console, 'log');
    loadBinanceEnvConfig();
    expect(logSpy.mock.calls.some(([msg]) => String(msg).includes('MAINNET') && String(msg).includes('TIỀN THẬT'))).toBe(true);
  });
});
