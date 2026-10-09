"""
Central paths config for the legacy forward-test scanners
(tjl_forward_scanner.py, run_tjl_forward_scanner_guarded.ps1,
RunHidden_TjlForwardScanner.vbs, btc_momentum_scanner.sh,
run_btc_scan_guarded.ps1 - all under legacy/scanners/ as of the
chore/restructure move, 2026-10-09).

DATA_DIR is kept at the repo root, NOT alongside this file - this
decouples "where the scanner code lives" (legacy/scanners/) from "where
its live state/trade/run-gate/log data lives" (repo root), so moving the
code in this step changes nothing about what data is read or written.

Step 5 of the restructure migrates this data into runtime/ (bot.db) via a
dual-write period before fully cutting over - when that happens, update
DATA_DIR here (or retire this module once the JSON files are retired).
"""
DATA_DIR = r"D:\BotTradingV2"
