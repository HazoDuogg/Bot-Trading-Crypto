/**
 * TICKET-077 1.3 Bước B (mở đầu) — xác nhận kết nối tới đúng môi trường (mặc định Testnet) trước khi
 * chạy bất kỳ test đặt/hủy lệnh nào. CHỈ gọi endpoint đọc (server time, account info, position risk)
 * — không đặt/hủy lệnh nào ở script này.
 * Run: `npm run check-binance-env` (mặc định ENV=testnet) hoặc `ENV=mainnet npm run check-binance-env`.
 */
import 'dotenv/config';
import { loadBinanceEnvConfig } from '../dist/live/envConfig.js';
import { BinanceOrderExecutor } from '../dist/live/binanceOrderExecutor.js';

async function main(): Promise<void> {
  const { env, baseUrl, apiKey, apiSecret } = loadBinanceEnvConfig();
  const executor = new BinanceOrderExecutor({ credentials: { baseUrl, apiKey, apiSecret }, dryRun: true });

  const offset = await executor.syncClock();
  console.log(`Đồng bộ đồng hồ OK — lệch ${offset}ms so với server ${env}.`);

  const account = (await executor.getAccountInfo()) as { totalWalletBalance?: string; availableBalance?: string };
  console.log(`Kết nối getAccountInfo() OK — totalWalletBalance=${account.totalWalletBalance}, availableBalance=${account.availableBalance}`);

  const positions = (await executor.getPositionRisk()) as Array<{ symbol: string; positionAmt: string }>;
  const openPositions = positions.filter((p) => Number(p.positionAmt) !== 0);
  console.log(`Kết nối getPositionRisk() OK — ${positions.length} symbol trả về, ${openPositions.length} vị thế đang mở.`);
  if (openPositions.length > 0) console.log('Vị thế đang mở:', JSON.stringify(openPositions, null, 2));

  console.log(`\n=== Kết nối ${env.toUpperCase()} XÁC NHẬN OK — chưa đặt/hủy lệnh nào ===`);
}

main().catch((err) => {
  console.error('checkBinanceEnvConnectivity failed:', err);
  process.exit(1);
});
