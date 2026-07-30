"""
TICKET-110 — one-off, NOT part of any training pipeline. Scores production V1
(models/xgb_momentum_v1.onnx, referenced by apps/bot/src/xgbFilter/config.ts's
MOMENTUM_MODEL_PATH) against the SAME rows used to train/test V4
(data/training/momentum-v4-labeled.csv), using its own feature schema
(models/xgb_momentum_v1_feature_schema.json) to build the exact one-hot feature vector V1 expects,
and reports AUC vs label_win (the real trade outcome) — this makes the V1-vs-real-outcomes number and
V4's own test AUC apples-to-apples (same exact rows). Read-only: does not write/modify any production
file, does not retrain or touch xgb_momentum_v1.onnx.

Run: apps/ml-training/.venv/Scripts/python.exe apps/ml-training/ticket110EvalV1OnRealOutcomes.py
"""

import json
import os
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

import numpy as np
import onnxruntime as ort
import pandas as pd
from sklearn.metrics import roc_auc_score

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
MODELS_DIR = os.path.join(REPO_ROOT, "models")
CSV_PATH = os.path.join(REPO_ROOT, "data", "training", "momentum-v4-labeled.csv")
ONNX_PATH = os.path.join(MODELS_DIR, "xgb_momentum_v1.onnx")
SCHEMA_PATH = os.path.join(MODELS_DIR, "xgb_momentum_v1_feature_schema.json")

MISSING_CATEGORICAL_VALUE = "UNKNOWN"


def build_feature_matrix(df: pd.DataFrame, schema: dict) -> np.ndarray:
    numeric = schema["numeric_features"]
    categorical_order = schema["categorical_feature_order"]
    categories = schema["categorical_features"]
    feature_order = schema["feature_order"]

    df = df.copy()
    for col in categorical_order:
        df[col] = df[col].fillna(MISSING_CATEGORICAL_VALUE).replace("", MISSING_CATEGORICAL_VALUE)

    cols = {}
    for col in numeric:
        cols[col] = df[col].astype(np.float32).values
    for col in categorical_order:
        for cat in categories[col]:
            onehot_col = f"{col}__{cat}"
            cols[onehot_col] = (df[col] == cat).astype(np.float32).values

    matrix = np.column_stack([cols[c] for c in feature_order]).astype(np.float32)
    return matrix


def main() -> None:
    with open(SCHEMA_PATH, "r", encoding="utf-8") as f:
        schema = json.load(f)

    df = pd.read_csv(CSV_PATH)
    X = build_feature_matrix(df, schema)
    y = df["label_win"].values.astype(int)

    sess = ort.InferenceSession(ONNX_PATH, providers=["CPUExecutionProvider"])
    input_name = sess.get_inputs()[0].name
    outputs = sess.run(None, {input_name: X})

    # onnx_calibration_bridge's graph outputs [label, probabilities] (ArgMax label + Concat[p0,p1]) —
    # same convention train_xgb_momentum.py's own export produces. Find the (N,2) probability output.
    proba = None
    for out in outputs:
        arr = np.asarray(out)
        if arr.ndim == 2 and arr.shape[1] == 2:
            proba = arr
            break
    if proba is None:
        raise RuntimeError(f"Không tìm thấy output xác suất (N,2) trong ONNX outputs: shapes={[np.asarray(o).shape for o in outputs]}")

    p_win = proba[:, 1]
    auc = roc_auc_score(y, p_win)

    print(f"Số dòng đánh giá: {len(df)}")
    print(f"label_win rate: {y.mean():.3f}")
    print(f"V1 (xgb_momentum_v1.onnx) AUC vs label_win (real outcomes, cùng {len(df)} dòng dùng cho V4): {auc:.4f}")


if __name__ == "__main__":
    main()
