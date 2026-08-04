"""
TICKET-121 Phần B (only run because Phần A was diffuse, no single dominant cause) — Việc 3
(feature distribution / KS test, OOD check) + Việc 6 (leaf/tree structure clustering) for
Decile 10 vs Decile 8 vs full TRAIN, on the bearish v7-original model.

Reproduces the exact same model as ticket121Decile10Forensic.py (verbatim ticket118Common.py
reuse). ANALYSIS ONLY.

Run: apps/ml-training/.venv/Scripts/python.exe apps/ml-training/ticket121PhanBOodLeaf.py
"""
import os
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import numpy as np
import pandas as pd
from scipy.stats import ks_2samp
from xgboost import XGBClassifier

from ticket118Common import (
    CATEGORICAL_FEATURES,
    HORIZON_CANDLES,
    LABEL_COLUMN,
    NUMERIC_FEATURES,
    REPO_ROOT,
    XGB_PARAMS,
    build_features,
    fixed_602020_split,
    load_labeled_df,
)

CSV_PATH = os.path.join(REPO_ROOT, "data", "training", "momentum-v6-labeled.csv")
OUT_DIR = os.path.join(REPO_ROOT, "data", "ticket121-artifacts")


def main() -> None:
    df_full = load_labeled_df(CSV_PATH)
    df_side = df_full[df_full["side"] == "SHORT"].sort_values("timestampUtc").reset_index(drop=True)

    df_side_feat, feature_cols, _ = build_features(df_side, CATEGORICAL_FEATURES)
    train_df, val_df, test_df = fixed_602020_split(df_side_feat, purge=HORIZON_CANDLES)

    X_train = train_df[feature_cols].values.astype(np.float32)
    y_train = train_df[LABEL_COLUMN].values.astype(int)
    X_val = val_df[feature_cols].values.astype(np.float32)
    y_val = val_df[LABEL_COLUMN].values.astype(int)
    X_test = test_df[feature_cols].values.astype(np.float32)

    model = XGBClassifier(**XGB_PARAMS)
    model.fit(X_train, y_train, eval_set=[(X_val, y_val)], verbose=False)

    raw_p_test = model.predict_proba(X_test)[:, 1]
    decile = pd.qcut(pd.Series(raw_p_test), 10, labels=False, duplicates="drop") + 1

    test_df = test_df.reset_index(drop=True)
    test_df["decile"] = decile

    d10_idx = test_df.index[test_df["decile"] == 10]
    d8_idx = test_df.index[test_df["decile"] == 8]

    # --- Việc 3: KS test on the 9 numeric features, Decile10 vs Decile8 vs full TRAIN ---
    print("\n=== Việc 3 — Feature distribution: Decile10 vs Decile8 vs TRAIN (KS test) ===")
    rows = []
    for feat in NUMERIC_FEATURES:
        train_vals = train_df[feat].values
        d10_vals = test_df.loc[d10_idx, feat].values
        d8_vals = test_df.loc[d8_idx, feat].values

        ks10, p10 = ks_2samp(d10_vals, train_vals)
        ks8, p8 = ks_2samp(d8_vals, train_vals)
        ks_10v8, p_10v8 = ks_2samp(d10_vals, d8_vals)

        row = {
            "feature": feat,
            "train_mean": float(np.mean(train_vals)), "train_median": float(np.median(train_vals)),
            "d10_mean": float(np.mean(d10_vals)), "d10_median": float(np.median(d10_vals)),
            "d8_mean": float(np.mean(d8_vals)), "d8_median": float(np.median(d8_vals)),
            "KS_d10_vs_train": float(ks10), "p_d10_vs_train": float(p10),
            "KS_d8_vs_train": float(ks8), "p_d8_vs_train": float(p8),
            "KS_d10_vs_d8": float(ks_10v8), "p_d10_vs_d8": float(p_10v8),
        }
        rows.append(row)
        print(f"{feat:30s} KS(d10,train)={ks10:.4f} KS(d8,train)={ks8:.4f} KS(d10,d8)={ks_10v8:.4f}")

    ks_df = pd.DataFrame(rows)
    ks_df.to_csv(os.path.join(OUT_DIR, "ks_test_features.csv"), index=False)

    # --- Việc 6: leaf clustering ---
    print("\n=== Việc 6 — Leaf/tree structure: Decile10 vs Decile8 ===")
    X_test_arr = test_df[feature_cols].values.astype(np.float32)
    leaves = model.apply(X_test_arr)  # shape (n_rows, n_trees)
    n_trees = leaves.shape[1]

    d10_leaves = leaves[d10_idx.values]
    d8_leaves = leaves[d8_idx.values]

    # For a sample of early/late trees, how concentrated are decile10 rows into few leaves vs decile8?
    def top_leaf_concentration(leaf_mat, k=5):
        # fraction of rows falling into the single most common leaf, per tree, averaged
        fracs = []
        for t in range(leaf_mat.shape[1]):
            vc = pd.Series(leaf_mat[:, t]).value_counts(normalize=True)
            fracs.append(vc.iloc[0])
        return float(np.mean(fracs)), float(np.median(fracs))

    d10_top1_mean, d10_top1_median = top_leaf_concentration(d10_leaves)
    d8_top1_mean, d8_top1_median = top_leaf_concentration(d8_leaves)
    print(f"n_trees={n_trees}")
    print(f"Decile10: mean frac of rows in single most-common leaf per tree = {d10_top1_mean:.4f} (median {d10_top1_median:.4f})")
    print(f"Decile8:  mean frac of rows in single most-common leaf per tree = {d8_top1_mean:.4f} (median {d8_top1_median:.4f})")

    # unique leaf-path (across all trees) count - how many distinct full leaf-index tuples
    d10_unique_paths = len(set(map(tuple, d10_leaves)))
    d8_unique_paths = len(set(map(tuple, d8_leaves)))
    print(f"Decile10: {len(d10_leaves)} rows -> {d10_unique_paths} unique full leaf-paths")
    print(f"Decile8:  {len(d8_leaves)} rows -> {d8_unique_paths} unique full leaf-paths")

    leaf_summary = pd.DataFrame([
        {"group": "Decile10", "n_rows": len(d10_leaves), "n_unique_leaf_paths": d10_unique_paths,
         "top1_leaf_frac_mean": d10_top1_mean, "top1_leaf_frac_median": d10_top1_median},
        {"group": "Decile8", "n_rows": len(d8_leaves), "n_unique_leaf_paths": d8_unique_paths,
         "top1_leaf_frac_mean": d8_top1_mean, "top1_leaf_frac_median": d8_top1_median},
    ])
    leaf_summary.to_csv(os.path.join(OUT_DIR, "leaf_summary.csv"), index=False)

    print(f"\nSaved -> {OUT_DIR}")


if __name__ == "__main__":
    main()
