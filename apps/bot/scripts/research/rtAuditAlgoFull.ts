import { config as loadEnv } from 'dotenv';
import { createHmac } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
loadEnv();

const BASE_URL = process.env.BINANCE_TESTNET_URL;
const API_KEY = process.env.BINANCE_TESTNET_KEY_ENC;
const API_SECRET = process.env.BINANCE_TESTNET_SECRET_ENC;
if (!BASE_URL || !API_KEY || !API_SECRET) throw new Error('CORRECTION_REQUIRED: thieu env');
if (!BASE_URL.includes('testnet')) throw new Error('CORRECTION_REQUIRED: khong phai testnet');

function sign(params: Record<string, string | number>): string {
  const query = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();
  const signature = createHmac('sha256', API_SECRET!).update(query).digest('hex');
  return `${query}&signature=${signature}`;
}

async function signedGet(path: string, params: Record<string, string | number> = {}) {
  const qs = sign({ timestamp: Date.now(), recvWindow: 5000, ...params });
  const url = `${BASE_URL}${path}?${qs}`;
  const res = await fetch(url, { method: 'GET', headers: { 'X-MBX-APIKEY': API_KEY! } });
  const text = await res.text();
  let body: unknown;
  try { body = JSON.parse(text); } catch { body = text; }
  return { ok: res.ok, status: res.status, body };
}

async function main() {
  const r = await signedGet('/fapi/v1/allAlgoOrders', { symbol: 'XRPUSDT', algoType: 'CONDITIONAL', limit: 200 });
  const arr = r.body as Record<string, unknown>[];
  arr.sort((a, b) => Number(a.createTime) - Number(b.createTime));
  await writeFile('apps/bot/reports/RT-AUDIT-001-algo-orders-xrp.json', JSON.stringify(arr, null, 2), 'utf8');
  console.log(`status=${r.status}, count=${arr.length}. Da ghi apps/bot/reports/RT-AUDIT-001-algo-orders-xrp.json`);
  for (const o of arr) {
    console.log(`${o.createTime} algoId=${o.algoId} ${o.orderType} trigger=${o.triggerPrice} status=${o.algoStatus} actualOrderId=${o.actualOrderId} triggerTime=${o.triggerTime}`);
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
