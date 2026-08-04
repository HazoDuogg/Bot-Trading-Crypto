"""
TICKET-121 — Forensic investigation of Bearish Cách B v7-original Decile 10 winrate inversion
(11.51% vs Decile 8's 33.94%), per data/ticket119-calibration-regime-decile-report.md and
data/ticket120-decile-lift-raw-score-report.md.

Reproduces the bearish v7-original model EXACTLY as ticket120DecileLiftRawScore.py does (same
fixed 60/20/20 split, same features, same XGB_PARAMS, side='SHORT' filter). Reuses
ticket118Common.py verbatim. ANALYSIS ONLY.

Run: apps/ml-training/.venv/Scripts/python.exe apps/ml-training/ticket121Decile10Forensic.py
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
OUT_DIR = os.path.join(REPO_ROOT, "data", "ticket121-artifacts")
os.makedirs(OUT_DIR, exist_ok=True)

ORIG_NUMERIC = [
    "adx1h", "atrPercentile5m", "bbWidthPercentile15m", "volumeZScore5m", "atrTrend5m",
    "adxDirection1h", "macroDirection", "volAdjReturn5m", "emaRatioFast", "emaRatioSlow",
    "correlatedRiskRatio", "distanceToNearestSwingAtr",
]


def main() -> None:
    df_full = load_labeled_df(CSV_PATH)
    df_side = df_full[df_full["side"] == "SHORT"].sort_values("timestampUtc").reset_index(drop=True)

    # Keep a copy of the original (pre-onehot) columns aligned by index before build_features mutates/adds cols
    orig_cols_keep = ["symbol", "timestampUtc"] + ORIG_NUMERIC + [LABEL_COLUMN]
    df_side_orig = df_side[orig_cols_keep].copy()

    df_side_feat, feature_cols, _ = build_features(df_side, CATEGORICAL_FEATURES)
    train_df, val_df, test_df = fixed_602020_split(df_side_feat, purge=HORIZON_CANDLES)

    X_train = train_df[feature_cols].values.astype(np.float32)
    y_train = train_df[LABEL_COLUMN].values.astype(int)
    X_val = val_df[feature_cols].values.astype(np.float32)
    y_val = val_df[LABEL_COLUMN].values.astype(int)
    X_test = test_df[feature_cols].values.astype(np.float32)
    y_test = test_df[LABEL_COLUMN].values.astype(int)

    model = XGBClassifier(**XGB_PARAMS)
    model.fit(X_train, y_train, eval_set=[(X_val, y_val)], verbose=False)

    raw_p_test = model.predict_proba(X_test)[:, 1]

    # Build the analysis dataframe: test_df's original (pre-onehot) columns + score + decile
    test_orig = df_side_orig.loc[test_df.index].copy()
    assert len(test_orig) == len(test_df)
    test_orig["score"] = raw_p_test
    test_orig["decile"] = pd.qcut(test_orig["score"], 10, labels=False, duplicates="drop") + 1

    print("Decile sizes:")
    print(test_orig.groupby("decile").size())
    print("\nDecile winrates:")
    print(test_orig.groupby("decile")[LABEL_COLUMN].mean())

    d10 = test_orig[test_orig["decile"] == 10].copy()
    d8 = test_orig[test_orig["decile"] == 8].copy()
    full_test = test_orig.copy()

    print(f"\nDecile 10: n={len(d10)}, winrate={d10[LABEL_COLUMN].mean():.4f}")
    print(f"Decile 8: n={len(d8)}, winrate={d8[LABEL_COLUMN].mean():.4f}")
    print(f"Full test: n={len(full_test)}, winrate={full_test[LABEL_COLUMN].mean():.4f}")

    # Persist for downstream analysis (episode/subgroup scripts)
    test_orig.to_csv(os.path.join(OUT_DIR, "test_scored.csv"), index=False)
    d10.to_csv(os.path.join(OUT_DIR, "decile10.csv"), index=False)
    d8.to_csv(os.path.join(OUT_DIR, "decile8.csv"), index=False)
    full_test.to_csv(os.path.join(OUT_DIR, "full_test.csv"), index=False)

    print(f"\nSaved -> {OUT_DIR}")
    print(f"Test date range: {pd.to_datetime(full_test['timestampUtc'], unit='ms', utc=True).min()} "
          f"to {pd.to_datetime(full_test['timestampUtc'], unit='ms', utc=True).max()}")


if __name__ == "__main__":
    main()
