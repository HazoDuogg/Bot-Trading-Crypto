"""
TICKET-116 — Việc 1 (walk-forward validation, 4 windows) + Việc 2 (standard threshold/PR/calibration/
histogram report) for V5b-original (fixed 60/20/20 split) + W1..W4 (walk-forward windows).

Window boundaries REUSED EXACTLY from data/ticket115-xgboost-full-report.md's "Đề xuất walk-forward"
table (Nhóm G1) — same window count (4), same ~45d/15d/15d train/val/test sizing, same ~1/3-window
shift logic, only the ROW SELECTION is now precise (filtered from the real `timestampUtc` column)
instead of the report's linear-density approximation. W4's test end is extended 1 calendar day past the
report's nominal "2026-07-28" boundary so it reaches the true last row of the dataset (2026-07-28 23:40
UTC) rather than stopping at midnight.

Same 12 features, same XGB_PARAMS, same HORIZON_CANDLES=10 purge convention, same calibration
(CalibratedClassifierCV(FrozenEstimator(model), method='sigmoid') fit on val) as train_xgb_momentum_v5b.py
(TICKET-112) — NO hyperparameter changes in this ticket (Việc 1/2 explicitly forbids that).

ANALYSIS/EXPERIMENTAL ONLY (TICKET-116) — no ONNX export, does not touch any production file, does not
touch train_xgb_momentum_v5b.py itself. Writes only:
  - data/ticket116-plots/*.png
  - data/ticket116-walk-forward-report.md (this script writes the "Việc 1" + "Việc 2 (5 models)"
    sections; ticket116TrainV5bScalePosWeight.py APPENDS the Việc 3 section after this script runs).

Run (after this, then run ticket116TrainV5bScalePosWeight.py):
  apps/ml-training/.venv/Scripts/python.exe apps/ml-training/ticket116WalkForwardAndReport.py
"""

import os
import statistics
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

from ticket116Common import (
    HORIZON_CANDLES,
    PLOTS_DIR,
    REPO_ROOT,
    XGB_PARAMS,
    build_features,
    fixed_602020_split,
    full_report_for_model,
    load_labeled_df,
    train_calibrated_model,
    window_split,
)

CSV_PATH = os.path.join(REPO_ROOT, "data", "training", "momentum-v5-labeled.csv")
REPORT_PATH = os.path.join(REPO_ROOT, "data", "ticket116-walk-forward-report.md")

# Reused verbatim from data/ticket115-xgboost-full-report.md, Nhóm G1 "Đề xuất walk-forward" table.
WINDOWS = [
    dict(key="w1", train_start="2026-02-11", train_end="2026-03-27", val_end="2026-04-11", test_end="2026-04-26"),
    dict(key="w2", train_start="2026-03-13", train_end="2026-04-27", val_end="2026-05-12", test_end="2026-05-27"),
    dict(key="w3", train_start="2026-04-13", train_end="2026-05-28", val_end="2026-06-12", test_end="2026-06-27"),
    # test_end extended 1 day past the report's nominal 2026-07-28 boundary to reach the true last row
    # of the dataset (max timestampUtc = 2026-07-28 23:40 UTC), per this script's docstring.
    dict(key="w4", train_start="2026-05-14", train_end="2026-06-28", val_end="2026-07-13", test_end="2026-07-29"),
]


def fmt_thresholds_md(rows: list[dict]) -> str:
    lines = ["| Threshold | # predicted positive | Precision | Recall |", "|---|---|---|---|"]
    for r in rows:
        lines.append(f"| {r['threshold']:.2f} | {r['n_pred_pos']} | {r['precision_str']} | {r['recall']:.4f} |")
    return "\n".join(lines)


def fmt_calibration_md(bins: list[dict]) -> str:
    lines = ["| Bin mean predicted prob | Observed win rate |", "|---|---|"]
    for b in bins:
        lines.append(f"| {b['mean_predicted']:.4f} | {b['observed_win_rate']:.4f} |")
    return "\n".join(lines)


def fmt_model_section(title: str, meta: dict) -> str:
    h = meta["hist_stats"]
    return f"""### {title}

- Rows: train={meta['n_train']:,} (win rate {meta['label_rate_train']:.4f}) · val={meta['n_val']:,} (win rate {meta['label_rate_val']:.4f}) · test={meta['n_test']:,} (win rate {meta['label_rate_test']:.4f})
- best_iteration (early stopping): {meta['best_iteration']}
- AUC: train={meta['auc_train']:.4f}, val={meta['auc_val']:.4f}, test={meta['auc_test']:.4f}
- Average precision (test): {meta['average_precision']:.4f}

**Precision/Recall by threshold (test split):**

{fmt_thresholds_md(meta['thresholds'])}

**PR curve:** ![]({meta['pr_curve_plot']})

**Calibration curve** (10 bins, uniform strategy):

{fmt_calibration_md(meta['calibration_bins'])}

![]({meta['calibration_plot']})

**Predicted-probability histogram (test):** min={h['min']:.4f}, max={h['max']:.4f}, mean={h['mean']:.4f}, median={h['median']:.4f}, std={h['std']:.4f}, fraction above 0.5 = {h['frac_above_0.5']:.4f} (n={h['n']:,})

![]({meta['hist_plot']})
"""


def main() -> None:
    df = load_labeled_df(CSV_PATH)
    print(f"Loaded {len(df):,} rows, {df['_ts'].min()} -> {df['_ts'].max()}")

    df, feature_cols, categories = build_features(df)
    print(f"{len(feature_cols)} feature columns (build_features identical to V5b).")

    results = {}

    # --- V5b-original: exact same fixed 60/20/20 split as train_xgb_momentum_v5b.py ---
    print("\n=== V5b-original (fixed 60/20/20 split) ===")
    train_df, val_df, test_df = fixed_602020_split(df, purge=HORIZON_CANDLES)
    calib, model = train_calibrated_model(train_df, val_df, feature_cols, XGB_PARAMS)
    meta = full_report_for_model("v5b-original", calib, model, train_df, val_df, test_df, feature_cols)
    meta["date_range"] = (
        f"train {train_df['_ts'].min()} -> {train_df['_ts'].max()}, "
        f"val {val_df['_ts'].min()} -> {val_df['_ts'].max()}, "
        f"test {test_df['_ts'].min()} -> {test_df['_ts'].max()}"
    )
    results["v5b-original"] = meta
    print(f"AUC train={meta['auc_train']:.4f} val={meta['auc_val']:.4f} test={meta['auc_test']:.4f}")

    # --- W1..W4: walk-forward windows ---
    for w in WINDOWS:
        key = w["key"]
        print(f"\n=== {key.upper()} ({w['train_start']} -> {w['test_end']}) ===")
        train_df, val_df, test_df = window_split(
            df, w["train_start"], w["train_end"], w["val_end"], w["test_end"], purge=HORIZON_CANDLES
        )
        print(f"  train={len(train_df)} val={len(val_df)} test={len(test_df)}")
        calib, model = train_calibrated_model(train_df, val_df, feature_cols, XGB_PARAMS)
        meta = full_report_for_model(key, calib, model, train_df, val_df, test_df, feature_cols)
        meta["date_range"] = (
            f"train {train_df['_ts'].min()} -> {train_df['_ts'].max()}, "
            f"val {val_df['_ts'].min()} -> {val_df['_ts'].max()}, "
            f"test {test_df['_ts'].min()} -> {test_df['_ts'].max()}"
        )
        meta["nominal_boundaries"] = w
        results[key] = meta
        print(f"  AUC train={meta['auc_train']:.4f} val={meta['auc_val']:.4f} test={meta['auc_test']:.4f}")

    # --- Dispersion stats across the 4 window TEST AUCs (factual only, no conclusion) ---
    window_test_aucs = [results[w["key"]]["auc_test"] for w in WINDOWS]
    dispersion = {
        "min": min(window_test_aucs),
        "max": max(window_test_aucs),
        "mean": statistics.mean(window_test_aucs),
        "stdev": statistics.stdev(window_test_aucs) if len(window_test_aucs) > 1 else 0.0,
    }

    # --- Write report (Việc 1 + Việc 2, 5 models) ---
    lines = []
    lines.append("# TICKET-116 — Walk-Forward Validation + Threshold/PR/Calibration Report")
    lines.append("")
    lines.append("ANALYSIS/EXPERIMENTAL ONLY — no production file changed, no new features/labels, no conclusion")
    lines.append("about proceeding to Giai đoạn 2 (PM's call, per ticket instruction).")
    lines.append("")
    lines.append("Data: `data/training/momentum-v5-labeled.csv`, 322,646 rows, `timestampUtc` spans")
    lines.append(f"{df['_ts'].min()} -> {df['_ts'].max()} (confirmed directly from the file).")
    lines.append("")
    lines.append("## Việc 1 — AUC summary + window date ranges")
    lines.append("")
    lines.append("| Model | Train dates | Val dates | Test dates | Train rows | Val rows | Test rows | best_iteration | AUC train | AUC val | AUC test |")
    lines.append("|---|---|---|---|---|---|---|---|---|---|---|")
    order = ["v5b-original"] + [w["key"] for w in WINDOWS]
    for key in order:
        m = results[key]
        # date_range string -> split back out for table columns
        dr = m["date_range"]
        train_part, val_part, test_part = dr.split(", val ")[0].replace("train ", ""), dr.split(", val ")[1].split(", test ")[0], dr.split(", test ")[1]
        lines.append(
            f"| {key} | {train_part} | {val_part} | {test_part} | {m['n_train']:,} | {m['n_val']:,} | {m['n_test']:,} | "
            f"{m['best_iteration']} | {m['auc_train']:.4f} | {m['auc_val']:.4f} | {m['auc_test']:.4f} |"
        )
    lines.append("")
    lines.append("### Walk-forward stability (W1-W4 test AUC dispersion, factual only)")
    lines.append("")
    lines.append(f"- Test AUCs: W1={results['w1']['auc_test']:.4f}, W2={results['w2']['auc_test']:.4f}, W3={results['w3']['auc_test']:.4f}, W4={results['w4']['auc_test']:.4f}")
    lines.append(f"- min={dispersion['min']:.4f}, max={dispersion['max']:.4f}, mean={dispersion['mean']:.4f}, stdev={dispersion['stdev']:.4f}")
    lines.append("- (No conclusion drawn about model adequacy or next phase — presented as raw dispersion numbers only, per ticket instruction.)")
    lines.append("")
    lines.append("## Việc 2 — Full per-model report (5 models)")
    lines.append("")
    titles = {
        "v5b-original": "V5b-original (fixed 60/20/20 split)",
        "w1": "W1 (walk-forward window 1)",
        "w2": "W2 (walk-forward window 2)",
        "w3": "W3 (walk-forward window 3)",
        "w4": "W4 (walk-forward window 4)",
    }
    for key in order:
        lines.append(fmt_model_section(titles[key], results[key]))

    with open(REPORT_PATH, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    print(f"\n-> {REPORT_PATH}")
    print(f"-> plots in {PLOTS_DIR}")


if __name__ == "__main__":
    main()
