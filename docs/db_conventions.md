# bot.db conventions

`runtime/bot.db` (SQLite, gitignored). Full schema: `tools/bot_db_schema.sql`
(applied by `tools/init_bot_db.py`, which also seeds `configs` from the live
scanner's own config and seeds `meta`).

## Per-connection pragmas - MUST be set on every open, every language

Only `journal_mode = WAL` is persisted inside the database file itself.
**`busy_timeout` and `foreign_keys` are per-connection settings and do NOT
persist** - every single connection, from any process, in any language,
must run both of these immediately after opening:

```sql
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;
```

This applies to:
- The Python scanner (`legacy/scanners/tjl_forward_scanner.py`) - use the
  shared open-connection helper (one place, not re-implemented per call
  site) once dual-write lands.
- The future TypeScript bot/engine - its DB client must do the same on
  every connection it opens, not just once at startup, if it ever opens
  more than one connection or reconnects.
- Any ad-hoc tool (`tools/compare_state.py`, manual `sqlite3` sessions,
  etc.) - if you open the file directly without going through the shared
  helper, set these two pragmas yourself before doing anything else.

Forgetting `foreign_keys = ON` means the `REFERENCES configs(id)`
constraints on `scanner_state`, `trades`, and `signals` are silently
unenforced. Forgetting `busy_timeout` means a concurrent writer (e.g. a
manual tool running while the scheduled scan fires) gets an immediate
`SQLITE_BUSY` error instead of waiting.

## Timestamp convention (no exceptions)

- Columns suffixed `_ms` → `INTEGER`, epoch milliseconds, UTC.
- Columns suffixed `_at` or named `ts` → `TEXT`, ISO8601 UTC with a
  trailing `Z` (e.g. `2026-09-22T02:41:19Z`).
- Never local time, anywhere, in any table.

## Transaction pattern for a scan run

As actually implemented in `db_write_results()`
(`legacy/scanners/tjl_forward_scanner.py`):

1. At the start of the run, `INSERT` a `runs` row with `started_at` set
   and everything else NULL - committed immediately, in its OWN small
   transaction (`insert_run_start()`). This is deliberate: it must
   survive even if everything below fails entirely, or there would be no
   row left to record the failure on.
2. All of the scan's substantive data writes - every `scanner_state`
   upsert, every new `trades` insert, one `signals` row per config - go
   into **one transaction** (`conn.commit()` once at the end, or
   `conn.rollback()` once if anything raised).
3. Regardless of whether step 2 committed or rolled back, `UPDATE` the
   same `runs` row - in its own small transaction (`update_run_finish()`)
   - with `finished_at`, `exit_code` (0 if step 2 committed cleanly, 1 if
   it rolled back), `bars_processed` (count of configs processed this
   tick), and `error` (NULL if clean, the exception text if step 2
   rolled back).

So there are three small transactions per scan (`runs` insert, the one
substantive data transaction, `runs` update), not literally one - the
"one transaction" in the design brief refers to step 2, the actual scan
data. Splitting the `runs` bookkeeping out is what makes a totally-failed
scan still leave a diagnosable row behind.

## Dual-write safety rules (while JSON is still the source of truth)

- JSON files remain authoritative during the dual-write period. The
  scanner's trading simulation logic never reads from or depends on
  `bot.db` during this period.
- Every DB write is wrapped in `try/except` at the OUTERMOST level of the
  scan's DB-writing code path. A DB failure (locked, disk full, schema
  error, anything) is caught, logged (including to `runs.error` if at all
  possible), and the scanner proceeds to write its JSON files and exit
  with its normal success code exactly as if `bot.db` didn't exist.
- A DB problem must never alter the trading simulation's outcome and must
  never stop the scanner from running.

## signals.features_json - feature_version 1

Written by `build_feature_snapshot()` in `tjl_forward_scanner.py` - a
READ-ONLY, independent re-derivation of the latest bar's market context
from data already fetched for the simulation, never consulted by the
simulation itself. Keys, as of feature_version=1:

| Key | Meaning |
|---|---|
| `bar_time_ms` | epoch ms, UTC - the most recent 15m bar's open time |
| `curr_price` | that bar's close |
| `atr_val` | ATR(14) at that bar |
| `d_high1` | previous completed daily bar's high |
| `d_low1` | previous completed daily bar's low |
| `d_close1` | previous completed daily bar's close |
| `d_sma200_1` | previous completed daily bar's 200-day SMA (null for `gate=none`/`trend_structure` configs where this isn't the gate basis) |
| `gate_allow_long` | whether this config's own gate (sma200 / trend_structure / none) currently permits a Long entry |
| `gate_allow_short` | same, for Short |
| `session_high_excl` | today's UTC session high, excluding the current bar |
| `session_low_excl` | same, for the session low |

If this key list ever changes, bump `FEATURE_VERSION` in
`legacy/scanners/db_writer.py` and add a new row to this table rather
than silently changing what an existing version number means.

## Read-compare policy (state reads)

`load_state_checked()` in `tjl_forward_scanner.py` is the scanner's
state-read path (replacing a bare JSON read at `process_variant()`'s
single call site). **JSON stays authoritative; `bot.db`'s `scanner_state`
is validated against it, never silently preferred:**

- Both present, agree on every trading-relevant field (`position`,
  `entry_price`, `entry_time`, `initial_stop`, `tp_price`,
  `highest_since_entry`, `lowest_since_entry`, `last_processed_bar_time`
  - float fields compared at `1e-9` tolerance, matching
  `tools/compare_state.py`'s convention): return JSON, no warning.
- Both present, disagree on >=1 field: return JSON anyway, write a
  `STATE MISMATCH` warning (naming every differing field and both
  values) to `runs.error` for that tick. `exit_code` is unaffected - a
  mismatch is advisory, not a write failure.
- JSON missing/corrupt, a real DB row exists: use the DB state (never
  the `first_run` default while a DB row exists), write a warning
  noting the fallback.
- DB read fails (including a genuinely missing `bot.db` - see
  `open_conn_readonly()` below) or confirms no row: use JSON, no
  warning (an absent DB row is an expected transient, not worth
  flagging every tick).
- JSON missing/corrupt AND no usable DB row either: falls through to
  the original `load_state()`'s `first_run` default - the only case
  `load_state_checked()` doesn't special-case itself.

The DB read uses `open_conn_readonly()` (`db_writer.py`), a
`sqlite3.connect("file:<path>?mode=ro", uri=True)` connection - unlike a
plain path, this raises instead of silently creating an empty file when
`bot.db` doesn't exist. **This only covers the read path.** The write
path's own `open_conn()` is unchanged and still auto-creates an empty
file on a missing `bot.db` before failing on `"no such table"` - see
`docs/decisions.md`'s open notes.

**Self-healing, verified empirically**: `upsert_scanner_state()`'s
`ON CONFLICT (config_id) DO UPDATE SET ...` unconditionally overwrites
every field every tick, so a one-off `scanner_state` mismatch (DB
tampered, DB row deleted, etc.) heals itself on the very next successful
write - confirmed by re-running the same tampered scratch fixture twice
and seeing the warning disappear after the first tick. **`trades` does
NOT self-heal**: `insert_trade()`'s `ON CONFLICT (config_id, side,
entry_time_ms) DO NOTHING` silently skips an insert when that key
already exists - it never corrects an existing row's other fields, even
if they're wrong.
