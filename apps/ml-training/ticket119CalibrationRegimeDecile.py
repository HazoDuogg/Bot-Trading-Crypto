"""
TICKET-119 — Việc 1 (raw vs calibrated AUC per W1-W4 x bullish/bearish), Việc 2 (AUC-by-regime per
window, using data/training/momentum-v6-labeled-with-regime.csv, TICKET-119's regime capture script),
Việc 3 (decile lift for the 2 v7-original fixed-split Cách B models).

Reuses ticket118Common.py's EXACT feature list, hyperparameters, split/purge logic, verbatim — no
redesign, no retune (per the ticket's explicit instruction). ANALYSIS ONLY.

Run: apps/ml-training/.venv/Scripts/python.exe apps/ml-training/ticket119CalibrationRegimeDecile.py
"""
import os
import statistics
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import numpy as np
import pandas as pd
from sklearn.calibration import CalibratedClassifierCV
from sklearn.frozen import FrozenEstimator
from sklearn.metrics import roc_auc_score
from xgboost import XGBClassifier

from ticket118Common import (
    CATEGORICAL_FEATURES,
    CSV_PATH,
    HORIZON_CANDLES,
    LABEL_COLUMN,
    REPO_ROOT,
    XGB_PARAMS,
    build_features,
    fixed_602020_split,
    load_labeled_df,
    window_split,
)

REGIME_CSV_PATH = os.path.join(REPO_ROOT, "data", "training", "momentum-v6-labeled-with-regime.csv")
REPORT_PATH = os.path.join(REPO_ROOT, "data", "ticket119-calibration-regime-decile-report.md")

WINDOWS = [
    dict(key="w1", train_start="2026-02-11", train_end="2026-03-27", val_end="2026-04-11", test_end="2026-04-26"),
    dict(key="w2", train_start="2026-03-13", train_end="2026-04-27", val_end="2026-05-12", test_end="2026-05-27"),
    dict(key="w3", train_start="2026-04-13", train_end="2026-05-28", val_end="2026-06-12", test_end="2026-06-27"),
    dict(key="w4", train_start="2026-05-14", train_end="2026-06-28", val_end="2026-07-13", test_end="2026-07-29"),
]
SIDES = [("LONG", "bullish"), ("SHORT", "bearish")]


def train_raw_and_calibrated(train_df, val_df, test_df, feature_cols):
    """Fits the raw XGBClassifier (same call as ticket118Common.train_calibrated_model) then wraps in
    CalibratedClassifierCV — returns (raw_test_auc, calibrated_test_auc, model, calib)."""
    X_train = train_df[feature_cols].values.astype(np.float32)
    y_train = train_df[LABEL_COLUMN].values.astype(int)
    X_val = val_df[feature_cols].values.astype(np.float32)
    y_val = val_df[LABEL_COLUMN].values.astype(int)
    X_test = test_df[feature_cols].values.astype(np.float32)
    y_test = test_df[LABEL_COLUMN].values.astype(int)

    model = XGBClassifier(**XGB_PARAMS)
    model.fit(X_train, y_train, eval_set=[(X_val, y_val)], verbose=False)

    raw_p_test = model.predict_proba(X_test)[:, 1]
    raw_auc_test = float(roc_auc_score(y_test, raw_p_test))

    calib = CalibratedClassifierCV(FrozenEstimator(model), method="sigmoid")
    calib.fit(X_val, y_val)
    calib_p_test = calib.predict_proba(X_test)[:, 1]
    calib_auc_test = float(roc_auc_score(y_test, calib_p_test))

    return raw_auc_test, calib_auc_test, model, calib


def main():
    lines = []
    lines.append("# TICKET-119 — Raw vs Calibrated AUC, AUC by Regime, Decile Lift")
    lines.append("")
    lines.append(
        "ANALYSIS ONLY — reproduces TICKET-118's Cách B models in-memory (same features/hyperparameters/"
        "splits, see apps/ml-training/ticket118Common.py + ticket118TrainAndReport.py), no new production "
        "model, no calibration/regime-formula changes. No conclusion on Giai đoạn 2 architecture — "
        "evidence presented plainly per the ticket's explicit instruction."
    )
    lines.append("")

    # ================= VIỆC 1: raw vs calibrated AUC, 8 models =================
    print("=" * 20, "VIỆC 1", "=" * 20)
    df_full = load_labeled_df(CSV_PATH)

    viec1_rows = []  # (side_label, window_key, raw_auc, calib_auc)
    per_side_raw = {"bullish": [], "bearish": []}
    per_side_calib = {"bullish": [], "bearish": []}

    for side_value, side_label in SIDES:
        df_side = df_full[df_full["side"] == side_value].sort_values("timestampUtc").reset_index(drop=True)
        df_side, feature_cols, _ = build_features(df_side, CATEGORICAL_FEATURES)
        for w in WINDOWS:
            train_df, val_df, test_df = window_split(df_side, w["train_start"], w["train_end"], w["val_end"], w["test_end"], purge=HORIZON_CANDLES)
            raw_auc, calib_auc, _, _ = train_raw_and_calibrated(train_df, val_df, test_df, feature_cols)
            print(f"{side_label} {w['key']}: raw_auc_test={raw_auc:.4f} calib_auc_test={calib_auc:.4f}")
            viec1_rows.append((side_label, w["key"], raw_auc, calib_auc))
            per_side_raw[side_label].append(raw_auc)
            per_side_calib[side_label].append(calib_auc)

    lines.append("## Việc 1 — Raw score AUC vs calibrated AUC (8 models: W1-W4 x bullish/bearish)")
    lines.append("")
    lines.append("| Side | Window | Raw AUC (test) | Calibrated AUC (test) |")
    lines.append("|---|---|---|---|")
    for side_label, wkey, raw_auc, calib_auc in viec1_rows:
        lines.append(f"| {side_label} | {wkey.upper()} | {raw_auc:.4f} | {calib_auc:.4f} |")
    lines.append("")
    lines.append("### Dispersion (stdev) across the 4 windows, raw vs calibrated")
    lines.append("")
    lines.append("| Side | Raw AUC stdev | Raw AUC mean | Calibrated AUC stdev | Calibrated AUC mean | More stable? |")
    lines.append("|---|---|---|---|---|---|")
    for side_label in ("bullish", "bearish"):
        raw_stdev = statistics.stdev(per_side_raw[side_label])
        raw_mean = statistics.mean(per_side_raw[side_label])
        calib_stdev = statistics.stdev(per_side_calib[side_label])
        calib_mean = statistics.mean(per_side_calib[side_label])
        more_stable = "raw" if raw_stdev < calib_stdev else ("calibrated" if calib_stdev < raw_stdev else "equal")
        lines.append(f"| {side_label} | {raw_stdev:.4f} | {raw_mean:.4f} | {calib_stdev:.4f} | {calib_mean:.4f} | {more_stable} |")
    lines.append("")

    # ================= VIỆC 2: AUC by regime =================
    print("=" * 20, "VIỆC 2", "=" * 20)
    df_regime_full = pd.read_csv(REGIME_CSV_PATH)
    df_regime_full = df_regime_full.sort_values("timestampUtc").reset_index(drop=True)
    df_regime_full["_ts"] = pd.to_datetime(df_regime_full["timestampUtc"], unit="ms", utc=True)

    lines.append("## Việc 2 — AUC by regime, per window")
    lines.append("")
    lines.append(
        "Regime captured via `apps/bot/scripts/ticket119CaptureRegimeForV6.ts` (re-runs the official "
        "8-flag backtest replay, reads `evaluation.regime` — the new TICKET-119 pass-through field on "
        "`MomentumGateEvaluation` — matched 100% by symbol+timestampUtc+side to all 322,646 rows of "
        "`momentum-v6-labeled.csv`). Only 4 of the 10 `MarketRegime` enum values appear in this dataset: "
        f"{ {k: int(v) for k, v in df_regime_full['regime'].value_counts().items()} }. The other 6 (VOLATILE_CHOP, EVENT_RISK, "
        "DANGER_ZONE, CORRELATED_RISK, LOW_LIQUIDITY, MANIPULATED) never occur for MOMENTUM_DIRECT-gate "
        "candidates in this replay (config-dependent — not claimed to be true generally)."
    )
    lines.append("")

    w1_bullish_regime_dist = None
    w2_bullish_regime_dist = None

    for side_value, side_label in SIDES:
        df_side = df_regime_full[df_regime_full["side"] == side_value].sort_values("timestampUtc").reset_index(drop=True)
        df_side, feature_cols, _ = build_features(df_side, CATEGORICAL_FEATURES)
        lines.append(f"### {side_label.capitalize()} — AUC by regime per window")
        lines.append("")
        for w in WINDOWS:
            train_df, val_df, test_df = window_split(df_side, w["train_start"], w["train_end"], w["val_end"], w["test_end"], purge=HORIZON_CANDLES)
            raw_auc, calib_auc, model, calib = train_raw_and_calibrated(train_df, val_df, test_df, feature_cols)

            X_test = test_df[feature_cols].values.astype(np.float32)
            y_test = test_df[LABEL_COLUMN].values.astype(int)
            p_test = calib.predict_proba(X_test)[:, 1]

            print(f"\n--- {side_label} {w['key']} (overall calib_auc_test={calib_auc:.4f}) ---")
            lines.append(f"**{side_label} — {w['key'].upper()}** (overall calibrated AUC test = {calib_auc:.4f}, n_test={len(test_df):,})")
            lines.append("")
            lines.append("| Regime | n (test) | AUC (test, calibrated) | n (train) | % of test | % of train |")
            lines.append("|---|---|---|---|---|---|")

            regimes_test = test_df["regime"].values
            regimes_train = train_df["regime"].values
            n_test_total = len(test_df)
            n_train_total = len(train_df)
            for regime_val in sorted(set(regimes_test) | set(regimes_train)):
                mask_test = regimes_test == regime_val
                n_test_r = int(mask_test.sum())
                n_train_r = int((regimes_train == regime_val).sum())
                pct_test = 100.0 * n_test_r / n_test_total if n_test_total else 0.0
                pct_train = 100.0 * n_train_r / n_train_total if n_train_total else 0.0
                if n_test_r == 0:
                    auc_str = "n/a (0 rows)"
                elif len(set(y_test[mask_test])) < 2:
                    auc_str = f"n/a (only one class present, n={n_test_r})"
                else:
                    auc_r = float(roc_auc_score(y_test[mask_test], p_test[mask_test]))
                    flag = " ⚠ small sample" if n_test_r < 30 else ""
                    auc_str = f"{auc_r:.4f}{flag}"
                print(f"  {regime_val}: n_test={n_test_r} n_train={n_train_r} auc={auc_str}")
                lines.append(f"| {regime_val} | {n_test_r} | {auc_str} | {n_train_r} | {pct_test:.1f}% | {pct_train:.1f}% |")
            lines.append("")

            if side_label == "bullish" and w["key"] == "w1":
                w1_bullish_regime_dist = {
                    "test": {r: int((regimes_test == r).sum()) for r in sorted(set(regimes_test))},
                    "train": {r: int((regimes_train == r).sum()) for r in sorted(set(regimes_train))},
                    "n_test": n_test_total,
                    "n_train": n_train_total,
                }
            if side_label == "bullish" and w["key"] == "w2":
                w2_bullish_regime_dist = {
                    "test": {r: int((regimes_test == r).sum()) for r in sorted(set(regimes_test))},
                    "train": {r: int((regimes_train == r).sum()) for r in sorted(set(regimes_train))},
                    "n_test": n_test_total,
                    "n_train": n_train_total,
                }

    lines.append("### W1-bullish (worst window, AUC 0.3809 per TICKET-118) vs W2-bullish (best window, AUC 0.6808) — regime distribution comparison")
    lines.append("")
    lines.append("| Regime | W1-bullish test % | W1-bullish train % | W2-bullish test % | W2-bullish train % |")
    lines.append("|---|---|---|---|---|")
    all_regimes = sorted(set(w1_bullish_regime_dist["test"]) | set(w1_bullish_regime_dist["train"]) | set(w2_bullish_regime_dist["test"]) | set(w2_bullish_regime_dist["train"]))
    for r in all_regimes:
        w1_test_pct = 100.0 * w1_bullish_regime_dist["test"].get(r, 0) / w1_bullish_regime_dist["n_test"]
        w1_train_pct = 100.0 * w1_bullish_regime_dist["train"].get(r, 0) / w1_bullish_regime_dist["n_train"]
        w2_test_pct = 100.0 * w2_bullish_regime_dist["test"].get(r, 0) / w2_bullish_regime_dist["n_test"]
        w2_train_pct = 100.0 * w2_bullish_regime_dist["train"].get(r, 0) / w2_bullish_regime_dist["n_train"]
        lines.append(f"| {r} | {w1_test_pct:.1f}% | {w1_train_pct:.1f}% | {w2_test_pct:.1f}% | {w2_train_pct:.1f}% |")
    lines.append("")
    lines.append(
        "Factual only, per the ticket's instruction: the table above lays out whether W1-bullish's regime "
        "mix differs from W2-bullish's — no conclusion drawn about causation or about a regime-segmented "
        "architecture."
    )
    lines.append("")

    # ================= VIỆC 3: decile lift, v7-original bullish + bearish =================
    print("=" * 20, "VIỆC 3", "=" * 20)
    lines.append("## Việc 3 — Decile lift (v7-original fixed-split models only)")
    lines.append("")
    lines.append(
        "`data/training/momentum-v6-labeled.csv` (and its source `data/all-candidates-with-outcomes.csv`, "
        "per TICKET-118's own docstring) does not carry `pnlUsd` — TICKET-110's original pipeline dropped "
        "it. Avg pnlUsd per decile is THEREFORE NOT AVAILABLE from the current dataset; winrate "
        "(`label_win` mean) is reported instead, and no substitute/approximation for pnlUsd is fabricated."
    )
    lines.append("")

    for side_value, side_label in SIDES:
        df_side = df_full[df_full["side"] == side_value].sort_values("timestampUtc").reset_index(drop=True)
        df_side, feature_cols, _ = build_features(df_side, CATEGORICAL_FEATURES)
        train_df, val_df, test_df = fixed_602020_split(df_side, purge=HORIZON_CANDLES)

        X_train = train_df[feature_cols].values.astype(np.float32)
        y_train = train_df[LABEL_COLUMN].values.astype(int)
        X_val = val_df[feature_cols].values.astype(np.float32)
        y_val = val_df[LABEL_COLUMN].values.astype(int)
        X_test = test_df[feature_cols].values.astype(np.float32)
        y_test = test_df[LABEL_COLUMN].values.astype(int)

        model = XGBClassifier(**XGB_PARAMS)
        model.fit(X_train, y_train, eval_set=[(X_val, y_val)], verbose=False)
        calib = CalibratedClassifierCV(FrozenEstimator(model), method="sigmoid")
        calib.fit(X_val, y_val)
        p_test = calib.predict_proba(X_test)[:, 1]

        decile_df = pd.DataFrame({"p": p_test, "win": y_test})
        decile_df["decile"] = pd.qcut(decile_df["p"], 10, labels=False, duplicates="drop") + 1

        print(f"\n--- {side_label} v7-original decile table ---")
        lines.append(f"### {side_label.capitalize()} — v7-original (fixed 60/20/20 split)")
        lines.append("")
        lines.append("| Decile (1=lowest p, 10=highest p) | n rows | mean predicted p | winrate (label_win mean) |")
        lines.append("|---|---|---|---|")
        winrates = []
        for d in sorted(decile_df["decile"].unique()):
            sub = decile_df[decile_df["decile"] == d]
            n = len(sub)
            mean_p = sub["p"].mean()
            winrate = sub["win"].mean()
            winrates.append((d, winrate))
            print(f"  decile {d}: n={n} mean_p={mean_p:.4f} winrate={winrate:.4f}")
            lines.append(f"| {d} | {n} | {mean_p:.4f} | {winrate:.4f} |")
        lines.append("")

        # Describe shape
        wr_values = [w for _, w in winrates]
        is_monotonic = all(wr_values[i] <= wr_values[i + 1] for i in range(len(wr_values) - 1))
        n_inversions = sum(1 for i in range(len(wr_values) - 1) if wr_values[i] > wr_values[i + 1])
        if is_monotonic:
            shape = "monotonic non-decreasing"
        elif n_inversions <= 2:
            shape = f"mostly-monotonic-with-noise ({n_inversions} local inversions out of {len(wr_values) - 1} adjacent pairs)"
        else:
            shape = f"non-monotonic ({n_inversions} local inversions out of {len(wr_values) - 1} adjacent pairs)"
        lines.append(f"Shape: **{shape}**. Decile 1 winrate={wr_values[0]:.4f}, decile 10 winrate={wr_values[-1]:.4f}.")
        lines.append("")

    with open(REPORT_PATH, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    print(f"\n-> {REPORT_PATH}")


if __name__ == "__main__":
    main()
