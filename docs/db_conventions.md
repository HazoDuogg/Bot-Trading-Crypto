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

Every scan run writes all of its DB changes - the `runs` row, every
`scanner_state` update, every new `trades`/`signals` row - inside **one
transaction**:

1. At the start of the run, `INSERT` a `runs` row with `started_at` set
   and `finished_at`/`exit_code`/`bars_processed`/`summary`/`error` left
   NULL.
2. Do all the scan's own work and accumulate the DB writes for this tick.
3. Immediately before committing, `UPDATE` that same `runs` row with
   `finished_at`, `exit_code`, `bars_processed`, and `summary`.
4. Commit once. If anything in steps 2-3 raised, roll back and instead
   `UPDATE` the `runs` row's `error` column with what went wrong (in a
   SEPARATE connection/transaction, since the first one is being rolled
   back) - then let the scanner continue exactly as it would have with no
   DB at all (see dual-write safety rules below).

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
