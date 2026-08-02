"""
TICKET-112 — Model V5b. IDENTICAL to train_xgb_momentum_v5.py (TICKET-111) in every way EXCEPT:
no `monotone_constraints` passed to XGBClassifier at all (fully unconstrained). Isolates whether the
2 new features (correlatedRiskRatio, distanceToNearestSwingAtr) themselves have any effect, separate
from the monotonic-constraint-on-correlatedRiskRatio effect V5 also introduced.

Same data (data/training/momentum-v5-labeled.csv), same 12 features, same chronological
60/20/20 split + HORIZON_CANDLES purge gap, same XGBoost hyperparameters (minus monotone_constraints),
same calibration + ONNX export/self-verify convention as V4/V5.

EXPERIMENTAL TRAINING ONLY (TICKET-112) — does not touch train_xgb.py, train_xgb_momentum.py,
train_xgb_momentum_v4.py, train_xgb_momentum_v5.py, or any production model/config referenced by
apps/bot/src/xgbFilter/config.ts. Output models/xgb_momentum_v5b_experimental.onnx +
_feature_schema.json are NOT wired into anything.

Run: apps/ml-training/.venv/Scripts/python.exe apps/ml-training/train_xgb_momentum_v5b.py
(reuses data/training/momentum-v5-labeled.csv already generated for TICKET-111 — no new TS script needed)
"""

import json
import os
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")  # Windows console default codepage can't print Vietnamese/→

import numpy as np
import pandas as pd
from sklearn.calibration import CalibratedClassifierCV
from sklearn.frozen import FrozenEstimator
from sklearn.metrics import accuracy_score, roc_auc_score
from xgboost import XGBClassifier

from onnx_calibration_bridge import export_calibrated_onnx, validate_onnx_matches_sklearn

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
MODELS_DIR = os.path.join(REPO_ROOT, "models")

CSV_PATH = os.path.join(REPO_ROOT, "data", "training", "momentum-v5-labeled.csv")
LABEL_COLUMN = "label_win"
MODEL_NAME = "xgb_momentum_v5b_experimental"
ONNX_PATH = os.path.join(MODELS_DIR, f"{MODEL_NAME}.onnx")
SCHEMA_PATH = os.path.join(MODELS_DIR, f"{MODEL_NAME}_feature_schema.json")

# Same 12 features as V5 — TICKET-112 only removes the monotonic constraint, not any feature.
NUMERIC_FEATURES = [
    "volAdjReturn5m",
    "emaRatioFast",
    "emaRatioSlow",
    "adx1h",
    "atrPercentile5m",
    "bbWidthPercentile15m",
    "volumeZScore5m",
    "correlatedRiskRatio",
    "distanceToNearestSwingAtr",
]
CATEGORICAL_FEATURES = ["atrTrend5m", "adxDirection1h", "macroDirection", "symbol"]
MISSING_CATEGORICAL_VALUE = "UNKNOWN"

# Must match V4/V5's HORIZON_CANDLES purge convention.
HORIZON_CANDLES = 10

OVERFIT_AUC_GAP_THRESHOLD = 0.15

# Identical to V5's XGB_PARAMS — no monotone_constraints key here at all (TICKET-112's one isolated variable).
XGB_PARAMS = dict(
    objective="binary:logistic",
    eval_metric="auc",
    learning_rate=0.03,
    max_depth=4,
    subsample=0.8,
    colsample_bytree=0.8,
    early_stopping_rounds=50,
)


def build_features(df: pd.DataFrame) -> tuple[pd.DataFrame, list[str], dict[str, list[str]]]:
    df = df.copy()
    for col in CATEGORICAL_FEATURES:
        df[col] = df[col].fillna(MISSING_CATEGORICAL_VALUE).replace("", MISSING_CATEGORICAL_VALUE)

    categories = {col: sorted(df[col].unique().tolist()) for col in CATEGORICAL_FEATURES}

    feature_cols = list(NUMERIC_FEATURES)
    for col in CATEGORICAL_FEATURES:
        for cat in categories[col]:
            onehot_col = f"{col}__{cat}"
            df[onehot_col] = (df[col] == cat).astype(np.float32)
            feature_cols.append(onehot_col)

    return df, feature_cols, categories


def write_feature_schema(feature_cols: list[str], categories: dict[str, list[str]]) -> None:
    schema = {
        "numeric_features": NUMERIC_FEATURES,
        "categorical_feature_order": CATEGORICAL_FEATURES,
        "categorical_features": categories,
        "missing_categorical_value": MISSING_CATEGORICAL_VALUE,
        "feature_order": feature_cols,
        "monotone_constraints": None,
    }
    with open(SCHEMA_PATH, "w", encoding="utf-8") as f:
        json.dump(schema, f, indent=2, ensure_ascii=False)
    print(f"→ {SCHEMA_PATH}")


def main() -> None:
    df = pd.read_csv(CSV_PATH)

    # Chronological sort, NO shuffling — same convention as V1/V4/V5's scripts.
    df = df.sort_values("timestampUtc").reset_index(drop=True)

    df, feature_cols, categories = build_features(df)
    print(f"Không có monotone_constraints (TICKET-112) — tất cả {len(feature_cols)} feature tự do.")

    os.makedirs(MODELS_DIR, exist_ok=True)
    write_feature_schema(feature_cols, categories)

    n = len(df)
    train_end = int(n * 0.6)
    val_end = int(n * 0.8)
    purge = HORIZON_CANDLES

    train_df = df.iloc[: train_end - purge]
    val_df = df.iloc[train_end : val_end - purge]
    test_df = df.iloc[val_end:]

    X_train = train_df[feature_cols].values.astype(np.float32)
    y_train = train_df[LABEL_COLUMN].values.astype(int)
    X_val = val_df[feature_cols].values.astype(np.float32)
    y_val = val_df[LABEL_COLUMN].values.astype(int)
    X_test = test_df[feature_cols].values.astype(np.float32)
    y_test = test_df[LABEL_COLUMN].values.astype(int)

    print(f"Nhãn: {LABEL_COLUMN}")
    print(f"Train: {len(train_df)} dòng, {LABEL_COLUMN} rate = {y_train.mean():.3f}")
    print(f"Val:   {len(val_df)} dòng, {LABEL_COLUMN} rate = {y_val.mean():.3f}")
    print(f"Test:  {len(test_df)} dòng, {LABEL_COLUMN} rate = {y_test.mean():.3f}")
    print(f"(purge gap = {purge} dòng bị bỏ ở mỗi ranh giới train/val và val/test)")

    model = XGBClassifier(**XGB_PARAMS)
    model.fit(X_train, y_train, eval_set=[(X_val, y_val)], verbose=True)
    print(f"best_iteration (early stopping): {model.best_iteration}")

    calib = CalibratedClassifierCV(FrozenEstimator(model), method="sigmoid")
    calib.fit(X_val, y_val)

    p_train = calib.predict_proba(X_train)[:, 1]
    p_val = calib.predict_proba(X_val)[:, 1]
    p_test = calib.predict_proba(X_test)[:, 1]
    auc_train = roc_auc_score(y_train, p_train)
    auc_val = roc_auc_score(y_val, p_val)
    auc_test = roc_auc_score(y_test, p_test)
    acc_train = accuracy_score(y_train, (p_train >= 0.5).astype(int))
    acc_val = accuracy_score(y_val, (p_val >= 0.5).astype(int))
    acc_test = accuracy_score(y_test, (p_test >= 0.5).astype(int))

    print("")
    print(f"AUC  train = {auc_train:.4f}   val = {auc_val:.4f}   test = {auc_test:.4f}")
    print(f"Acc  train = {acc_train:.4f}   val = {acc_val:.4f}   test = {acc_test:.4f}")
    gap = auc_train - auc_test
    if gap > OVERFIT_AUC_GAP_THRESHOLD:
        print(f"CẢNH BÁO: AUC(train) - AUC(test) = {gap:.4f} > {OVERFIT_AUC_GAP_THRESHOLD} — dấu hiệu overfit,")
        print("  diễn giải kết quả thận trọng. Không tự kết luận model tốt/xấu.")
    print("")
    print("Lưu ý diễn giải: AUC 0.55-0.62 trên tập test được coi là tín hiệu MẠNH trong trading —")
    print("KHÔNG kỳ vọng 0.80+, nếu thấy vậy nhiều khả năng là rò rỉ dữ liệu (data leakage).")

    print("")
    print("Export ONNX (model đã calibrate)...")
    onnx_model = export_calibrated_onnx(calib, n_features=len(feature_cols))

    print("Kiểm chứng ONNX khớp sklearn predict_proba trước khi ghi file...")
    diff_train = validate_onnx_matches_sklearn(onnx_model, calib, X_train, "train")
    diff_val = validate_onnx_matches_sklearn(onnx_model, calib, X_val, "val")
    diff_test = validate_onnx_matches_sklearn(onnx_model, calib, X_test, "test")
    max_diff = max(diff_train, diff_val, diff_test)
    if max_diff > 1e-3:
        raise RuntimeError(
            f"ONNX output lệch sklearn predict_proba quá ngưỡng (max diff={max_diff:.2e} > 1e-3) — "
            "KHÔNG ghi file .onnx, kiểm tra lại phần ghép graph calibration."
        )

    with open(ONNX_PATH, "wb") as f:
        f.write(onnx_model.SerializeToString())
    print(f"→ {ONNX_PATH}")
    print("")
    print("TICKET-112: đây là model thực nghiệm (12 feature, KHÔNG monotonic constraint) — KHÔNG wire vào production/xgbFilter/config.ts.")


if __name__ == "__main__":
    main()
