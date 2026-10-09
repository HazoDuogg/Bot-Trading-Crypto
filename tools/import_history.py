#!/usr/bin/env python3
"""
One-time history import: loads every existing *_forward_trades.jsonl row
into bot.db's trades table, and seeds scanner_state from the current
*_forward_state.json files. Run ONCE, while TjlForwardScanner is
DISABLED (to avoid racing a live tick's own dual-write), then re-enable
the task.

source='import' for trades with entry_time before the forward-test
consolidation cutover (2026-09-22T02:41:19Z, i.e. backfilled/retroactive
rows from each config's own first-run catch-up); 'live' for trades at or
after it. mode='sim' for everything (no paper/testnet/live trading has
happened). Derived fields (fee_pct, net_return_pct, r_multiple,
bars_held, stop_pct) use the EXACT SAME derive_trade_db_fields() used by
the live dual-write path, with notes='derived at import' so these rows
are distinguishable from trades inserted live going forward (which get
notes=NULL).

Safe to re-run: every insert is ON CONFLICT DO NOTHING on
(config_id, side, entry_time_ms), so re-running just reports everything
as already-present/ignored rather than duplicating.
"""
import json
import os
import sys
from datetime import datetime, timezone

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(REPO_ROOT, "legacy", "scanners"))

import db_writer as db  # noqa: E402
import tjl_forward_scanner as tfs  # noqa: E402 - for SYMBOLS (config lookup) and load_state

CUTOVER_MS = int(datetime(2026, 9, 22, 2, 41, 19, tzinfo=timezone.utc).timestamp() * 1000)


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


def main():
    conn = db.open_conn()
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    total_import = 0
    total_live = 0
    total_inserted = 0
    total_ignored = 0
    per_config_counts = {}

    for symbol, cfg in tfs.SYMBOLS.items():
        prefix = cfg["state_prefix"]
        for variant_name, variant_cfg in cfg["variants"].items():
            config_id = db.get_config_id(conn, symbol, variant_name)
            trades = load_trades_jsonl(tfs.trades_path(prefix, variant_name))

            n_import = n_live = n_inserted = n_ignored = 0
            for trade in trades:
                source = "import" if trade["entry_time"] < CUTOVER_MS else "live"
                if source == "import":
                    n_import += 1
                else:
                    n_live += 1
                inserted = db.insert_trade(
                    conn, config_id, trade, variant_cfg, source=source, mode="sim",
                    notes="derived at import", created_at=now,
                )
                if inserted:
                    n_inserted += 1
                else:
                    n_ignored += 1

            per_config_counts[f"{symbol}/{variant_name}"] = {
                "total_trades": len(trades), "import": n_import, "live": n_live,
                "inserted": n_inserted, "ignored_duplicate": n_ignored,
            }
            total_import += n_import
            total_live += n_live
            total_inserted += n_inserted
            total_ignored += n_ignored

            # Seed scanner_state from the current state file (requirement 4).
            state = tfs.load_state(prefix, variant_name)
            db.upsert_scanner_state(conn, config_id, state)

    conn.commit()
    conn.close()

    print("=== Import summary, per config ===")
    for key, c in per_config_counts.items():
        print(f"  {key}: {c['total_trades']} trades total "
              f"({c['import']} import / {c['live']} live), "
              f"inserted {c['inserted']}, ignored (duplicate) {c['ignored_duplicate']}")
    print(f"\nTOTAL: {total_import} import-sourced, {total_live} live-sourced, "
          f"{total_inserted} inserted, {total_ignored} ignored as duplicates")

    print("\n=== Reconciliation against the Oct 9 review's live-trade counts ===")
    expected_live = {
        "BTCUSDT/v2": 14, "BTCUSDT/v2c": 14, "BTCUSDT/v2e": 13, "BTCUSDT/v2f": 6,
        "ETHUSDT/v2f": 5, "SOLUSDT/v2e": 8,
    }
    any_diff = False
    for key, expected in expected_live.items():
        actual = per_config_counts[key]["live"]
        status = "OK" if actual == expected else "DIFFERENT"
        if actual != expected:
            any_diff = True
        print(f"  {key}: expected {expected} (from Oct 9 review), actual (now) {actual} -> {status}")
    if any_diff:
        print("\n  NOTE: differences are expected if real time has passed and new live trades")
        print("  closed between the Oct 9 review and this import run - not necessarily an error.")
        print("  Reported here, not rounded away, per instruction.")
    else:
        print("\n  All 6 configs match the Oct 9 review's live-trade counts exactly.")


if __name__ == "__main__":
    main()
