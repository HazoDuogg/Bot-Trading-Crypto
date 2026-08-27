#!/usr/bin/env python3
"""TICKET-RT-066 Part D: trains the production Soft Veto model — Option C from RT-064/065
(4 features: fvgGapSizePct, keyZoneDistancePct, atrH1Pct, slPct), on the FULL 3-year dataset,
no train/test split (this is the production model, not a walk-forward audit — it uses all
available history to score future trades). Saves the trained booster in XGBoost's native JSON
format, plus a metadata file with the FIXED top-20%/bottom-20% score thresholds computed from
this same training set's own score distribution (retroactive percentile at train time only —
NOT recomputed per future trade, per the ticket's explicit "nguong co dinh, khong phai
percentile hoi to" requirement).

Same hyperparameters as every xgbTrainFold.py call throughout RT-058..065
(n_estimators=100, max_depth=3, learning_rate=0.1, random_state=42) — no tuning introduced here.
"""
import json
import sys

import pandas as pd
from xgboost import XGBClassifier

FEATURE_COLUMNS = ["fvgGapSizePct", "keyZoneDistancePct", "atrH1Pct", "slPct"]


def load(path: str) -> pd.DataFrame:
    df = pd.read_csv(path)
    df["won"] = df["won"].astype(str).str.lower().map({"true": 1, "false": 0}).astype(int)
    return df


def main() -> None:
    dataset_path, model_out_path = sys.argv[1], sys.argv[2]
    df = load(dataset_path)

    X = df[FEATURE_COLUMNS]
    y = df["won"]

    model = XGBClassifier(
        n_estimators=100,
        max_depth=3,
        learning_rate=0.1,
        eval_metric="logloss",
        random_state=42,
    )
    model.fit(X, y)
    model.save_model(model_out_path)

    # In-sample scores on the SAME training set — used only to derive the fixed thresholds, per
    # the ticket ("tinh nguong diem so cat tai dung top-20%/bottom-20% cua phan phoi diem tren
    # chinh tap train do"). These are NOT re-derived at inference time.
    scores = model.predict_proba(X)[:, 1]
    sorted_scores = sorted(scores, reverse=True)
    n = len(sorted_scores)
    n_top = round(n * 0.2)
    n_bottom = round(n * 0.2)
    # Threshold = the score AT the boundary (last score still inside the top/bottom group), so
    # ">= topThreshold" / "<= bottomThreshold" at inference time reproduces the same ~20% split.
    top_threshold = float(sorted_scores[n_top - 1]) if n_top > 0 else float("inf")
    bottom_threshold = float(sorted(scores)[n_bottom - 1]) if n_bottom > 0 else float("-inf")

    out = {
        "trainN": int(n),
        "featureColumns": FEATURE_COLUMNS,
        "topThreshold": top_threshold,
        "bottomThreshold": bottom_threshold,
        "meanScore": float(scores.mean()),
        "minScore": float(scores.min()),
        "maxScore": float(scores.max()),
    }
    print(json.dumps(out))


if __name__ == "__main__":
    main()
