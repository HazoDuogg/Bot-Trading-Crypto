import { config as loadEnv } from 'dotenv';

// Loads .env from process.cwd() — run this script from the repo root.
loadEnv();

// TICKET-RT-014: fetches real Binance Futures exchange filters (LOT_SIZE/MIN_NOTIONAL/PRICE_FILTER)
// for Buoc 5c (Exchange Quantity Normalization) prep. No normalization logic here — read-only fetch.
// Uses BINANCE_URL (mainnet) for consistency with fetchOhlcv.ts; these filters are the same on
// testnet and mainnet for a given symbol. Filter field names are printed as-is from the live response
// (not hardcoded) since Binance has renamed MIN_NOTIONAL -> NOTIONAL across API versions before.

interface ExchangeFilter {
  filterType: string;
  [key: string]: unknown;
}

interface SymbolInfo {
  symbol: string;
  filters: ExchangeFilter[];
}

interface ExchangeInfoResponse {
  serverTime: number;
  symbols: SymbolInfo[];
}

const BINANCE_URL = process.env.BINANCE_URL;
if (!BINANCE_URL) throw new Error('BINANCE_URL missing from .env');

async function fetchExchangeInfo(): Promise<ExchangeInfoResponse> {
  const url = new URL('/fapi/v1/exchangeInfo', BINANCE_URL);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance exchangeInfo request failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as ExchangeInfoResponse;
}

async function main() {
  const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'HYPEUSDT', 'XRPUSDT'];
  const info = await fetchExchangeInfo();

  console.log(`Fetched at ${new Date().toISOString()} (Binance serverTime: ${new Date(info.serverTime).toISOString()})`);
  console.log(`LUU Y: filter co the doi theo thoi gian — coi day la snapshot tai thoi diem chay o tren, khong hardcode lai.\n`);

  for (const symbol of symbols) {
    const symbolInfo = info.symbols.find((s) => s.symbol === symbol);
    if (!symbolInfo) {
      console.log(`${symbol}: KHONG TIM THAY trong exchangeInfo (symbol co the chua list o Binance Futures)\n`);
      continue;
    }

    console.log(`=== ${symbol} ===`);
    const lotSize = symbolInfo.filters.find((f) => f.filterType === 'LOT_SIZE');
    const minNotional = symbolInfo.filters.find((f) => f.filterType === 'MIN_NOTIONAL' || f.filterType === 'NOTIONAL');
    const priceFilter = symbolInfo.filters.find((f) => f.filterType === 'PRICE_FILTER');

    console.log(`  LOT_SIZE: ${lotSize ? JSON.stringify(lotSize) : 'KHONG CO'}`);
    console.log(`  MIN_NOTIONAL/NOTIONAL: ${minNotional ? JSON.stringify(minNotional) : 'KHONG CO'}`);
    console.log(`  PRICE_FILTER: ${priceFilter ? JSON.stringify(priceFilter) : 'KHONG CO'}`);
    console.log('');
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
