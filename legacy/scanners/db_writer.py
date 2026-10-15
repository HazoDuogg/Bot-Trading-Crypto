"""
Dual-write helper for tjl_forward_scanner.py. This module NEVER makes a
trading decision and is NEVER read by the scanner's simulation logic -
it only records what the scanner (which has already decided everything
and already written its JSON files) did, into runtime/bot.db.

Every function here that touches the DB is written assuming the caller
wraps it in try/except at the outermost level (see main()'s db_section
in tjl_forward_scanner.py) - a DB failure anywhere in this module must
never propagate up and block the scanner or alter its JSON output.

Per docs/db_conventions.md: every connection sets busy_timeout and
foreign_keys itself (open_conn() below is the ONE shared place that does
this for the Python side - tools/init_bot_db.py and tools/compare_state.py
import it from here rather than re-implementing it).
"""
import json
import os
import sqlite3

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DB_PATH = os.path.join(REPO_ROOT, "runtime", "bot.db")

FEE_PCT_PER_FILL = 0.075
FEE_PCT_ROUND_TRIP = FEE_PCT_PER_FILL * 2  # 0.15

# feature_version=1 keys written into signals.features_json - see
# docs/db_conventions.md for the authoritative documented list. Keep
# these two in sync if either changes.
FEATURE_VERSION = 1


def open_conn(db_path=None):
    conn = sqlite3.connect(db_path or DB_PATH)
    conn.execute("PRAGMA busy_timeout = 5000")
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def open_conn_readonly(db_path=None):
    """Read-only connection via a URI with mode=ro - sqlite3.connect() on a
    plain path silently CREATES an empty (schemaless) file if none exists,
    which is wrong for a pure read path (a missing bot.db should fail
    loudly enough to log, not leave a confusing empty file behind). mode=ro
    raises sqlite3.OperationalError ("unable to open database file") if the
    file doesn't exist, instead of creating it. Used by
    load_state_checked()'s DB cross-check only - the write path keeps using
    open_conn() above, unchanged, since it legitimately needs to create the
    file on first-ever use."""
    path = db_path or DB_PATH
    uri = f"file:{path}?mode=ro"
    conn = sqlite3.connect(uri, uri=True)
    conn.execute("PRAGMA busy_timeout = 5000")
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


_config_id_cache = {}


def load_state_from_db(conn, config_id):
    """Pure DB reader for scanner_state, read-only. Returns a dict in the
    SAME shape as tjl_forward_scanner.py's load_state()'s JSON-sourced
    dict, or None if there is no row for this config_id. Never raises on
    a missing row (that's a normal, expected case - e.g. before the
    first dual-write tick for a brand-new config); callers wrap the
    connection/query itself in try/except for real DB problems."""
    row = conn.execute(
        """SELECT position, entry_price, entry_time_ms, initial_stop, tp_price,
                  highest_since_entry, lowest_since_entry, last_processed_bar_time_ms,
                  last_scan_at, last_result, should_notify, notify_reason
           FROM scanner_state WHERE config_id = ?""",
        (config_id,),
    ).fetchone()
    if row is None:
        return None
    (position, entry_price, entry_time_ms, initial_stop, tp_price,
     highest_since_entry, lowest_since_entry, last_processed_bar_time_ms,
     last_scan_at, last_result, should_notify, notify_reason) = row
    return {
        "position": position,
        "entry_price": entry_price,
        "entry_time": entry_time_ms,
        "initial_stop": initial_stop,
        "tp_price": tp_price,
        "highest_since_entry": highest_since_entry,
        "lowest_since_entry": lowest_since_entry,
        "last_processed_bar_time": last_processed_bar_time_ms,
        "last_scan_at": last_scan_at,
        "last_result": last_result,
        "should_notify": bool(should_notify),
        "notify_reason": notify_reason,
    }


def get_config_id(conn, symbol, variant):
    key = (symbol, variant)
    if key in _config_id_cache:
        return _config_id_cache[key]
    row = conn.execute(
        "SELECT id FROM configs WHERE symbol = ? AND variant = ?", (symbol, variant)
    ).fetchone()
    if row is None:
        raise ValueError(f"no configs row for symbol={symbol!r} variant={variant!r} - run tools/init_bot_db.py's seeding or add it")
    _config_id_cache[key] = row[0]
    return row[0]


def insert_run_start(conn, started_at, trigger="scheduled"):
    """Own small transaction, committed immediately, so this row survives
    even if the rest of the scan's DB writes fail entirely - durability
    for diagnosing a run that never finishes."""
    cur = conn.execute(
        "INSERT INTO runs (started_at, trigger) VALUES (?, ?)", (started_at, trigger)
    )
    conn.commit()
    return cur.lastrowid


def update_run_finish(conn, run_id, finished_at, exit_code, bars_processed, error=None):
    """Own small transaction, committed immediately - same durability
    reasoning as insert_run_start."""
    conn.execute(
        "UPDATE runs SET finished_at = ?, exit_code = ?, bars_processed = ?, error = ? WHERE id = ?",
        (finished_at, exit_code, bars_processed, error, run_id),
    )
    conn.commit()


def derive_trade_db_fields(trade, cfg):
    """Pure function, no DB/IO - derives the DB-only fields (fee_pct,
    net_return_pct, r_multiple, exit_reason, stop_pct, bars_held) from a
    trade record exactly as it already exists in the *_forward_trades.jsonl
    files, plus that config's exit_style/rr_mult. Used identically by the
    live dual-write path AND tools/import_history.py, so historical and
    live rows are derived the same way.

    Does NOT need process_variant()'s internal state: for fixed_tp exit
    style, a losing trade's exit_price IS the initial stop exactly, and a
    winning trade's exit_price IS entry +/- rr_mult*stop_distance - so the
    stop distance (and therefore stop_pct and R) can be backed out exactly
    from entry/exit/return_pct alone. For trailing-exit variants (v2/v2c)
    the exit price is NOT a fixed function of a single stop distance (it
    moves bar-by-bar), so stop_pct/r_multiple are left as None there -
    exit_reason is always 'trail' for those.
    """
    gross_return_pct = trade["return_pct"]
    fee_pct = FEE_PCT_ROUND_TRIP
    net_return_pct = gross_return_pct - fee_pct

    exit_style = cfg["exit_style"]
    side = trade["side"]
    entry_price = trade["entry_price"]
    exit_price = trade["exit_price"]

    if exit_style == "trail":
        exit_reason = "trail"
        stop_pct = None
        r_multiple = None
    else:  # fixed_tp
        rr_mult = cfg["rr_mult"]
        is_win = gross_return_pct > 0
        if side == "Long":
            stop_dist = (entry_price - exit_price) if not is_win else (exit_price - entry_price) / rr_mult
        else:  # Short
            stop_dist = (exit_price - entry_price) if not is_win else (entry_price - exit_price) / rr_mult
        stop_pct = stop_dist / entry_price if entry_price else None
        exit_reason = "tp" if is_win else "stop"
        r_multiple = (net_return_pct / (stop_pct * 100)) if stop_pct else None

    bars_held = None
    try:
        bars_held = round((trade["exit_time"] - trade["entry_time"]) / (15 * 60 * 1000))
    except (KeyError, ZeroDivisionError, TypeError):
        pass

    return {
        "fee_pct": fee_pct,
        "net_return_pct": net_return_pct,
        "exit_reason": exit_reason,
        "stop_pct": stop_pct,
        "r_multiple": r_multiple,
        "bars_held": bars_held,
    }


def insert_trade(conn, config_id, trade, cfg, source, mode="sim", notes=None, created_at=None):
    """ON CONFLICT DO NOTHING on (config_id, side, entry_time_ms) - returns
    True if a new row was actually inserted, False if it was a duplicate
    (already present, silently ignored per spec). Caller is responsible
    for counting/logging ignored duplicates."""
    derived = derive_trade_db_fields(trade, cfg)
    cur = conn.execute(
        """INSERT INTO trades
           (config_id, side, entry_time_ms, entry_price, exit_time_ms, exit_price,
            gross_return_pct, fee_pct, net_return_pct, r_multiple, exit_reason,
            stop_pct, bars_held, source, mode, notes, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (config_id, side, entry_time_ms) DO NOTHING""",
        (
            config_id, trade["side"].lower(), trade["entry_time"], trade["entry_price"],
            trade["exit_time"], trade["exit_price"], trade["return_pct"],
            derived["fee_pct"], derived["net_return_pct"], derived["r_multiple"],
            derived["exit_reason"], derived["stop_pct"], derived["bars_held"],
            source, mode, notes, created_at,
        ),
    )
    return cur.rowcount == 1


def upsert_scanner_state(conn, config_id, state):
    conn.execute(
        """INSERT INTO scanner_state
           (config_id, position, entry_price, entry_time_ms, initial_stop, tp_price,
            highest_since_entry, lowest_since_entry, last_processed_bar_time_ms,
            last_scan_at, last_result, should_notify, notify_reason)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (config_id) DO UPDATE SET
             position = excluded.position,
             entry_price = excluded.entry_price,
             entry_time_ms = excluded.entry_time_ms,
             initial_stop = excluded.initial_stop,
             tp_price = excluded.tp_price,
             highest_since_entry = excluded.highest_since_entry,
             lowest_since_entry = excluded.lowest_since_entry,
             last_processed_bar_time_ms = excluded.last_processed_bar_time_ms,
             last_scan_at = excluded.last_scan_at,
             last_result = excluded.last_result,
             should_notify = excluded.should_notify,
             notify_reason = excluded.notify_reason""",
        (
            config_id, state["position"], state["entry_price"], state["entry_time"],
            state["initial_stop"], state["tp_price"], state["highest_since_entry"],
            state["lowest_since_entry"], state["last_processed_bar_time"],
            state["last_scan_at"], state["last_result"],
            1 if state["should_notify"] else 0, state["notify_reason"],
        ),
    )


def insert_signal(conn, config_id, ts, bar_time_ms, result, position, closed_trades_this_run,
                   feature_snapshot, created_at):
    """One row per (config, tick). row_type='event' whenever this tick
    produced a PASS_LONG/PASS_SHORT result OR closed >=1 trade; otherwise
    'per_bar'. See docs/db_conventions.md for the feature_version=1 key
    list stored in features_json."""
    is_event = result in ("PASS_LONG", "PASS_SHORT") or closed_trades_this_run > 0
    row_type = "event" if is_event else "per_bar"
    conn.execute(
        """INSERT INTO signals (config_id, ts, bar_time_ms, result, position,
                                 row_type, feature_version, features_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            config_id, ts, bar_time_ms, result, position, row_type,
            FEATURE_VERSION, json.dumps(feature_snapshot) if feature_snapshot is not None else None,
            created_at,
        ),
    )
