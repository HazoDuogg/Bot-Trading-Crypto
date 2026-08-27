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

TICKET-RT-059: optional 4th CLI arg (comma-separated feature column names) added so
xgbWalkForwardAuditV2.ts can reuse this same trainer for both the v1-subset comparison run
and the full v2 run, without duplicating the training code. Backward compatible: RT-058's
xgbWalkForwardAudit.ts calls this with exactly 2 args (train/test paths only) and is
untouched, so it keeps using the original 8-feature FEATURE_COLUMNS default below.

TICKET-RT-063: optional 5th CLI arg (integer random_state) added so
topTailRobustnessSeed.ts can vary ONLY the algorithm's randomness (Part B) while every other
caller keeps the original behavior. Backward compatible: every RT-058..062 call site passes
at most 4 args, so `random_state` keeps defaulting to 42 exactly as before — this default is
NOT changed for any existing call.

TICKET-RT-064: optional 6th CLI arg ("subsample,colsample_bytree", e.g. "0.8,0.8") added so
rt064QuintileCompare.ts/rt064RobustnessCompare.ts can test Option D (v2 + regularization)
without touching any other caller. Backward compatible: every RT-058..063 call site passes at
most 5 args, so both default to 1.0 (XGBoost's own default, i.e. off) exactly as before.
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
    feature_columns = sys.argv[3].split(",") if len(sys.argv) > 3 and sys.argv[3] else FEATURE_COLUMNS
    random_state = int(sys.argv[4]) if len(sys.argv) > 4 and sys.argv[4] else 42
    if len(sys.argv) > 5 and sys.argv[5]:
        subsample_str, colsample_str = sys.argv[5].split(",")
        subsample, colsample_bytree = float(subsample_str), float(colsample_str)
    else:
        subsample, colsample_bytree = 1.0, 1.0
    train_df = load(train_path)
    test_df = load(test_path)

    X_train = train_df[feature_columns]
    y_train = train_df["won"]
    X_test = test_df[feature_columns]
    y_test = test_df["won"]

    model = XGBClassifier(
        n_estimators=100,
        max_depth=3,
        learning_rate=0.1,
        eval_metric="logloss",
        random_state=random_state,
        subsample=subsample,
        colsample_bytree=colsample_bytree,
    )
    model.fit(X_train, y_train)

    proba = model.predict_proba(X_test)[:, 1]

    auc = None
    if y_test.nunique() > 1:
        auc = float(roc_auc_score(y_test, proba))

    importance_raw = model.get_booster().get_score(importance_type="gain")
    # get_score keys are the real column names when fit() was called with a DataFrame (which it was
    # above) — fall back to positional "f{i}" keys too in case that ever changes, 0 for unused features.
    feature_importance = {name: 0.0 for name in feature_columns}
    for i, name in enumerate(feature_columns):
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
