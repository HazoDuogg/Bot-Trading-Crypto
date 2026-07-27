/**
 * TICKET-077 1.3 — 1 biến ENV đổi toàn bộ endpoint/key cùng lúc (spot/futures Testnet vs mainnet),
 * theo đúng yêu cầu "Setup môi trường test" của ticket. Mặc định là 'testnet' (an toàn) — chỉ chạy
 * mainnet khi ai đó chủ động đặt ENV=mainnet, không bao giờ là default.
 */
export type BinanceEnv = 'testnet' | 'mainnet';

export interface BinanceEnvConfig {
  env: BinanceEnv;
  baseUrl: string;
  apiKey: string;
  apiSecret: string;
}

function requireEnvVar(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`envConfig: thiếu biến môi trường ${name} trong .env`);
  return v;
}

/** Đọc `process.env.ENV` ('testnet' | 'mainnet', mặc định 'testnet'), trả về đúng base URL + key/secret tương ứng, và LOG RÕ đang chạy môi trường nào (yêu cầu bắt buộc của ticket). */
export function loadBinanceEnvConfig(): BinanceEnvConfig {
  const raw = (process.env.ENV ?? 'testnet').toLowerCase();
  if (raw !== 'testnet' && raw !== 'mainnet') {
    throw new Error(`envConfig: ENV="${raw}" không hợp lệ — chỉ chấp nhận "testnet" hoặc "mainnet"`);
  }
  const env = raw as BinanceEnv;

  const config: BinanceEnvConfig =
    env === 'testnet'
      ? { env, baseUrl: requireEnvVar('BINANCE_TESTNET_URL'), apiKey: requireEnvVar('BINANCE_TESTNET_KEY_ENC'), apiSecret: requireEnvVar('BINANCE_TESTNET_SECRET_ENC') }
      : { env, baseUrl: requireEnvVar('BINANCE_URL'), apiKey: requireEnvVar('BINANCE_LIVE_KEY'), apiSecret: requireEnvVar('BINANCE_LIVE_SECRET') };

  const banner = env === 'testnet' ? '=== ĐANG CHẠY MÔI TRƯỜNG: TESTNET (tiền ảo) ===' : '!!! ĐANG CHẠY MÔI TRƯỜNG: MAINNET — TIỀN THẬT !!!';
  console.log(banner);
  console.log(`Base URL: ${config.baseUrl}`);

  return config;
}
