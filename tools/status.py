#!/usr/bin/env python3
"""
One-screen, read-only status summary: task health (via schtasks, a
read-only query - never touches the task), bot.db integrity, per-config
live performance (net of fees), runtime/ size vs budget, and forward-
test elapsed time.

Read-only everywhere: never writes to bot.db, never writes to the JSON
files, never changes the scheduled task. Counts 'live'-sourced trades
only (never 'import') for all performance figures, per instruction.
"""
import json
import os
import subprocess
import sys
from datetime import datetime, timezone

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(REPO_ROOT, "legacy", "scanners"))

import db_writer as db  # noqa: E402
import tjl_forward_scanner as tfs  # noqa: E402

RUNTIME_BUDGET_BYTES = 200 * 1024 * 1024  # 200 MB
TASK_NAME = "TjlForwardScanner"


def get_task_status():
    try:
        out = subprocess.run(
            ["schtasks", "/query", "/tn", TASK_NAME, "/fo", "list", "/v"],
            capture_output=True, text=True, timeout=15,
        )
        if out.returncode != 0:
            return {"error": out.stderr.strip() or "schtasks query failed"}
        info = {}
        for line in out.stdout.splitlines():
            if ":" in line:
                k, _, v = line.partition(":")
                info[k.strip()] = v.strip()
        return {
            "status": info.get("Scheduled Task State", "?"),
            "last_run_time": info.get("Last Run Time", "?"),
            "last_result": info.get("Last Result", "?"),
            "next_run_time": info.get("Next Run Time", "?"),
        }
    except Exception as e:  # noqa: BLE001
        return {"error": str(e)}


def dir_size_bytes(path):
    total = 0
    for root, _dirs, files in os.walk(path):
        for f in files:
            try:
                total += os.path.getsize(os.path.join(root, f))
            except OSError:
                pass
    return total


def main():
    print("=" * 78)
    print("TJL FORWARD-TEST SCANNER - STATUS")
    print("=" * 78)

    # --- Task state ---
    task = get_task_status()
    print(f"\nTask ({TASK_NAME}):")
    if "error" in task:
        print(f"  COULD NOT QUERY: {task['error']}")
    else:
        print(f"  State:        {task['status']}")
        print(f"  Last run:     {task['last_run_time']}")
        print(f"  Last result:  {task['last_result']}")
        print(f"  Next run:     {task['next_run_time']}")

    # --- DB connection + integrity ---
    try:
        conn = db.open_conn()
    except Exception as e:  # noqa: BLE001
        print(f"\nCOULD NOT OPEN bot.db: {e}")
        return

    integrity = conn.execute("PRAGMA integrity_check").fetchone()[0]
    print(f"\nDB integrity_check: {integrity}")

    last_run = conn.execute(
        "SELECT id, started_at, finished_at, exit_code, bars_processed, error FROM runs ORDER BY id DESC LIMIT 1"
    ).fetchone()
    print("\nMost recent runs row:")
    if last_run:
        rid, started, finished, exit_code, bars, error = last_run
        print(f"  id={rid} started_at={started} finished_at={finished} exit_code={exit_code} bars_processed={bars}")
        print(f"  error: {error if error else '(none)'}")
    else:
        print("  (no runs recorded yet)")

    recent_errors = conn.execute(
        "SELECT COUNT(*) FROM runs WHERE error IS NOT NULL"
    ).fetchone()[0]
    print(f"  Total runs with a recorded error (all time): {recent_errors}")

    # --- Per-config live performance (net of fees) ---
    print("\nPer-config (LIVE-sourced trades only, net of fees):")
    print(f"  {'config':<16} {'trades':>7} {'win%':>7} {'net%':>9} {'position':>9}")
    for symbol, cfg in tfs.SYMBOLS.items():
        for variant_name in cfg["variants"]:
            config_id = db.get_config_id(conn, symbol, variant_name)
            label = f"{symbol}/{variant_name}"
            rows = conn.execute(
                "SELECT net_return_pct FROM trades WHERE config_id = ? AND source = 'live'",
                (config_id,),
            ).fetchall()
            n = len(rows)
            if n:
                wins = sum(1 for (r,) in rows if r > 0)
                win_pct = wins / n * 100
                net_pct = sum(r for (r,) in rows)
            else:
                win_pct = net_pct = 0.0
            state_row = conn.execute(
                "SELECT position FROM scanner_state WHERE config_id = ?", (config_id,)
            ).fetchone()
            pos_str = {0: "flat", 1: "LONG", -1: "SHORT"}.get(state_row[0] if state_row else 0, "?")
            print(f"  {label:<16} {n:>7} {win_pct:>6.1f}% {net_pct:>+8.2f}% {pos_str:>9}")

    # --- runtime/ size vs budget ---
    runtime_dir = os.path.join(REPO_ROOT, "runtime")
    size = dir_size_bytes(runtime_dir)
    pct = size / RUNTIME_BUDGET_BYTES * 100
    flag = " ** OVER BUDGET **" if size > RUNTIME_BUDGET_BYTES else ""
    print(f"\nruntime/ size: {size/1024/1024:.1f} MB / {RUNTIME_BUDGET_BYTES/1024/1024:.0f} MB budget ({pct:.1f}%){flag}")

    # --- forward_test_start + elapsed ---
    meta_row = conn.execute("SELECT value FROM meta WHERE key = 'forward_test_start'").fetchone()
    if meta_row:
        start = datetime.fromisoformat(meta_row[0].replace("Z", "+00:00"))
        elapsed = datetime.now(timezone.utc) - start
        print(f"\nForward-test start: {meta_row[0]} ({elapsed.days} days, {elapsed.seconds // 3600}h elapsed)")
    else:
        print("\nForward-test start: NOT SET in meta")

    conn.close()
    print("\n" + "=" * 78)


if __name__ == "__main__":
    main()
