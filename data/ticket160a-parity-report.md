# TICKET-160A — Parity Report

All checks run on Windows, Node v22.17.0, from `D:\BotTradingV2`, branch `cai-tien`, input commit
`d1a124c` (clean working tree at session start).

## 1. Build / typecheck / tests (baseline, before any edit)

- `npm run typecheck` — 0 errors.
- `npm run build` — 0 errors.
- `npm run build:scripts` — 0 errors.
- `npm test` — **48 test files passed (48), 649 tests passed (649)** — matches the last-confirmed count on
  this exact commit per `data/ticket160-regression-parity-report.md`.

## 2. PROD_8FLAG_POST_T152 — full re-run (not a manifest check)

Command (identical to the one TICKET-160 used and to `memory/project_official_backtest_config.md`):

```
npm run backtest -- --max-concurrent-positions-per-symbol=2 --momentum-direct-enabled=true \
  --momentum-direct-threshold=0.5 --skip-days=20 --momentum-direct-min-sl-percent=1.0 \
  --momentum-direct-tp-r-multiple=3.0 --risk-pool-max-pct=15 --plan-auto-selection-enabled=true
```

Result: **261 trades closed, final balance $1505.44, winrate 41.8%, Max Drawdown -25.99% (-$405.83)**.

Comparison:

| | Documented (T160) | Re-run live (T160A, commit d1a124c) | Match |
|---|---|---|---|
| Trades | 261 | 261 | YES |
| Final balance | $1505.44 | $1505.44 | YES |
| Winrate | 41.8% | 41.8% | YES |
| MaxDD | -25.99% (-$405.83) | -25.99% (-$405.83) | YES |

**Reproducibility: PASS, zero drift.** The run's own output files (`data/backtest-report-*.md`,
`data/backtest-trades-*.csv`, `data/manipulated-log.txt`, `data/danger-zone-log.txt`,
`data/ticket138-macro-conflict-diagnostics-*.csv`) were left in `data/` as normal backtest byproducts; they
remain gitignored by the pre-existing `data/*` rule (not part of the TICKET-160A allowlist — confirmed via
`git check-ignore -v`) and were not added to git.

## 3. EXEC_CURRENT_PRODUCTION_CENTRAL_T153B — manifest/hash verification (not a full replay)

Full replay of all 4 execution-cost scenarios is expensive; per the ticket's own allowance, verified via
immutable manifest/hash instead:

- `sha256sum data/archive/ticket153b/ticket153b-run-manifest.json` =
  `0040ec0ad76a206d141042b5d93e82b95ae62e960a358d291a38c9dae3d93535` — **exact match** to the
  `inputManifestHash` value referenced by both `data/archive/ticket157/ticket157-analysis-summary.json`-era
  work and `data/archive/ticket158/ticket158-run-manifest.json`.
- Spot-checked 3 of the manifest's 20 recorded OHLCV dataset hashes against the live files in
  `data/ohlcv/`:
  - `BTCUSDT_5m.csv` -> `16b4506fd6321b7c5a337c61bbbaf877c3a16241107c6dd401a31180143b41fd` — match.
  - `ETHUSDT_1m.csv` -> `651f68767bc205398aa85d39435d7da88e481a907d588c2e224cbebc5c21ab53` — match.
  - `XRPUSDT_15m.csv` -> `fa8e8f88b4723924dfc7904849ecba3ea53189ec9d19e4a55d00e46f46a22a91` — match.
  - 2 of the manifest's model hashes (`xgb_confidence_v1.onnx`, `xgb_momentum_v1.onnx`) also spot-checked
    against `models/` — match.
- `data/archive/ticket153b/ticket153b-central-summary.json` figures (211 trades, PF
  1.3018644097963348, net 460.50836737263205, finalEquity 560.508367372632, MaxDD 418.6270592276059) —
  read directly from the file, matches `docs/baseline-registry.md`'s
  `EXEC_CURRENT_PRODUCTION_CENTRAL_T153B` entry exactly (rounded PF 1.3019, net $460.5084).

**Verification method used: immutable manifest/hash (not full replay), as explicitly allowed by the
ticket.** Result: PASS, zero drift on every checked hash/figure.

## 4. RESEARCH_OB_DISABLED_CENTRAL_T158_T159 — manifest/hash verification (not a full replay)

- `data/archive/ticket158/ticket158-run-manifest.json`'s `inputManifestHash` field =
  `0040ec0ad76a206d141042b5d93e82b95ae62e960a358d291a38c9dae3d93535` — matches the T153B manifest's own
  actual sha256 (computed above) exactly, confirming the T158 experiment ran against the identical,
  unmodified T153B dataset/config.
- Cross-report numeric cross-check (three independent sources, same figures):
  - `data/archive/ticket157/ticket157-ob_disabled-central-summary.json`: trades 264, pf
    1.3947839228431962, netPnl 606.6195245715165.
  - `docs/archive/ticket158/ticket158-formal-ob-disabled-portfolio-experiment-report.md` FINAL DECISION
    block: `OB_DISABLED: PF 1.3947839228431962, net 606.6195245715165, ... trades 264`.
  - `docs/archive/ticket159/ticket159-unified-entry-timing-optimization-report.md`: `CURRENT_ENTRY: PF
    1.3947839228431962, net 606.6195245715165, ... trades 264` (T159's own frozen baseline, additionally
    independently re-verified by T159 itself via a full production-pipeline replay reproducing 264/264
    trades and the net PnL to the last digit, per that report's "Baseline trust check" section).
  - All three: **exact match, zero drift.**

**Verification method used: immutable manifest/hash + cross-report numeric cross-check (not full replay),
as explicitly allowed by the ticket.**

## 5. Secrets / redaction scan

`grep -inE "BINANCE_|TELEGRAM_|api[_-]?key|secret|password|token|private[_-]?key|<private-IP-ranges>"` run
over every file about to be tracked for the first time (the full list in
`data/ticket160a-evidence-allowlist.csv`). Only matches: the word "token" inside prose describing
*blanked/empty* Telegram tokens used for a smoke test (`data/ticket160-before-after-summary.md`,
`data/ticket160-regression-parity-report.md`) and env-var *names* (`TELEGRAM_BOT_TOKEN`,
`TELEGRAM_BOT_TOKEN_ENC`) used as empty-string overrides — no actual secret values present. **Result:
clean, nothing blocked.**

## 6. git diff scope (behavior-invariant proof)

```
git diff --stat HEAD
 .gitignore | 55 +++++++++++++++++++++++++++++++++++++++++++++++++-
 1 file changed, 54 insertions(+), 1 deletion(-)
```

Plus untracked new files under `data/` (allowlisted subset only) and `docs/` (index correction +
baseline-registry.md + path notes in the 3 frozen reports). **Zero modifications to any file under
`apps/bot/src/entry/`, `apps/bot/src/regime/`, `apps/bot/src/risk/`, `apps/bot/src/orchestrator/`,
`apps/bot/src/live/`, or any other production source/test file.** No config default, threshold, or
research-flag default was changed. `git status --porcelain` confirms the only modified tracked file is
`.gitignore`; the only new paths are the intended `docs/`/`data/` allowlist additions.

## Maximum reconciliation error across all three baselines

**0** (exact match on every compared figure: PROD_8FLAG_POST_T152 full re-run, T153B manifest/hash
verification, T158/T159 manifest/hash + cross-report verification).
