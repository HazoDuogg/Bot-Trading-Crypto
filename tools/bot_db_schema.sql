-- bot.db schema (runtime/bot.db) - FINAL, as approved.
-- SQLite, WAL mode. Used during the ~24h dual-write period alongside the
-- existing JSON files, which remain the source of truth until compare_state.py
-- confirms an exact match.
--
-- TIMESTAMP CONVENTION (applies to every table below, no exceptions):
--   - Columns suffixed "_ms"  -> INTEGER epoch milliseconds, UTC.
--   - Columns suffixed "_at" or named "ts" -> TEXT, ISO8601 UTC with a
--     trailing "Z" (e.g. "2026-09-22T02:41:19Z"). Never local time anywhere.
--
-- PER-CONNECTION PRAGMAS: only journal_mode=WAL persists in the database
-- file itself. busy_timeout and foreign_keys do NOT persist - every
-- connection (the Python scanner now, the TypeScript bot later) MUST run
-- `PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;` immediately after
-- opening, every time. See docs/db_conventions.md.

PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;

CREATE TABLE configs (
    id              INTEGER PRIMARY KEY,
    symbol          TEXT NOT NULL,              -- 'BTCUSDT' | 'ETHUSDT' | 'SOLUSDT'
    variant         TEXT NOT NULL,               -- 'v2' | 'v2c' | 'v2e' | 'v2f'
    state_prefix    TEXT NOT NULL,                -- '' | 'ethusdt_' | 'solusdt_' (matches today's JSON filename prefix, for the import step)
    gate            TEXT NOT NULL,                 -- 'sma200' | 'trend_structure' | 'none'
    buffer_mult     REAL NOT NULL,
    rr_mult         REAL,                           -- NULL for trailing-exit variants (v2/v2c)
    exit_style      TEXT NOT NULL,                   -- 'trail' | 'fixed_tp'
    long_only       INTEGER NOT NULL DEFAULT 0,       -- 0/1
    created_at      TEXT NOT NULL,                     -- ISO8601 UTC, "Z" suffix
    UNIQUE (symbol, variant)
);

-- Current open-position state per config - one row per config_id, replaces
-- each .tjl_<prefix><variant>_forward_state.json file 1:1.
CREATE TABLE scanner_state (
    config_id                   INTEGER PRIMARY KEY REFERENCES configs(id),
    position                    INTEGER NOT NULL DEFAULT 0,   -- 0 flat, 1 long, -1 short
    entry_price                 REAL,
    entry_time_ms               INTEGER,                       -- epoch ms, UTC
    initial_stop                 REAL,
    tp_price                     REAL,
    highest_since_entry          REAL,
    lowest_since_entry           REAL,
    last_processed_bar_time_ms   INTEGER,                       -- epoch ms, UTC
    last_scan_at                  TEXT,                          -- ISO8601 UTC, "Z" suffix
    last_result                   TEXT,                          -- 'fail_daily' | 'fail_intraday' | 'PASS_LONG' | 'PASS_SHORT'
    should_notify                  INTEGER NOT NULL DEFAULT 0,
    notify_reason                  TEXT
);

-- Closed trades - one row per realized trade, replaces each
-- tjl_<prefix><variant>_forward_trades.jsonl file's lines.
--
-- gross_return_pct is the raw price-move return (no fees). net_return_pct
-- subtracts the round-trip fee_pct. r_multiple is ALWAYS based on
-- net_return_pct (fees included) - never the gross figure.
CREATE TABLE trades (
    id                INTEGER PRIMARY KEY,
    config_id         INTEGER NOT NULL REFERENCES configs(id),
    side              TEXT NOT NULL CHECK (side IN ('long','short')),
    entry_time_ms     INTEGER NOT NULL,                 -- epoch ms, UTC
    entry_price       REAL NOT NULL,
    exit_time_ms      INTEGER NOT NULL,                  -- epoch ms, UTC
    exit_price        REAL NOT NULL,
    gross_return_pct  REAL NOT NULL,                       -- before fees
    fee_pct           REAL NOT NULL DEFAULT 0,              -- round-trip fee applied (e.g. 0.15 = 2x0.075%)
    net_return_pct    REAL NOT NULL,                         -- gross_return_pct - fee_pct
    r_multiple        REAL,                                   -- realized outcome in R, based on net_return_pct (fees included); NULL if not derivable (e.g. trailing-exit variants where R isn't fixed)
    exit_reason       TEXT NOT NULL CHECK (exit_reason IN ('stop','tp','trail','other')),
    stop_pct          REAL,                                    -- initial stop distance as % of entry price at entry time
    bars_held         INTEGER,                                  -- number of 15m bars between entry and exit
    source            TEXT NOT NULL CHECK (source IN ('backfill','live','import')),
    mode              TEXT NOT NULL DEFAULT 'sim' CHECK (mode IN ('sim','paper','testnet','live')),
    notes             TEXT,                                       -- nullable, free-form
    created_at        TEXT NOT NULL,                               -- ISO8601 UTC, "Z" suffix - when this row was written
    UNIQUE (config_id, side, entry_time_ms)
);
CREATE INDEX idx_trades_config_time ON trades(config_id, entry_time_ms);

-- Per-scan signal/decision events, including the feature values available
-- at that moment - this is what the future AI layer (ScoringModel) will
-- eventually train on. row_type distinguishes genuine signal EVENTS
-- (a PASS_LONG/PASS_SHORT firing - kept indefinitely) from routine PER-BAR
-- rows (every tick's fail_daily/fail_intraday result - pruned after 90
-- days, per the retention rule). features_json is a flexible JSON blob
-- since the feature set differs by gate type (sma200 vs trend_structure vs
-- none) and will grow once the AI layer is built; feature_version tracks
-- which schema version of that JSON blob a given row used, so historical
-- rows stay interpretable after the feature set changes.
--
-- result is constrained to the 4 strings the scanner actually emits today
-- (fail_daily, fail_intraday, PASS_LONG, PASS_SHORT - confirmed directly
-- against tjl_forward_scanner.py, no other value is ever produced) plus
-- 'OTHER' as unused headroom for a future variant.
CREATE TABLE signals (
    id              INTEGER PRIMARY KEY,
    config_id       INTEGER NOT NULL REFERENCES configs(id),
    ts              TEXT NOT NULL,                  -- ISO8601 UTC, "Z" suffix - when this scan ran
    bar_time_ms     INTEGER,                         -- epoch ms, UTC - the 15m bar this decision was evaluated on
    result          TEXT NOT NULL CHECK (result IN ('fail_daily','fail_intraday','PASS_LONG','PASS_SHORT','OTHER')),
    position        INTEGER NOT NULL,                    -- position AFTER this bar's evaluation
    row_type        TEXT NOT NULL CHECK (row_type IN ('event','per_bar')),
    feature_version INTEGER NOT NULL DEFAULT 1,              -- schema version of features_json's contents
    features_json   TEXT,                                     -- JSON: {curr_price, daily_high, daily_low, sma200 or gate_state, atr_val, session_high, session_low, ...}
    created_at      TEXT NOT NULL                              -- ISO8601 UTC, "Z" suffix
);
CREATE INDEX idx_signals_config_ts_rowtype ON signals(config_id, ts, row_type);

-- One row per scanner invocation (every 30-min tick, whether or not it did
-- anything) - operational history, replaces grepping tjl_forward_scanner_run_log.txt.
-- Kept 60 days. Row is INSERTed at the start of a scan and UPDATEd at the
-- end (finished_at, exit_code, bars_processed, summary, error) - see
-- docs/db_conventions.md for the one-transaction-per-scan pattern.
-- error is populated whenever a DB write fails during dual-write, so such
-- failures stay visible without ever blocking the scanner itself.
CREATE TABLE runs (
    id              INTEGER PRIMARY KEY,
    started_at      TEXT NOT NULL,                  -- ISO8601 UTC, "Z" suffix
    finished_at     TEXT,                            -- ISO8601 UTC, "Z" suffix
    exit_code       INTEGER,
    bars_processed  INTEGER,
    trigger         TEXT NOT NULL DEFAULT 'scheduled', -- 'scheduled' | 'manual_dry_run'
    summary         TEXT,                              -- the one-line-per-symbol summary text, e.g. "BTCUSDT 4-variant forward scan: v2=flat(fail_daily), ..."
    error           TEXT                                -- nullable; set when a DB write failed during this run (JSON write still succeeded)
);
CREATE INDEX idx_runs_started ON runs(started_at);

-- Single-row-per-key metadata table.
CREATE TABLE meta (
    key     TEXT PRIMARY KEY,
    value   TEXT
);
-- Seeded at creation time with:
--   ('schema_version', '1')
--   ('created_at', '<ISO8601 UTC "Z" suffix, actual creation moment>')
--   ('forward_test_start', '2026-09-22T02:41:19Z')

-- No per-scan snapshot files (the old tjl_btcusdt_2026-*.json-style outputs)
-- are written anywhere in this design - `signals` rows are the replacement.
