# `openAlgoOrdersResponseFixture.json` — provenance

**Source:** Binance Futures **TESTNET**, `GET /fapi/v1/openAlgoOrders` (no `symbol` param), read-only,
captured **2026-08-11** for TICKET-G1R-A "Final Internal Closure & Exchange Schema Gate" item 5.

**Authorization:** the ticket authorized exactly one bounded, read-only testnet GET on this endpoint.
No mainnet call was made. No order was placed, modified, or cancelled at any point. The executor was
constructed with `dryRun: true` and only `signedGet`/`getOpenAlgoOrders`/`syncClock` were invoked.

**Sanitization applied before writing this file:**

| Field | Treatment |
|---|---|
| `algoId` | replaced with sequential placeholders `1000001..1000008` |
| `clientAlgoId` | replaced with `sanitizedClientAlgoId0..7` |
| `actualOrderId` | replaced with sequential placeholders `2000001..2000008` |
| everything else | **verbatim** — that is the point of the fixture |

No API key, secret, signature, signed URL, account ID, or balance appears in this file (asserted by a
test in `g1rFinalInternalClosureFix.test.ts`). `symbol`, prices and quantities are ordinary market
data and are kept as-is so the fixture exercises real numeric-in-string parsing.

## Confirmed schema (DQ-A — EXCHANGE_CONFIRMED)

- **Envelope:** bare JSON array. Not `{orders:[...]}`, not any wrapper.
- **Empty case:** an empty array `[]` (the adapter maps it to `[]`; a non-array throws).
- **`symbol` param:** optional. Omitted = all symbols (documented IP weight 40 vs 1 for one symbol).
  This capture omitted it.

| Field | Type observed | Notes |
|---|---|---|
| `algoId` | number | |
| `clientAlgoId` | string | |
| `algoType` | string | `CONDITIONAL` in all 8 rows |
| `orderType` | string | `TAKE_PROFIT_MARKET` in all 8 rows; union also includes `STOP_MARKET`, `STOP`, `TAKE_PROFIT`, `TRAILING_STOP_MARKET` |
| `symbol` | string | |
| `side` | string | `SELL` in all 8 rows; union `BUY`/`SELL` |
| `positionSide` | string | `BOTH` in all 8 rows (One-Way account); union `BOTH`/`LONG`/`SHORT` |
| `timeInForce` | string | `GTC` |
| **`quantity`** | **string** | numeric-in-string. **`origQty` does NOT exist on this endpoint.** |
| `algoStatus` | string | `NEW` in all 8 rows. **`status` does NOT exist.** |
| `actualOrderId` | string | |
| `actualQty` | string | |
| **`triggerPrice`** | **string** | numeric-in-string. **`stopPrice` does NOT exist.** |
| `price` | string | `"0.0"` for MARKET-type algo orders |
| `icebergQuantity` | null | |
| `selfTradePreventionMode` | string | `EXPIRE_MAKER` |
| `workingType` | string | `CONTRACT_PRICE` |
| `priceMatch` | string | `NONE` |
| **`closePosition`** | **boolean** | real boolean `false`, NOT the string `"false"` |
| **`priceProtect`** | **boolean** | real boolean |
| **`reduceOnly`** | **boolean** | real boolean `true` on every protective order |
| `createTime` / `updateTime` / `triggerTime` / `goodTillDate` | number | |

### Active status values

`algoStatus` union (from `tiagosiebler/binance` `src/types/futures.ts`, `FuturesAlgoOrderStatus`):
`NEW | CANCELED | TRIGGERING | TRIGGERED | FINISHED | REJECTED | EXPIRED`.
Treated as **still open**: `NEW`, `TRIGGERING`. The parser rejects everything else — a terminal status
appearing on the open-orders endpoint is an anomaly, and silently dropping it would be
indistinguishable from "this position has no protective order".

### Corroborating documentation

- `tiagosiebler/binance` `src/usdm-client.ts`: `getOpenAlgoOrders(params?) => Promise<FuturesAlgoOrderResponse[]>`
  — an array return type, confirming the bare-array envelope independently of the live read.
- `tiagosiebler/binance` `src/types/futures.ts`: `FuturesAlgoOrderResponse`, `FuturesAlgoOrderStatus`,
  `FuturesAlgoConditionalOrderTypes`, `FuturesQueryOpenAlgoOrdersParams`.
- Binance docs, `New Algo Order` (`POST /fapi/v1/algoOrder`) response example — same field names/types;
  note the REQUEST side takes `closePosition`/`reduceOnly` as the strings `"true"`/`"false"` while the
  RESPONSE side returns real booleans. The parser normalizes both and throws on anything else.

## Honest limitation

All 8 observed rows were `TAKE_PROFIT_MARKET` / `BOTH` / `NEW` / `reduceOnly=true`. `STOP_MARKET`,
`LONG`/`SHORT` `positionSide`, and the `TRIGGERING` status are taken from the typed-connector unions
(same endpoint, same `CONDITIONAL` `algoType`) rather than from a directly observed row.
