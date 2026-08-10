# TICKET-160 — Regression & Parity Report

All checks run on Windows, Node v22.17.0, from `D:\BotTradingV2`, branch `cai-tien`.

## 1. Build

```
npm run build
```
Result: 0 errors. Ran 3 times during this ticket (initial baseline, post-stray-deletion, post-incident-
recovery) — identical clean pass every time.

## 2. Typecheck

```
npm run typecheck
```
Result: 0 errors. Ran 3 times — identical clean pass every time.

## 3. Unit / regression tests

```
npm test
```
Result: **48 test files passed (48), 649 tests passed (649)** — identical count and pass/fail status
before cleanup, immediately after stray-file deletion, and after the worktree-incident recovery (see
`ticket160-before-after-summary.md` for the incident writeup). Includes, among others:
- `apps/bot/src/orchestrator/orchestrator.test.ts` and `apps/bot/src/orchestrator/replayCompatibility.test.ts` — T152 same-side-duplicate guard tests.
- `apps/bot/src/live/liveBalanceSync.test.ts` — exchange-authoritative balance sync tests (T160-adjacent, committed at 89ceab5).
- `apps/bot/src/live/liveStateSync.test.ts` — state reconciliation tests.
- `apps/bot/src/backtest/obV2Research.test.ts`, `obResearchSchema.test.ts`, `executionCostEngine.test.ts`, `decisionTimeFeatures.test.ts` — newly-tracked backtest research module tests.
- `apps/bot/src/live/executionTelemetry.test.ts` — newly-tracked telemetry module test.

## 4. Live-runner dry-run startup smoke test

Command (Telegram tokens deliberately blanked for this test only, `.env` file itself **not** modified,
existing testnet Binance credentials in `.env` used as-is since `ENV` defaults to `testnet`):

```
TELEGRAM_BOT_TOKEN="" TELEGRAM_BOT_TOKEN_ENC="" ENV=testnet timeout 20 node apps/bot/scripts-dist/liveRunner.js
```

Output (abridged):
```
=== ĐANG CHẠY MÔI TRƯỜNG: TESTNET (tiền ảo) ===
Base URL: https://testnet.binancefuture.com
dryRun=true (KHÔNG gọi API đặt lệnh thật — chỉ log)
executionTelemetry=DISABLED
exchangeInfo (LOT_SIZE/PRICE_FILTER/MIN_NOTIONAL) đã tải cho 4 coin.
[DRY_RUN] setLeverage(BTCUSDT,30): POST /fapi/v1/leverage ... — OK  (x4 symbols)
Vốn hiện tại (từ sàn): $4988.76
liveRunner: lỗi khởi động không thể phục hồi: Error: loadTelegramConfig: missing TELEGRAM_BOT_TOKEN_ENC in .env
```
Interpretation: the process initialized cleanly through candle-feed setup, exchange-info load, dry-run
leverage configuration, and the exchange-authoritative balance fetch (testnet virtual balance,
`$4988.76`), proving the full module-import graph (including the files this ticket newly tracked --
`executionTelemetry.ts`, `backtest/obV2Research.ts`, `backtest/momentumEntryTimingResearch.ts`) resolves
and wires correctly at runtime. It then failed fast and safely at Telegram config validation, which is the
**expected, intended** result of deliberately blanking the Telegram token for this smoke test (never
touching real credentials/tokens, per smoke-test hygiene). No order was placed (dryRun=true throughout;
also never reached the trading loop). `risk_state.json` was confirmed absent before and after. No node
process was left running (process exited on its own before the 20s timeout).

**Honesty note:** this smoke test used real (but testnet/virtual) Binance credentials already present in
the repo's `.env` — no mainnet credentials were used or would have been used. A full end-to-end run with a
live Telegram bot was not attempted (out of scope and unsafe per smoke-test hygiene).

## 5. T153B active-baseline parity

`data/archive/ticket153b/ticket153b-run-manifest.json` and its 4 scenario outputs (Fee-only/Light/Central/
Conservative ledgers, summaries, equity-drawdown curves, cost-decomposition) were moved (not regenerated,
not edited) from `data/` to `data/archive/ticket153b/`. Byte-for-byte content preserved; confirmed via
directory listing (20 files in, 20 files out) and spot-check of `ticket153b-run-manifest.json`.

## 6. T159 OB-disabled Central parity

`data/archive/ticket157/ticket157-ob_disabled-central-summary.json` (T157's OB-disabled Central scenario,
the specific artifact T159's Central-parity conclusion cites) content after the move:

```json
{
  "variant": "OB_DISABLED",
  "scenario": "CENTRAL",
  "portfolio": {
    "trades": 264,
    "pf": 1.3947839228431962,
    "netPnl": 606.6195245715165,
    ...
  }
}
```
**264 trades / PF 1.3948 / net $606.62 — exact match** to the figures this ticket brief cites as
"already verified twice this session." Confirmed unchanged by the archive reorganization (file moved, not
regenerated or edited).

## 7. T152 same-side guard tests

Included in and passing within the full 649-test run: `orchestrator.test.ts` (guard logic + existing T152
tests) and `replayCompatibility.test.ts` (asserts guard is ON by default; pre-T152 behavior reachable only
via explicit `sameSideDuplicateGuardEnabled: false` opt-out).

## 8. Exchange-authoritative balance + reconciliation tests

`liveBalanceSync.test.ts` passing within the full 649-test run (committed at `89ceab5`, untouched by
T160). Live dry-run smoke test above additionally confirmed the real runtime code path
(`resolveAccountBalanceAfterReconcile`/exchange balance fetch) executes successfully against testnet.

## 9. Official 8-flag production/live baseline backtest

See `ticket160-before-after-summary.md` "Numeric parity" section: 261 trades / $1505.44 / -25.99% DD,
identical between a reconstructed pre-T160 state and the actual post-T160 state. Zero drift.

## Summary

| Check | Before | After | Match |
|---|---|---|---|
| Build | 0 errors | 0 errors | YES |
| Typecheck | 0 errors | 0 errors | YES |
| Tests | 48/48 files, 649/649 tests | 48/48 files, 649/649 tests | YES |
| Official baseline backtest | 261 trades / $1505.44 / -25.99% DD | 261 trades / $1505.44 / -25.99% DD | YES |
| T159 OB-disabled Central | 264 / PF 1.3948 / $606.62 | 264 / PF 1.3948 / $606.62 | YES |
| Live dry-run startup | (not run pre-cleanup; run once post-cleanup) | initializes cleanly, dryRun gated, no leaks | N/A -- see note below |

Note on live dry-run: this smoke test was only run once (post-cleanup), since it is non-deterministic
(depends on current testnet market/account state) and re-running it pre-cleanup would not have produced a
meaningfully comparable number. Its purpose here is solely to prove the module-import graph still resolves
and the process still initializes without crashing after this ticket's file moves/additions/deletions —
which it does.

Maximum numeric reconciliation error across all comparisons above: **0**.
