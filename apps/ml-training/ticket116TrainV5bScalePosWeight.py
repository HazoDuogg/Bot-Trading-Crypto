"""
TICKET-116 — Việc 3. Copies train_xgb_momentum_v5b.py (TICKET-112) EXACTLY — same data, same fixed
60/20/20 chronological split + HORIZON_CANDLES=10 purge, same 12 features, same calibration + ONNX
export/self-verify pattern — except ONE change: adds `scale_pos_weight=2.94` to XGB_PARAMS (hardcoded
exactly as specified by the ticket; NOT tuned, no other value tried).

2.94 comes from data/ticket115-xgboost-full-report.md: V5b's train split class balance is 25.38% win /
74.62% loss -> scale_pos_weight = 74.62/25.38 ≈ 2.94 (currently unused anywhere in production).

Produces the same Việc-2-style report (threshold table, PR curve, calibration curve, probability
histogram) as ticket116WalkForwardAndReport.py, on the SAME test split as V5b-original (directly
comparable), and APPENDS a "Việc 3" comparison section to data/ticket116-walk-forward-report.md.

Also exports an ONNX model to models/xgb_momentum_v5b_scale_pos_weight_experimental.onnx purely as a
by-product of following v5b's export pattern — NOT wired into anything, not referenced by any config.

EXPERIMENTAL/ANALYSIS ONLY (TICKET-116) — does not touch train_xgb_momentum_v5b.py or any production
file. Run AFTER ticket116WalkForwardAndReport.py (this script appends to its report file):
  apps/ml-training/.venv/Scripts/python.exe apps/ml-training/ticket116TrainV5bScalePosWeight.py
"""

import json
import os
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

from onnx_calibration_bridge import export_calibrated_onnx, validate_onnx_matches_sklearn
from ticket116Common import (
    HORIZON_CANDLES,
    REPO_ROOT,
    XGB_PARAMS,
    build_features,
    fixed_602020_split,
    full_report_for_model,
    load_labeled_df,
    train_calibrated_model,
)
from ticket116WalkForwardAndReport import fmt_thresholds_md, fmt_calibration_md

CSV_PATH = os.path.join(REPO_ROOT, "data", "training", "momentum-v5-labeled.csv")
REPORT_PATH = os.path.join(REPO_ROOT, "data", "ticket116-walk-forward-report.md")
MODELS_DIR = os.path.join(REPO_ROOT, "models")
MODEL_NAME = "xgb_momentum_v5b_scale_pos_weight_experimental"
ONNX_PATH = os.path.join(MODELS_DIR, f"{MODEL_NAME}.onnx")
SCHEMA_PATH = os.path.join(MODELS_DIR, f"{MODEL_NAME}_feature_schema.json")

SCALE_POS_WEIGHT = 2.94  # hardcoded exactly as specified by the ticket — do NOT tune.

SPW_PARAMS = dict(XGB_PARAMS)
SPW_PARAMS["scale_pos_weight"] = SCALE_POS_WEIGHT


def write_feature_schema(feature_cols: list[str], categories: dict) -> None:
    schema = {
        "numeric_features": [c for c in feature_cols if "__" not in c],
        "categorical_feature_order": ["atrTrend5m", "adxDirection1h", "macroDirection", "symbol"],
        "categorical_features": categories,
        "missing_categorical_value": "UNKNOWN",
        "feature_order": feature_cols,
        "monotone_constraints": None,
        "scale_pos_weight": SCALE_POS_WEIGHT,
    }
    with open(SCHEMA_PATH, "w", encoding="utf-8") as f:
        json.dump(schema, f, indent=2, ensure_ascii=False)
    print(f"-> {SCHEMA_PATH}")


def main() -> None:
    df = load_labeled_df(CSV_PATH)
    df, feature_cols, categories = build_features(df)

    train_df, val_df, test_df = fixed_602020_split(df, purge=HORIZON_CANDLES)

    print(f"scale_pos_weight = {SCALE_POS_WEIGHT}")
    print(f"Train: {len(train_df)} rows, win rate = {train_df['label_win'].mean():.4f}")
    print(f"Val:   {len(val_df)} rows, win rate = {val_df['label_win'].mean():.4f}")
    print(f"Test:  {len(test_df)} rows, win rate = {test_df['label_win'].mean():.4f}")

    calib, model = train_calibrated_model(train_df, val_df, feature_cols, SPW_PARAMS)
    print(f"best_iteration: {model.best_iteration}")

    meta = full_report_for_model("v5b-scale-pos-weight-2.94", calib, model, train_df, val_df, test_df, feature_cols)
    print(f"AUC train={meta['auc_train']:.4f} val={meta['auc_val']:.4f} test={meta['auc_test']:.4f}")
    frac_above_half = meta["hist_stats"]["frac_above_0.5"]
    print(f"Fraction of test predictions above 0.5: {frac_above_half:.4f}")

    # --- ONNX export (by-product of following v5b's exact pattern; NOT wired anywhere) ---
    os.makedirs(MODELS_DIR, exist_ok=True)
    write_feature_schema(feature_cols, categories)
    X_train = train_df[feature_cols].values.astype("float32")
    X_val = val_df[feature_cols].values.astype("float32")
    X_test = test_df[feature_cols].values.astype("float32")
    onnx_model = export_calibrated_onnx(calib, n_features=len(feature_cols))
    diff_train = validate_onnx_matches_sklearn(onnx_model, calib, X_train, "train")
    diff_val = validate_onnx_matches_sklearn(onnx_model, calib, X_val, "val")
    diff_test = validate_onnx_matches_sklearn(onnx_model, calib, X_test, "test")
    max_diff = max(diff_train, diff_val, diff_test)
    if max_diff > 1e-3:
        raise RuntimeError(f"ONNX output lệch sklearn predict_proba quá ngưỡng (max diff={max_diff:.2e} > 1e-3)")
    with open(ONNX_PATH, "wb") as f:
        f.write(onnx_model.SerializeToString())
    print(f"-> {ONNX_PATH}")

    # --- Reload V5b-original's threshold table (re-train identically, no scale_pos_weight) for
    #     a side-by-side comparison on the SAME test split ---
    print("\nRe-training V5b-original (no scale_pos_weight) for side-by-side comparison...")
    orig_calib, orig_model = train_calibrated_model(train_df, val_df, feature_cols, XGB_PARAMS)
    orig_meta = full_report_for_model("v5b-original-rerun-for-spw-comparison", orig_calib, orig_model, train_df, val_df, test_df, feature_cols)

    # --- Append Việc 3 section to the shared report ---
    lines = []
    lines.append("")
    lines.append("## Việc 3 — scale_pos_weight=2.94 experiment (single fixed split, NOT walk-forward)")
    lines.append("")
    lines.append(f"`apps/ml-training/ticket116TrainV5bScalePosWeight.py` — identical copy of V5b (same data, same fixed")
    lines.append(f"60/20/20 split, same purge, same features) with ONLY `scale_pos_weight={SCALE_POS_WEIGHT}` added to")
    lines.append("XGB_PARAMS. Compared against a fresh re-run of V5b-original on the exact same train/val/test split")
    lines.append("(re-trained here rather than reusing Việc 1's V5b-original run, to rule out any XGBoost internal")
    lines.append("nondeterminism between separate script invocations — both use the same split/seed-free params).")
    lines.append("")
    lines.append("| Metric | V5b-original (rerun) | V5b + scale_pos_weight=2.94 |")
    lines.append("|---|---|---|")
    lines.append(f"| best_iteration | {orig_model.best_iteration} | {model.best_iteration} |")
    lines.append(f"| AUC train | {orig_meta['auc_train']:.4f} | {meta['auc_train']:.4f} |")
    lines.append(f"| AUC val | {orig_meta['auc_val']:.4f} | {meta['auc_val']:.4f} |")
    lines.append(f"| AUC test | {orig_meta['auc_test']:.4f} | {meta['auc_test']:.4f} |")
    lines.append(f"| Average precision (test) | {orig_meta['average_precision']:.4f} | {meta['average_precision']:.4f} |")
    orig_t05 = next(r for r in orig_meta["thresholds"] if r["threshold"] == 0.5)
    spw_t05 = next(r for r in meta["thresholds"] if r["threshold"] == 0.5)
    lines.append(f"| # predicted positive @ 0.5 | {orig_t05['n_pred_pos']} | {spw_t05['n_pred_pos']} |")
    lines.append(f"| Precision @ 0.5 | {orig_t05['precision_str']} | {spw_t05['precision_str']} |")
    lines.append(f"| Recall @ 0.5 | {orig_t05['recall']:.4f} | {spw_t05['recall']:.4f} |")
    lines.append(f"| Fraction predictions > 0.5 (test) | {orig_meta['hist_stats']['frac_above_0.5']:.4f} | {meta['hist_stats']['frac_above_0.5']:.4f} |")
    lines.append(f"| Predicted-prob mean (test) | {orig_meta['hist_stats']['mean']:.4f} | {meta['hist_stats']['mean']:.4f} |")
    lines.append(f"| Predicted-prob median (test) | {orig_meta['hist_stats']['median']:.4f} | {meta['hist_stats']['median']:.4f} |")
    lines.append("")
    does_produce = "YES" if spw_t05["n_pred_pos"] > 0 else "NO"
    lines.append(f"**Does threshold 0.5 now produce any positive predictions?** {does_produce} — "
                  f"{spw_t05['n_pred_pos']} predicted positive (vs {orig_t05['n_pred_pos']} for V5b-original).")
    lines.append("")
    lines.append("### V5b + scale_pos_weight=2.94 — full Việc-2 report")
    lines.append("")
    lines.append(f"- Rows: train={meta['n_train']:,} (win rate {meta['label_rate_train']:.4f}) · val={meta['n_val']:,} (win rate {meta['label_rate_val']:.4f}) · test={meta['n_test']:,} (win rate {meta['label_rate_test']:.4f})")
    lines.append(f"- best_iteration: {meta['best_iteration']}")
    lines.append(f"- AUC: train={meta['auc_train']:.4f}, val={meta['auc_val']:.4f}, test={meta['auc_test']:.4f}")
    lines.append(f"- Average precision (test): {meta['average_precision']:.4f}")
    lines.append("")
    lines.append("**Precision/Recall by threshold (test split):**")
    lines.append("")
    lines.append(fmt_thresholds_md(meta["thresholds"]))
    lines.append("")
    lines.append(f"**PR curve:** ![]({meta['pr_curve_plot']})")
    lines.append("")
    lines.append("**Calibration curve** (10 bins, uniform strategy):")
    lines.append("")
    lines.append(fmt_calibration_md(meta["calibration_bins"]))
    lines.append("")
    lines.append(f"![]({meta['calibration_plot']})")
    lines.append("")
    h = meta["hist_stats"]
    lines.append(f"**Predicted-probability histogram (test):** min={h['min']:.4f}, max={h['max']:.4f}, mean={h['mean']:.4f}, median={h['median']:.4f}, std={h['std']:.4f}, fraction above 0.5 = {h['frac_above_0.5']:.4f} (n={h['n']:,})")
    lines.append("")
    lines.append(f"![]({meta['hist_plot']})")
    lines.append("")

    with open(REPORT_PATH, "a", encoding="utf-8") as f:
        f.write("\n".join(lines))
    print(f"\n-> appended Việc 3 section to {REPORT_PATH}")


if __name__ == "__main__":
    main()
