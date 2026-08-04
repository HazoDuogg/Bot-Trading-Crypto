"""
TICKET-121 Phần A / Việc 2 — Subgroup breakdown: Decile 10 vs Decile 8 vs full bearish test set,
by symbol, time block, and categorical features (macroDirection/adxDirection1h/atrTrend5m).

Reads data/ticket121-artifacts/{decile10,decile8,full_test}.csv produced by
ticket121Decile10Forensic.py. ANALYSIS ONLY.

Run: apps/ml-training/.venv/Scripts/python.exe apps/ml-training/ticket121SubgroupAnalysis.py
"""
import os
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

import numpy as np
import pandas as pd

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
ARTIFACT_DIR = os.path.join(REPO_ROOT, "data", "ticket121-artifacts")


def load():
    d10 = pd.read_csv(os.path.join(ARTIFACT_DIR, "decile10.csv"))
    d8 = pd.read_csv(os.path.join(ARTIFACT_DIR, "decile8.csv"))
    full = pd.read_csv(os.path.join(ARTIFACT_DIR, "full_test.csv"))
    for d in (d10, d8, full):
        d["_ts"] = pd.to_datetime(d["timestampUtc"], unit="ms", utc=True)
    return d10, d8, full


def symbol_breakdown(d10, d8, full):
    rows = []
    symbols = sorted(full["symbol"].unique())
    for sym in symbols:
        for name, d in (("Decile10", d10), ("Decile8", d8), ("FullTest", full)):
            sub = d[d["symbol"] == sym]
            pct = len(sub) / len(d) * 100
            wr = sub["label_win"].mean() if len(sub) else float("nan")
            rows.append({"symbol": sym, "group": name, "n": len(sub), "pct_of_group": pct, "winrate": wr})
    out = pd.DataFrame(rows)
    out.to_csv(os.path.join(ARTIFACT_DIR, "symbol_breakdown.csv"), index=False)
    print("\n=== Symbol breakdown ===")
    print(out.to_string(index=False))
    return out


def time_block_breakdown(d10, d8, full, n_days=4):
    start = full["_ts"].min().normalize()
    end = full["_ts"].max()
    blocks = pd.date_range(start, end + pd.Timedelta(days=n_days), freq=f"{n_days}D", tz="UTC")
    rows = []
    for i in range(len(blocks) - 1):
        b_start, b_end = blocks[i], blocks[i + 1]
        label = f"{b_start.date()}..{b_end.date()}"
        for name, d in (("Decile10", d10), ("Decile8", d8), ("FullTest", full)):
            sub = d[(d["_ts"] >= b_start) & (d["_ts"] < b_end)]
            wr = sub["label_win"].mean() if len(sub) else float("nan")
            rows.append({"block": label, "group": name, "n": len(sub), "winrate": wr})
    out = pd.DataFrame(rows)
    out.to_csv(os.path.join(ARTIFACT_DIR, "time_block_breakdown.csv"), index=False)
    print(f"\n=== Time block breakdown ({n_days}-day blocks, range {start.date()}..{end.date()}) ===")
    print(out.to_string(index=False))
    return out


def categorical_breakdown(d10, d8, full, col):
    rows = []
    for name, d in (("Decile10", d10), ("Decile8", d8), ("FullTest", full)):
        vc = d[col].value_counts(normalize=True) * 100
        wr = d.groupby(col)["label_win"].mean()
        for val in vc.index:
            rows.append({
                "feature": col, "value": val, "group": name,
                "pct_of_group": vc[val], "n": int(d[col].value_counts()[val]),
                "winrate": wr.get(val, float("nan")),
            })
    out = pd.DataFrame(rows)
    out.to_csv(os.path.join(ARTIFACT_DIR, f"categorical_{col}_breakdown.csv"), index=False)
    print(f"\n=== {col} breakdown ===")
    print(out.to_string(index=False))
    return out


def macro_short_cross(d10, d8, full):
    # Specific check: macroDirection=UP while betting SHORT ("against macro trend")
    rows = []
    for name, d in (("Decile10", d10), ("Decile8", d8), ("FullTest", full)):
        n_up = (d["macroDirection"] == "UP").sum()
        pct_up = n_up / len(d) * 100
        wr_up = d[d["macroDirection"] == "UP"]["label_win"].mean() if n_up else float("nan")
        rows.append({"group": name, "n": len(d), "n_macroUP": int(n_up), "pct_macroUP": pct_up, "winrate_when_macroUP": wr_up})
    out = pd.DataFrame(rows)
    out.to_csv(os.path.join(ARTIFACT_DIR, "macro_up_vs_short_breakdown.csv"), index=False)
    print("\n=== macroDirection=UP while side=SHORT (betting against macro trend) ===")
    print(out.to_string(index=False))
    return out


def main() -> None:
    d10, d8, full = load()
    symbol_breakdown(d10, d8, full)
    time_block_breakdown(d10, d8, full)
    for col in ["macroDirection", "adxDirection1h", "atrTrend5m"]:
        categorical_breakdown(d10, d8, full, col)
    macro_short_cross(d10, d8, full)
    print(f"\nSaved subgroup breakdowns -> {ARTIFACT_DIR}")


if __name__ == "__main__":
    main()
