# Vicion Bot

A TypeScript trading-bot framework-in-progress, with a place reserved for
an AI scoring layer (XGBoost-style, advisory only). **Strategy is not
locked yet.** Pine on TradingView is the research lab; a Python scanner
forward-tests the current best Pine-derived candidates live, 24/7, while
the TypeScript side stays an interfaces-only skeleton until a strategy
earns its way into production. See [docs/decisions.md](docs/decisions.md)
for the full rationale, locked/provisional parameters, and rejected
approaches.

## Current phase

**Forward-test validation**, dual-writing into `runtime/bot.db` since
2026-10-09. Three configs are live: BTCUSDT v2f (Long+Short), ETHUSDT v2f
(Long only), SOLUSDT v2e (Long only, ungated) - all provisional, see
`config/symbols.json`. The TypeScript framework itself has no trading
logic yet - only interfaces (`src/strategy/Strategy.ts`,
`src/execution/Broker.ts`, `src/ai/ScoringModel.ts`,
`src/ai/FeatureRecorder.ts`) and the intended pipeline documented as a
comment in `src/pipeline.ts`.

## Checking on it

```bash
python tools/status.py
```

One screen: scheduled-task health, `bot.db` integrity, per-config live
trade count / win% / net-of-fees return / open position, `runtime/` size
vs its 200MB budget, and days elapsed since the forward-test started.
Read-only - never writes to `bot.db`, the JSON state files, or the task.

## Layout

```
legacy/scanners/   # the LIVE forward-test scanner (Python) + its Windows
                   # Task Scheduler wrappers (.ps1/.vbs) - "legacy" because
                   # this is pre-TypeScript-framework infrastructure, not
                   # because it's unmaintained; it's the thing actually
                   # running right now. Do not edit casually - see
                   # docs/db_conventions.md before touching db_writer.py.
runtime/           # bot.db (SQLite), logs, cache - all gitignored.
                   # The *_forward_state.json / *_forward_trades.jsonl
                   # files at the repo root are STILL the source of
                   # truth during the dual-write validation period;
                   # they migrate into runtime/ once that's confirmed.
research/
  pine/            # the Pine Script research lab. 4 files at top level
                   # match the 3 live configs; research/pine/archive/
                   # holds superseded/rejected variants with a
                   # MANIFEST.md (role, locked result, reason archived).
  ml/              # reserved for future AI/ML research artifacts -
                   # empty for now.
src/               # the TypeScript framework. Currently a MIX of:
                   #   - a new, empty interfaces-only skeleton
                   #     (pipeline.ts, strategy/, execution/, ai/,
                   #     configSchema.ts) - no trading logic.
                   #   - an EARLIER, complete SMC-based implementation
                   #     attempt (core/, config/, direction/, entry/,
                   #     exchange/, exit/, indicators/, notify/,
                   #     regime/, risk/, analysis/) - not currently
                   #     wired to anything live, proposed for
                   #     relocation to research/ (see docs/decisions.md),
                   #     not yet moved.
tests/             # mirrors src/ - same old/new mix as above.
tools/             # operational scripts: status.py (read-only dashboard),
                   # init_bot_db.py, import_history.py, compare_state.py,
                   # bot_db_schema.sql, plus two standalone analysis
                   # tools (backtest_tjl_v2_binance.py, a Python replica
                   # with a known unresolved divergence vs real Pine -
                   # see its own header; btc_momentum_scanner.sh, a
                   # disabled-but-kept-alive legacy scanner).
config/            # symbols.json / risk.json / fees.json - PROVISIONAL
                   # values for the eventual TS engine, every field
                   # marked as such (fill_model marked "undecided").
docs/              # decisions.md (read this first), db_conventions.md,
                   # ARCHITECTURE.md / AGENTS.md / CLAUDE.md (prior
                   # project's own docs, untouched).
scripts/           # dev tooling for the src/ TypeScript code (fetch
                   # OHLCV, run backtests) - same old/new mix as src/.
data/              # ~88MB cached OHLCV + backtest results, tied to the
                   # earlier SMC implementation attempt (gitignored
                   # except .gitkeep).
```

## Running the live scanner's own tools

```bash
python legacy/scanners/tjl_forward_scanner.py   # manual one-off run (same code the scheduled task runs)
python tools/compare_state.py                    # verify JSON vs bot.db agree exactly, trade by trade
python tools/status.py                           # one-screen status (see above)
```

Never edit `legacy/scanners/` or the `*_forward_state.json` /
`*_forward_trades.jsonl` files by hand while the scheduled task
(`TjlForwardScanner`) is enabled - see `docs/db_conventions.md` for the
dual-write safety rules and `docs/decisions.md` for why those files are
still the source of truth.
