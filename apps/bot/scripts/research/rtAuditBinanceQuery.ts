import { config as loadEnv } from 'dotenv';
import { createHmac } from 'node:crypto';
loadEnv();

// TICKET-RT-AUDIT-001: READ-ONLY audit query against Binance Futures TESTNET account state.
// No orders placed, no config changed. Uses the same HMAC-signing scheme as
// src/live/binanceOrderClient.ts (not importing it, to avoid the allowNonTestnet guard noise for a
// one-off multi-endpoint dump) but hitting endpoints that class does not expose
// (/fapi/v1/allOrders, /fapi/v1/userTrades, /fapi/v1/historicalAlgoOrders, positionRisk-no-symbol).

const BASE_URL = process.env.BINANCE_TESTNET_URL;
const API_KEY = process.env.BINANCE_TESTNET_KEY_ENC;
const API_SECRET = process.env.BINANCE_TESTNET_SECRET_ENC;
if (!BASE_URL || !API_KEY || !API_SECRET) throw new Error('CORRECTION_REQUIRED: thieu BINANCE_TESTNET_URL/KEY/SECRET trong .env');
if (!BASE_URL.includes('testnet')) throw new Error('CORRECTION_REQUIRED: BASE_URL khong chua "testnet" — dung lai.');

function sign(params: Record<string, string | number>): string {
  const query = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();
  const signature = createHmac('sha256', API_SECRET!).update(query).digest('hex');
  return `${query}&signature=${signature}`;
}

async function signedGet(path: string, params: Record<string, string | number> = {}): Promise<{ ok: boolean; status: number; body: unknown }> {
  const qs = sign({ timestamp: Date.now(), recvWindow: 5000, ...params });
  const url = `${BASE_URL}${path}?${qs}`;
  const res = await fetch(url, { method: 'GET', headers: { 'X-MBX-APIKEY': API_KEY! } });
  const text = await res.text();
  let body: unknown;
  try { body = JSON.parse(text); } catch { body = text; }
  return { ok: res.ok, status: res.status, body };
}

async function main() {
  const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'HYPEUSDT', 'XRPUSDT'];

  console.log('=== A. /fapi/v2/positionRisk (leverage hien tai tren tung symbol, khong tham so symbol -> toan bo account) ===');
  const posRisk = await signedGet('/fapi/v2/positionRisk');
  console.log(`status=${posRisk.status}`);
  if (Array.isArray(posRisk.body)) {
    for (const p of posRisk.body as Record<string, unknown>[]) {
      if (SYMBOLS.includes(String(p.symbol))) {
        console.log(`  ${p.symbol}: leverage=${p.leverage}  positionAmt=${p.positionAmt}  entryPrice=${p.entryPrice}  unRealizedProfit=${p.unRealizedProfit}`);
      }
    }
  } else {
    console.log(JSON.stringify(posRisk.body));
  }

  console.log('\n=== B1. /fapi/v1/allOrders XRPUSDT (toan bo order history, limit 200) ===');
  const allOrders = await signedGet('/fapi/v1/allOrders', { symbol: 'XRPUSDT', limit: 200 });
  console.log(`status=${allOrders.status}`);
  console.log(JSON.stringify(allOrders.body, null, 2));

  console.log('\n=== B2. /fapi/v1/userTrades XRPUSDT (fill thuc te) ===');
  const trades = await signedGet('/fapi/v1/userTrades', { symbol: 'XRPUSDT', limit: 200 });
  console.log(`status=${trades.status}`);
  console.log(JSON.stringify(trades.body, null, 2));

  console.log('\n=== B3. /fapi/v1/openAlgoOrders XRPUSDT (algo order dang mo, neu con) ===');
  const openAlgo = await signedGet('/fapi/v1/openAlgoOrders', { symbol: 'XRPUSDT' });
  console.log(`status=${openAlgo.status}`);
  console.log(JSON.stringify(openAlgo.body, null, 2));

  console.log('\n=== B4. /fapi/v1/allAlgoOrders XRPUSDT (toan bo algo order — dung ten endpoint dung theo comment RT-071 da xoa trong commit cbf9b8a) ===');
  const histAlgo = await signedGet('/fapi/v1/allAlgoOrders', { symbol: 'XRPUSDT', algoType: 'CONDITIONAL', limit: 100 });
  console.log(`status=${histAlgo.status}`);
  console.log(JSON.stringify(histAlgo.body, null, 2));

  console.log('\n=== B5. /fapi/v1/income XRPUSDT (realized pnl / funding / commission entries) ===');
  const income = await signedGet('/fapi/v1/income', { symbol: 'XRPUSDT', limit: 100 });
  console.log(`status=${income.status}`);
  console.log(JSON.stringify(income.body, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
