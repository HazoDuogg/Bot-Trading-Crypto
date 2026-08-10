# T154 execution telemetry schema and operations

Schema version: `1.0.0`. The TypeScript source of truth is `apps/bot/src/live/executionTelemetry.ts`.

## Interface and lifecycle

The live runner calls one interface, `ExecutionTelemetry.emit(draft)`. It is a bounded in-memory enqueue; persistence runs asynchronously. Disabled mode is a no-op. A full queue or invalid event returns `false`, increments health counters, and alerts through the configured safe callback. It never throws into the trading path.

Every event has `schemaVersion`, `eventId`, stable `traceId`, `sessionId`, strategy/config/model identity, symbol/side/setup, event/source timestamps, source, field-quality map, and allowlisted `data`. Optional relationship IDs link candidate, decision, risk admission, client order, exchange order, fill, and position.

Event taxonomy: `CANDIDATE_CREATED`, `DECISION_MADE`, `RISK_ADMISSION`, `MARKET_SNAPSHOT`, `ORDER_SUBMIT_INTENT`, `ORDER_SENT`, `EXCHANGE_ACK`, `EXCHANGE_REJECT`, `FILL_PARTIAL`, `FILL_COMPLETE`, `ORDER_CANCELLED`, `ORDER_EXPIRED`, `POSITION_RECONCILED`, `TRADE_CLOSED`, `TELEMETRY_HEALTH`.

Reason codes currently emitted: `ORCHESTRATOR_OPEN_EVENT`, `SAME_SIDE_POSITION_BLOCKED`, `NO_NON_BLOCKING_BOOK_TICKER_FEED`. Exchange rejection uses a sanitized error class/code, never the authenticated request or raw response.

## Instrumentation map

| Source seam | Events |
|---|---|
| Orchestrator OPEN event | candidate, ALLOW decision, risk admission |
| T152 diagnostic callback | terminal BLOCK decision |
| Immediately before entry executor call | order intent and sent |
| Sanitized entry response/error | ack/reject and response-reported fill |
| State reconciler callback | position reconciliation mismatch |
| Orchestrator CLOSE event | trade closed |
| Shutdown | health counters |

The executor request payload, retry policy, order types, order sequencing, risk inputs, and strategy configuration are unchanged.

## Storage, rotation, retention, security

Enable with `EXECUTION_TELEMETRY_ENABLED=true`. Default is disabled. Files append to `data/live-telemetry/YYYY-MM-DD/execution-events-<sessionId>.jsonl`. Defaults: queue 5,000 events, rotation at 25 MiB, retention 90 days. Override with `EXECUTION_TELEMETRY_DIR`, `EXECUTION_TELEMETRY_MAX_QUEUE`, `EXECUTION_TELEMETRY_MAX_FILE_BYTES`, and `EXECUTION_TELEMETRY_RETENTION_DAYS`.

The writer uses an allowlist event shape and recursive secret-key/value redaction. API credentials, signatures, auth headers, cookies, environment dumps, Telegram credentials, and raw authenticated requests are forbidden. Local permissions are best-effort `0700` directories/`0600` files where supported. Account/order IDs remain local; sanitized research export should hash them before sharing.

## Measurement definitions

Positive slippage always means worse execution: buy cost is `(fill-reference)/reference`; sell cost is `(reference-fill)/reference`, multiplied by 10,000 for bps. Mid is `(bid+ask)/2`; spread bps is `(ask-bid)/mid*10,000`. Raw timestamps must be retained beside any derived latency. Send-to-ack is round-trip latency; it is not labeled one-way latency.

No blocking quote request was added to order submission. Until a non-blocking feed supplies contemporaneous bid/ask, quote fields are explicitly `MISSING`. Commission and funding are also `MISSING` unless Binance supplies them in a captured response; they are never inferred as zero.

## Performance and collection policy

Enqueue overhead samples and queue depth/drop/write-failure counters are retained in health state. Sign-off budget: enqueue p99 below 1 ms and no dropped order-critical event during shadow validation.

Calibration gate: at least 30 healthy calendar days, 100 completely linked filled orders, coverage for every traded symbol and major setup, and no unresolved material reconciliation incident. Subgroup publication minimum is 30 complete observations; thinner groups remain limited.

No production or VPS activation is authorized by T154. Enable first in the `cai-tien` shadow environment.
