"""
TICKET-120 — repeats TICKET-119's Việc 3 decile-lift analysis for the 2 v7-original fixed-split
Cách B models (bullish/bearish), but bins deciles using the RAW booster score (predict_proba BEFORE
CalibratedClassifierCV/Platt scaling) instead of the calibrated score TICKET-119 used.

Reuses ticket118Common.py's EXACT feature list, hyperparameters, split/purge logic verbatim (same as
TICKET-119) — no redesign, no retune, no change to calibration itself. ANALYSIS ONLY.

Run: apps/ml-training/.venv/Scripts/python.exe apps/ml-training/ticket120DecileLiftRawScore.py
"""
import os
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import numpy as np
import pandas as pd
from xgboost import XGBClassifier

from ticket118Common import (
    CATEGORICAL_FEATURES,
    HORIZON_CANDLES,
    LABEL_COLUMN,
    REPO_ROOT,
    XGB_PARAMS,
    build_features,
    fixed_602020_split,
    load_labeled_df,
)

CSV_PATH = os.path.join(REPO_ROOT, "data", "training", "momentum-v6-labeled.csv")
REPORT_PATH = os.path.join(REPO_ROOT, "data", "ticket120-decile-lift-raw-score-report.md")

SIDES = [("LONG", "bullish"), ("SHORT", "bearish")]

# TICKET-119's ACTUAL calibrated-score decile winrates (copied verbatim from
# data/ticket119-calibration-regime-decile-report.md), for direct side-by-side comparison here.
CALIBRATED_WINRATES = {
    "bullish": [0.1961, 0.2138, 0.1882, 0.1750, 0.3056, 0.2617, 0.1853, 0.2754, 0.2416, 0.2872],
    "bearish": [0.1065, 0.1789, 0.1595, 0.2080, 0.2179, 0.2953, 0.2843, 0.3394, 0.2788, 0.1151],
}


def decile_table(p: np.ndarray, y: np.ndarray) -> list[tuple[int, int, float, float]]:
    df = pd.DataFrame({"p": p, "win": y})
    df["decile"] = pd.qcut(df["p"], 10, labels=False, duplicates="drop") + 1
    rows = []
    for d in sorted(df["decile"].unique()):
        sub = df[df["decile"] == d]
        rows.append((int(d), len(sub), float(sub["p"].mean()), float(sub["win"].mean())))
    return rows


def describe_shape(winrates: list[float]) -> str:
    is_monotonic = all(winrates[i] <= winrates[i + 1] for i in range(len(winrates) - 1))
    n_inversions = sum(1 for i in range(len(winrates) - 1) if winrates[i] > winrates[i + 1])
    if is_monotonic:
        return "monotonic non-decreasing"
    if n_inversions <= 2:
        return f"mostly-monotonic-with-noise ({n_inversions} local inversions out of {len(winrates) - 1} adjacent pairs)"
    return f"non-monotonic ({n_inversions} local inversions out of {len(winrates) - 1} adjacent pairs)"


def main() -> None:
    df_full = load_labeled_df(CSV_PATH)

    lines: list[str] = []
    lines.append("# TICKET-120 — Decile lift dùng RAW score (thay vì calibrated)")
    lines.append("")
    lines.append(
        "Lặp lại đúng TICKET-119 Việc 3 (2 model Cách B v7-original, bullish + bearish, tập test cố "
        "định), CHỈ đổi cách chia decile: dùng `model.predict_proba()` (RAW, TRƯỚC "
        "`CalibratedClassifierCV`) thay vì score đã calibrate. Không đổi feature/hyperparameter/split/"
        "công thức calibration — chỉ đổi input dùng để chia decile."
    )
    lines.append("")
    lines.append(
        "`pnlUsd` KHÔNG có sẵn trong `data/training/momentum-v6-labeled.csv` (TICKET-110's pipeline "
        "gốc đã loại bỏ) — dùng winrate (`label_win` mean) như TICKET-119, không tự bịa số PNL."
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

        # RAW score — no CalibratedClassifierCV wrapping at all, per this ticket's explicit ask.
        raw_p_test = model.predict_proba(X_test)[:, 1]

        rows = decile_table(raw_p_test, y_test)
        winrates = [wr for _, _, _, wr in rows]

        print(f"\n--- {side_label} v7-original decile table (RAW score) ---")
        lines.append(f"## {side_label.capitalize()} — v7-original, RAW score deciles")
        lines.append("")
        lines.append("| Decile (1=lowest raw p, 10=highest raw p) | n rows | mean raw p | winrate (RAW) | winrate (calibrated, TICKET-119) |")
        lines.append("|---|---|---|---|---|")
        calib_wr = CALIBRATED_WINRATES[side_label]
        for i, (d, n, mean_p, winrate) in enumerate(rows):
            calib_val = f"{calib_wr[i]:.4f}" if i < len(calib_wr) else "n/a"
            print(f"  decile {d}: n={n} mean_p={mean_p:.4f} winrate={winrate:.4f}")
            lines.append(f"| {d} | {n} | {mean_p:.4f} | {winrate:.4f} | {calib_val} |")
        lines.append("")

        shape = describe_shape(winrates)
        lines.append(
            f"Shape (RAW): **{shape}**. Decile 1 winrate={winrates[0]:.4f}, decile 10 winrate={winrates[-1]:.4f}."
        )
        lines.append("")

    with open(REPORT_PATH, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    print(f"\n-> {REPORT_PATH}")


if __name__ == "__main__":
    main()
