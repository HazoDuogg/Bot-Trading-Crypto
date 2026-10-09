#!/usr/bin/env python3
"""
One-time initializer for runtime/bot.db. Creates the schema (see the DDL
in this script), seeds `configs` from the live scanner's own SYMBOLS dict
(legacy/scanners/tjl_forward_scanner.py - imported directly, not
duplicated, so configs always matches what's actually running), and
seeds `meta`.

Does NOT touch the JSON files, does NOT implement dual-write - this only
creates the empty (except for configs/meta) database. Safe to re-run:
exits early if runtime/bot.db already exists.

Every connection this project ever opens to bot.db must set
busy_timeout and foreign_keys itself (they don't persist in the file) -
see docs/db_conventions.md.
"""
import os
import sqlite3
import sys
from datetime import datetime, timezone

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RUNTIME_DIR = os.path.join(REPO_ROOT, "runtime")
DB_PATH = os.path.join(RUNTIME_DIR, "bot.db")
SCHEMA_PATH = os.path.join(REPO_ROOT, "tools", "bot_db_schema.sql")

FORWARD_TEST_START = "2026-09-22T02:41:19Z"
SCHEMA_VERSION = "1"


def open_conn():
    """Shared open-connection helper - every caller anywhere in this
    project's Python code must go through this (or replicate both
    pragmas exactly) rather than call sqlite3.connect() directly."""
    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA busy_timeout = 5000")
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def main():
    os.makedirs(RUNTIME_DIR, exist_ok=True)

    if os.path.exists(DB_PATH):
        print(f"ABORT: {DB_PATH} already exists - not overwriting. Delete it first if you really want to recreate it.")
        sys.exit(1)

    with open(SCHEMA_PATH, encoding="utf-8") as f:
        schema_sql = f.read()

    conn = open_conn()
    try:
        conn.executescript(schema_sql)

        sys.path.insert(0, os.path.join(REPO_ROOT, "legacy", "scanners"))
        import tjl_forward_scanner as tfs  # noqa: E402 - imported for its SYMBOLS dict only

        now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        for symbol, cfg in tfs.SYMBOLS.items():
            prefix = cfg["state_prefix"]
            for variant, vcfg in cfg["variants"].items():
                conn.execute(
                    """INSERT INTO configs
                       (symbol, variant, state_prefix, gate, buffer_mult, rr_mult,
                        exit_style, long_only, created_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        symbol, variant, prefix, vcfg.get("gate", "sma200"),
                        vcfg["buffer_mult"], vcfg.get("rr_mult"), vcfg["exit_style"],
                        1 if vcfg.get("long_only") else 0, now,
                    ),
                )

        conn.execute("INSERT INTO meta (key, value) VALUES ('schema_version', ?)", (SCHEMA_VERSION,))
        conn.execute("INSERT INTO meta (key, value) VALUES ('created_at', ?)", (now,))
        conn.execute("INSERT INTO meta (key, value) VALUES ('forward_test_start', ?)", (FORWARD_TEST_START,))

        conn.commit()
    finally:
        conn.close()

    print(f"Created {DB_PATH}")


if __name__ == "__main__":
    main()
