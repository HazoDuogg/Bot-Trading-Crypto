"""
TICKET-118 — trains all 11 models on the FIXED V6 dataset (data/training/momentum-v6-labeled.csv,
TICKET-117's side-conflict bug fixed by adding a `side` column — see
apps/bot/scripts/ticket118GenerateV6TrainingData.ts) and writes the full comparison report.

Cách B (PRIMARY, per PM's stated preference — matches V1 production's 2-separate-models architecture):
filter momentum-v6-labeled.csv to side='LONG' -> train a "bullish" model; side='SHORT' -> train a
"bearish" model. Same 12 original features (NOT including `side` itself — each model only sees one side
by construction) + same hyperparameters as V5b (train_xgb_momentum_v5b.py, TICKET-112). Trained on BOTH
the fixed 60/20/20 split (mirrors V5b) AND all 4 walk-forward windows (mirrors ticket116WalkForwardAndReport.py's
W1-W4 EXACT date boundaries — copied verbatim below, not recomputed). 2 sides x 5 splits = 10 models.

Cách A (secondary, "if time permits" per the ticket, bounded to the single fixed split only — no
walk-forward, explicitly noted as a limitation): ONE combined model on the FULL v6 dataset (both sides
mixed) with `side` added to CATEGORICAL_FEATURES (one-hot alongside atrTrend5m/adxDirection1h/
macroDirection/symbol). Same fixed 60/20/20 split, SAME hyperparameters as V5b. 1 model.

Uses ticket118Common.py's helpers (copied from ticket116Common.py's Việc-2 report convention) — no
hyperparameter or split-methodology change anywhere; the side-feature/population-splitting fix is the
ONLY isolated variable in this ticket.

ANALYSIS/EXPERIMENTAL ONLY (TICKET-118) — no ONNX export, does not touch any production file, does not
touch V5b/TICKET-116's own scripts or outputs. Writes only:
  - data/ticket118-plots/*.png
  - data/ticket118-v7-fixed-report.md

Run: apps/ml-training/.venv/Scripts/python.exe apps/ml-training/ticket118TrainAndReport.py
(requires data/training/momentum-v6-labeled.csv already generated — run
apps/bot/scripts/ticket118GenerateV6TrainingData.ts first.)
"""

import os
import statistics
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

from ticket118Common import (
    CATEGORICAL_FEATURES,
    CATEGORICAL_FEATURES_CACH_A,
    CSV_PATH,
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

REPORT_PATH = os.path.join(REPO_ROOT, "data", "ticket118-v7-fixed-report.md")

# Reused VERBATIM from ticket116WalkForwardAndReport.py (TICKET-116) — same window count (4), same
# date boundaries. Per the ticket: "reuse ticket116Common.py's window-splitting code, don't recompute
# boundaries from scratch."
WINDOWS = [
    dict(key="w1", train_start="2026-02-11", train_end="2026-03-27", val_end="2026-04-11", test_end="2026-04-26"),
    dict(key="w2", train_start="2026-03-13", train_end="2026-04-27", val_end="2026-05-12", test_end="2026-05-27"),
    dict(key="w3", train_start="2026-04-13", train_end="2026-05-28", val_end="2026-06-12", test_end="2026-06-27"),
    dict(key="w4", train_start="2026-05-14", train_end="2026-06-28", val_end="2026-07-13", test_end="2026-07-29"),
]

SIDES = [("LONG", "bullish"), ("SHORT", "bearish")]


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
    date_range = meta.get("date_range", "")
    date_line = f"- Date range: {date_range}\n" if date_range else ""
    return f"""### {title}

{date_line}- Rows: train={meta['n_train']:,} (win rate {meta['label_rate_train']:.4f}) · val={meta['n_val']:,} (win rate {meta['label_rate_val']:.4f}) · test={meta['n_test']:,} (win rate {meta['label_rate_test']:.4f})
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


def date_range_str(train_df, val_df, test_df) -> str:
    return (
        f"train {train_df['_ts'].min()} -> {train_df['_ts'].max()}, "
        f"val {val_df['_ts'].min()} -> {val_df['_ts'].max()}, "
        f"test {test_df['_ts'].min()} -> {test_df['_ts'].max()}"
    )


def train_one(key: str, train_df, val_df, test_df, feature_cols) -> dict:
    calib, model = train_calibrated_model(train_df, val_df, feature_cols, XGB_PARAMS)
    meta = full_report_for_model(key, calib, model, train_df, val_df, test_df, feature_cols)
    meta["date_range"] = date_range_str(train_df, val_df, test_df)
    return meta


def main() -> None:
    df_full = load_labeled_df(CSV_PATH)
    print(f"Loaded {len(df_full):,} rows, {df_full['_ts'].min()} -> {df_full['_ts'].max()}")
    print(f"side counts: {df_full['side'].value_counts().to_dict()}")

    cach_b_results = {"bullish": {}, "bearish": {}}

    # === Cách B: 2 separate side-filtered models x 5 splits (v7-original + W1-W4) = 10 models ===
    for side_value, side_label in SIDES:
        print(f"\n########## Cách B — {side_label} ({side_value}) ##########")
        df_side = df_full[df_full["side"] == side_value].sort_values("timestampUtc").reset_index(drop=True)
        print(f"{side_label}: {len(df_side):,} rows")
        df_side, feature_cols, categories = build_features(df_side, CATEGORICAL_FEATURES)

        print(f"\n=== {side_label} — v7-original (fixed 60/20/20 split) ===")
        train_df, val_df, test_df = fixed_602020_split(df_side, purge=HORIZON_CANDLES)
        meta = train_one(f"cachB-{side_label}-original", train_df, val_df, test_df, feature_cols)
        cach_b_results[side_label]["original"] = meta
        print(f"AUC train={meta['auc_train']:.4f} val={meta['auc_val']:.4f} test={meta['auc_test']:.4f}")

        for w in WINDOWS:
            key = w["key"]
            print(f"\n=== {side_label} — {key.upper()} ({w['train_start']} -> {w['test_end']}) ===")
            train_df, val_df, test_df = window_split(
                df_side, w["train_start"], w["train_end"], w["val_end"], w["test_end"], purge=HORIZON_CANDLES
            )
            print(f"  train={len(train_df)} val={len(val_df)} test={len(test_df)}")
            meta = train_one(f"cachB-{side_label}-{key}", train_df, val_df, test_df, feature_cols)
            meta["nominal_boundaries"] = w
            cach_b_results[side_label][key] = meta
            print(f"  AUC train={meta['auc_train']:.4f} val={meta['auc_val']:.4f} test={meta['auc_test']:.4f}")

    # === Cách A: ONE combined model, side as one-hot categorical, fixed split ONLY ===
    print("\n########## Cách A — combined model (side as one-hot feature) ##########")
    df_a, feature_cols_a, categories_a = build_features(df_full.copy(), CATEGORICAL_FEATURES_CACH_A)
    train_df, val_df, test_df = fixed_602020_split(df_a, purge=HORIZON_CANDLES)
    cacha_meta = train_one("cachA-combined-original", train_df, val_df, test_df, feature_cols_a)
    print(f"AUC train={cacha_meta['auc_train']:.4f} val={cacha_meta['auc_val']:.4f} test={cacha_meta['auc_test']:.4f}")

    # === Dispersion stats across the 4 window TEST AUCs, separately per side (factual only) ===
    dispersion = {}
    for side_label in ("bullish", "bearish"):
        aucs = [cach_b_results[side_label][w["key"]]["auc_test"] for w in WINDOWS]
        dispersion[side_label] = {
            "aucs": aucs,
            "min": min(aucs),
            "max": max(aucs),
            "mean": statistics.mean(aucs),
            "stdev": statistics.stdev(aucs) if len(aucs) > 1 else 0.0,
        }

    # === OLD numbers (V5b-original + W1-W4), hardcoded from data/ticket112-model-v5b-report.md and
    # data/ticket116-walk-forward-report.md (both already-committed reports — not retrained here, per
    # the ticket's ask to compare fixed-vs-buggy, not to regenerate the buggy baseline). ===
    old_v5b_original = dict(auc_train=0.6700, auc_val=0.5067, auc_test=0.5055)
    old_windows = {
        "w1": dict(auc_train=0.6980, auc_val=0.5466, auc_test=0.4926, n_train=86700, n_val=29688, n_test=30952),
        "w2": dict(auc_train=0.6317, auc_val=0.5136, auc_test=0.4532, n_train=90246, n_val=29244, n_test=30758),
        "w3": dict(auc_train=0.6989, auc_val=0.5521, auc_test=0.4970, n_train=89652, n_val=25060, n_test=26656),
        "w4": dict(auc_train=0.3701, auc_val=0.5070, auc_test=0.4161, n_train=81538, n_val=27942, n_test=30620),
    }

    # === Write report ===
    lines = []
    lines.append("# TICKET-118 — V6 (side-fixed) Model Report: Cách A / Cách B vs. buggy V5b baseline")
    lines.append("")
    lines.append(
        "ANALYSIS/EXPERIMENTAL ONLY — no production file changed. The ONLY isolated variable vs. V5b is "
        "the TICKET-117 side-conflict fix (data/training/momentum-v6-labeled.csv adds a `side` column so "
        "LONG/SHORT rows at the same (symbol,timestamp) are no longer indistinguishable duplicates with "
        "conflicting labels). No hyperparameter or split-methodology change. No conclusion drawn about "
        "proceeding to Giai đoạn 2 (PM's call, per ticket instruction) — numbers presented plainly."
    )
    lines.append("")
    lines.append(
        f"Data: `data/training/momentum-v6-labeled.csv`, {len(df_full):,} rows "
        f"(side counts: {df_full['side'].value_counts().to_dict()}), `timestampUtc` spans "
        f"{df_full['_ts'].min()} -> {df_full['_ts'].max()}."
    )
    lines.append("")

    # --- Headline comparison table ---
    lines.append("## Headline comparison — AUC train/val/test (fixed 60/20/20 split)")
    lines.append("")
    lines.append("| Model | Train rows | Val rows | Test rows | AUC train | AUC val | AUC test |")
    lines.append("|---|---|---|---|---|---|---|")
    lines.append(
        f"| V5b-original (OLD, buggy — momentum-v5-labeled.csv, side conflict present) | 193,577 | 64,519 | 64,530 | "
        f"{old_v5b_original['auc_train']:.4f} | {old_v5b_original['auc_val']:.4f} | {old_v5b_original['auc_test']:.4f} |"
    )
    m = cach_b_results["bullish"]["original"]
    lines.append(
        f"| Cách B — bullish (LONG), fixed split (NEW, side-fixed) | {m['n_train']:,} | {m['n_val']:,} | {m['n_test']:,} | "
        f"{m['auc_train']:.4f} | {m['auc_val']:.4f} | {m['auc_test']:.4f} |"
    )
    m = cach_b_results["bearish"]["original"]
    lines.append(
        f"| Cách B — bearish (SHORT), fixed split (NEW, side-fixed) | {m['n_train']:,} | {m['n_val']:,} | {m['n_test']:,} | "
        f"{m['auc_train']:.4f} | {m['auc_val']:.4f} | {m['auc_test']:.4f} |"
    )
    m = cacha_meta
    lines.append(
        f"| Cách A — combined (side as one-hot feature), fixed split (NEW, side-fixed) | {m['n_train']:,} | {m['n_val']:,} | {m['n_test']:,} | "
        f"{m['auc_train']:.4f} | {m['auc_val']:.4f} | {m['auc_test']:.4f} |"
    )
    lines.append("")
    lines.append(
        "Note: Cách A's combined model is trained on the FULL v6 population (both sides mixed, same row "
        "count as V5b-original: 322,646 rows before the 60/20/20 split), so its train/val/test row counts "
        "match V5b-original's. Cách B's bullish/bearish models are each trained on ~half the population "
        "(side-filtered first, then split)."
    )
    lines.append("")

    # --- Walk-forward table (Cách B only) ---
    lines.append("## Walk-forward table (Cách B only) — bullish vs bearish vs OLD W1-W4, AUC train/val/test")
    lines.append("")
    lines.append(
        "OLD numbers are V5b's (buggy, unsplit-by-side) W1-W4 from `data/ticket116-walk-forward-report.md`. "
        "NEW numbers are Cách B's side-filtered models on the same nominal window date boundaries. Row "
        "counts are roughly half the OLD windows' since each side-specific model only sees its own side's rows."
    )
    lines.append("")
    lines.append(
        "| Window | Date range (train -> val -> test) | OLD (buggy) rows train/val/test | OLD AUC train/val/test "
        "| Bullish rows train/val/test | Bullish AUC train/val/test | Bearish rows train/val/test | Bearish AUC train/val/test |"
    )
    lines.append("|---|---|---|---|---|---|---|---|")
    for w in WINDOWS:
        key = w["key"]
        ob = old_windows[key]
        mb = cach_b_results["bullish"][key]
        me = cach_b_results["bearish"][key]
        date_range = mb["date_range"]
        lines.append(
            f"| {key.upper()} | {date_range} | {ob['n_train']:,}/{ob['n_val']:,}/{ob['n_test']:,} | "
            f"{ob['auc_train']:.4f}/{ob['auc_val']:.4f}/{ob['auc_test']:.4f} | "
            f"{mb['n_train']:,}/{mb['n_val']:,}/{mb['n_test']:,} | "
            f"{mb['auc_train']:.4f}/{mb['auc_val']:.4f}/{mb['auc_test']:.4f} | "
            f"{me['n_train']:,}/{me['n_val']:,}/{me['n_test']:,} | "
            f"{me['auc_train']:.4f}/{me['auc_val']:.4f}/{me['auc_test']:.4f} |"
        )
    lines.append("")

    # --- Stability analysis ---
    lines.append("## Stability analysis — W1-W4 test AUC dispersion (factual only, no conclusion)")
    lines.append("")
    for side_label in ("bullish", "bearish"):
        d = dispersion[side_label]
        aucs_str = ", ".join(f"{w['key'].upper()}={a:.4f}" for w, a in zip(WINDOWS, d["aucs"]))
        lines.append(f"- **{side_label.capitalize()}**: test AUCs: {aucs_str}")
        lines.append(f"  - min={d['min']:.4f}, max={d['max']:.4f}, mean={d['mean']:.4f}, stdev={d['stdev']:.4f}")
    old_aucs = [old_windows[w["key"]]["auc_test"] for w in WINDOWS]
    old_disp = dict(
        min=min(old_aucs), max=max(old_aucs), mean=statistics.mean(old_aucs), stdev=statistics.stdev(old_aucs)
    )
    lines.append(
        f"- **OLD (buggy, for reference)**: test AUCs: "
        + ", ".join(f"{w['key'].upper()}={a:.4f}" for w, a in zip(WINDOWS, old_aucs))
    )
    lines.append(f"  - min={old_disp['min']:.4f}, max={old_disp['max']:.4f}, mean={old_disp['mean']:.4f}, stdev={old_disp['stdev']:.4f}")
    lines.append("")
    lines.append(
        "Factual statement only (no conclusion about proceeding to Giai đoạn 2, per ticket instruction): "
        "whether the fixed-split and walk-forward AUCs above clear 0.5 clearly and consistently, or remain "
        "weak/unstable, is presented via the numbers themselves for PM to judge."
    )
    lines.append("")

    # --- Full Việc-2-style per-model reports ---
    lines.append("## Full per-model reports (11 models)")
    lines.append("")
    lines.append("### Cách B — bullish (LONG-side) models")
    lines.append("")
    lines.append(fmt_model_section("Cách B bullish — v7-original (fixed 60/20/20 split)", cach_b_results["bullish"]["original"]))
    for w in WINDOWS:
        lines.append(fmt_model_section(f"Cách B bullish — {w['key'].upper()} (walk-forward window)", cach_b_results["bullish"][w["key"]]))

    lines.append("### Cách B — bearish (SHORT-side) models")
    lines.append("")
    lines.append(fmt_model_section("Cách B bearish — v7-original (fixed 60/20/20 split)", cach_b_results["bearish"]["original"]))
    for w in WINDOWS:
        lines.append(fmt_model_section(f"Cách B bearish — {w['key'].upper()} (walk-forward window)", cach_b_results["bearish"][w["key"]]))

    lines.append("### Cách A — combined model (side as one-hot categorical feature)")
    lines.append("")
    lines.append(
        "**Scope note / TODO_CONFIRM**: Cách A is bounded to the SINGLE fixed 60/20/20 split only, per "
        "the ticket's explicit scope limit (\"if time permits\"). It was NOT extended to the 4 walk-forward "
        "windows. If PM wants Cách A extended to walk-forward too, that's a future ticket."
    )
    lines.append("")
    lines.append(fmt_model_section("Cách A combined — v7-original (fixed 60/20/20 split, side one-hot)", cacha_meta))

    with open(REPORT_PATH, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    print(f"\n-> {REPORT_PATH}")
    print(f"-> plots in {PLOTS_DIR}")


if __name__ == "__main__":
    main()
