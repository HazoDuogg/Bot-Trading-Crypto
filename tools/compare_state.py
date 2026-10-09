#!/usr/bin/env python3
"""
Compares the JSON files (still the source of truth) against bot.db,
trade by trade - not just counts. For each config: every trade in the
JSONL file must have a matching DB row (same config, side, entry_time,
entry_price, exit_time, exit_price, pnl_pct within 1e-9), and vice versa
(every DB trade must have a matching JSON trade) - plus current open
position and last_processed_bar_time must match exactly.

Prints every mismatching row it finds; prints a clean summary if
everything matches. Exit code 0 if everything matches, 1 otherwise (so
this can be scripted/alerted on later if desired).

This is a read-only comparison tool - it never writes to either the
JSON files or bot.db.
"""
import json
import os
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(REPO_ROOT, "legacy", "scanners"))

import db_writer as db  # noqa: E402
import tjl_forward_scanner as tfs  # noqa: E402

TOLERANCE = 1e-9


def load_trades_jsonl(path):
    trades = []
    if not os.path.exists(path):
        return trades
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                trades.append(json.loads(line))
    return trades


def trade_key(side, entry_time_ms):
    return (side.lower(), entry_time_ms)


def main():
    conn = db.open_conn()
    any_mismatch = False
    total_json_trades = 0
    total_db_trades = 0
    total_matched = 0

    for symbol, cfg in tfs.SYMBOLS.items():
        prefix = cfg["state_prefix"]
        for variant_name, variant_cfg in cfg["variants"].items():
            label = f"{symbol}/{variant_name}"
            config_id = db.get_config_id(conn, symbol, variant_name)

            json_trades = load_trades_jsonl(tfs.trades_path(prefix, variant_name))
            json_by_key = {trade_key(t["side"], t["entry_time"]): t for t in json_trades}

            db_rows = conn.execute(
                """SELECT side, entry_time_ms, entry_price, exit_time_ms, exit_price, gross_return_pct
                   FROM trades WHERE config_id = ?""",
                (config_id,),
            ).fetchall()
            db_by_key = {trade_key(r[0], r[1]): r for r in db_rows}

            total_json_trades += len(json_trades)
            total_db_trades += len(db_rows)

            json_keys = set(json_by_key)
            db_keys = set(db_by_key)

            only_in_json = json_keys - db_keys
            only_in_db = db_keys - json_keys
            in_both = json_keys & db_keys

            for k in sorted(only_in_json):
                any_mismatch = True
                print(f"MISMATCH [{label}] trade in JSON but missing from DB: side={k[0]} entry_time={k[1]} "
                      f"json_row={json_by_key[k]}")
            for k in sorted(only_in_db):
                any_mismatch = True
                print(f"MISMATCH [{label}] trade in DB but missing from JSON: side={k[0]} entry_time={k[1]} "
                      f"db_row={db_by_key[k]}")

            for k in sorted(in_both):
                jt = json_by_key[k]
                dr = db_by_key[k]
                db_side, db_entry_ms, db_entry_px, db_exit_ms, db_exit_px, db_pnl = dr
                mismatches = []
                if jt["entry_price"] != db_entry_px and abs(jt["entry_price"] - db_entry_px) > TOLERANCE:
                    mismatches.append(f"entry_price json={jt['entry_price']} db={db_entry_px}")
                if jt["exit_time"] != db_exit_ms:
                    mismatches.append(f"exit_time json={jt['exit_time']} db={db_exit_ms}")
                if abs(jt["exit_price"] - db_exit_px) > TOLERANCE:
                    mismatches.append(f"exit_price json={jt['exit_price']} db={db_exit_px}")
                if abs(jt["return_pct"] - db_pnl) > TOLERANCE:
                    mismatches.append(f"pnl_pct json={jt['return_pct']} db={db_pnl}")
                if mismatches:
                    any_mismatch = True
                    print(f"MISMATCH [{label}] side={k[0]} entry_time={k[1]}: " + "; ".join(mismatches))
                else:
                    total_matched += 1

            # Open position + last_processed_bar_time
            state = tfs.load_state(prefix, variant_name)
            state_row = conn.execute(
                "SELECT position, entry_time_ms, last_processed_bar_time_ms FROM scanner_state WHERE config_id = ?",
                (config_id,),
            ).fetchone()
            if state_row is None:
                any_mismatch = True
                print(f"MISMATCH [{label}] no scanner_state row in DB at all")
            else:
                db_position, db_entry_time_ms, db_last_bar_ms = state_row
                if state["position"] != db_position:
                    any_mismatch = True
                    print(f"MISMATCH [{label}] position: json={state['position']} db={db_position}")
                if state["entry_time"] != db_entry_time_ms:
                    any_mismatch = True
                    print(f"MISMATCH [{label}] open-position entry_time: json={state['entry_time']} db={db_entry_time_ms}")
                if state["last_processed_bar_time"] != db_last_bar_ms:
                    any_mismatch = True
                    print(f"MISMATCH [{label}] last_processed_bar_time: json={state['last_processed_bar_time']} db={db_last_bar_ms}")

    conn.close()

    print(f"\n=== Summary: {total_json_trades} JSON trades, {total_db_trades} DB trades, "
          f"{total_matched} fully matched trade-by-trade ===")
    if any_mismatch:
        print("RESULT: MISMATCHES FOUND - see above")
        sys.exit(1)
    else:
        print("RESULT: CLEAN MATCH - every trade, open position, and last_processed_bar_time agree exactly")
        sys.exit(0)


if __name__ == "__main__":
    main()
