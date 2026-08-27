#!/usr/bin/env python3
"""TICKET-RT-066 Part D: Soft Veto live-inference script — loads the ALREADY-TRAINED model
(saved by trainSoftVetoModel.py, not retrained here) and scores ONE trade candidate's 4 Option-C
feature values. Invoked by src/positionSizing/softVeto.ts at (eventual, not-yet-wired) trade-fill
time. Loading a saved model is fast (no training, no full dataset read) — this is the lean path
meant for per-trade calls, unlike trainSoftVetoModel.py which is only run at (re)train time.

Usage: predictSoftVeto.py <model.json> <fvgGapSizePct> <keyZoneDistancePct> <atrH1Pct> <slPct>
"""
import json
import sys

import pandas as pd
from xgboost import XGBClassifier

FEATURE_COLUMNS = ["fvgGapSizePct", "keyZoneDistancePct", "atrH1Pct", "slPct"]


def main() -> None:
    model_path = sys.argv[1]
    values = [float(v) for v in sys.argv[2:6]]
    if len(values) != 4:
        raise ValueError(f"Expected 4 feature values ({FEATURE_COLUMNS}), got {len(values)}")

    model = XGBClassifier()
    model.load_model(model_path)

    row = pd.DataFrame([values], columns=FEATURE_COLUMNS)
    score = float(model.predict_proba(row)[0, 1])
    print(json.dumps({"predicted": score}))


if __name__ == "__main__":
    main()
