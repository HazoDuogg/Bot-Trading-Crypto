#!/usr/bin/env python3
"""TICKET-RT-058: single-fold XGBoost trainer, invoked as a subprocess by
xgbWalkForwardAudit.ts (one call per walk-forward fold). Reads a train CSV and a test CSV
(already split by the caller on entry month — no splitting logic lives here), trains one
binary XGBoost classifier on the train rows, and prints one JSON object to stdout containing
per-test-row predicted P(won), the fold's AUC-ROC, and gain-based feature importance.

Tool choice: no JS/TS XGBoost binding exists in this repo (checked package.json — only
onnxruntime-node, no xgboost/gbm library); `xgboost` 3.3.0 is installed for the system
Python (verified via `python -c "import xgboost"`) alongside pandas/scikit-learn, so this
script uses that Python xgboost via subprocess rather than reimplementing gradient boosting
in TS, per the ticket's "bao lai neu can quyet dinh cong cu" allowance.
"""
import json
import sys

import numpy as np
import pandas as pd
from sklearn.metrics import roc_auc_score
from xgboost import XGBClassifier

FEATURE_COLUMNS = [
    "distanceFromEma200H1Pct",
    "slPct",
    "fvgGapSizePct",
    "waitedCandlesCount",
    "breaksKeyZone",
    "atrH1Pct",
    "hourOfDayUtc",
    "dayOfWeekUtc",
]


def load(path: str) -> pd.DataFrame:
    df = pd.read_csv(path)
    df["breaksKeyZone"] = df["breaksKeyZone"].astype(str).str.lower().map({"true": 1, "false": 0}).astype(int)
    df["won"] = df["won"].astype(str).str.lower().map({"true": 1, "false": 0}).astype(int)
    return df


def main() -> None:
    train_path, test_path = sys.argv[1], sys.argv[2]
    train_df = load(train_path)
    test_df = load(test_path)

    X_train = train_df[FEATURE_COLUMNS]
    y_train = train_df["won"]
    X_test = test_df[FEATURE_COLUMNS]
    y_test = test_df["won"]

    model = XGBClassifier(
        n_estimators=100,
        max_depth=3,
        learning_rate=0.1,
        eval_metric="logloss",
        random_state=42,
    )
    model.fit(X_train, y_train)

    proba = model.predict_proba(X_test)[:, 1]

    auc = None
    if y_test.nunique() > 1:
        auc = float(roc_auc_score(y_test, proba))

    importance_raw = model.get_booster().get_score(importance_type="gain")
    # get_score keys are the real column names when fit() was called with a DataFrame (which it was
    # above) — fall back to positional "f{i}" keys too in case that ever changes, 0 for unused features.
    feature_importance = {name: 0.0 for name in FEATURE_COLUMNS}
    for i, name in enumerate(FEATURE_COLUMNS):
        if name in importance_raw:
            feature_importance[name] = float(importance_raw[name])
        elif f"f{i}" in importance_raw:
            feature_importance[name] = float(importance_raw[f"f{i}"])

    out = {
        "trainN": int(len(train_df)),
        "testN": int(len(test_df)),
        "auc": auc,
        "predictions": [
            {"symbol": s, "predicted": float(p), "won": bool(w)}
            for s, p, w in zip(test_df["symbol"], proba, test_df["won"].astype(bool))
        ],
        "featureImportance": feature_importance,
    }
    print(json.dumps(out))


if __name__ == "__main__":
    main()
