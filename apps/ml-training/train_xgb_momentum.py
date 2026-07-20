"""
TICKET-023 Phần C — trains a SEPARATE, experimental "momentum confidence" model using
Fixed-Time-Horizon labels (every 5m candle, not just Draft Setup candles) to address the
159-205-row sample-size problem hit by models/xgb_confidence_v1*.onnx (TICKET-021/022).

HARD BOUNDARY (see ticket): does NOT touch train_xgb.py, regime/entryRouter/risk/orchestrator, or
models/xgb_confidence_v1*. All outputs use new names. Not wired into the Orchestrator/bot here —
train + report only.

Run from repo root: apps/ml-training/.venv/Scripts/python.exe apps/ml-training/train_xgb_momentum.py
(after `pip install -r apps/ml-training/requirements.txt` in that venv, and
`npm run generate-momentum-training-data` to produce data/training/momentum-labeled.csv).

TICKET-025 Phần B: --label-column=<col> --model-name=<name> trains against a different label column
in the SAME momentum-labeled.csv (features are shared/unchanged) and writes models/<name>.onnx +
models/<name>_feature_schema.json — e.g. --label-column=label_bearish_momentum
--model-name=xgb_momentum_bearish_v1 for the SHORT-side model. Defaults reproduce the TICKET-023
bullish run exactly (label_bullish_momentum / xgb_momentum_v1). Logic below is otherwise untouched.

=== C.2/C.3 note: how early stopping and calibration combine ===
C.2 requires fitting XGBClassifier directly with eval_set + early_stopping_rounds against a held-out
VALIDATION set (not test). C.3 requires the SAME calibrated-ONNX-export mechanism already verified in
train_xgb.py (CalibratedClassifierCV(method='sigmoid'), graph-spliced ONNX, self-verified before
write). Normally CalibratedClassifierCV clones and RE-fits its base estimator per fold — which would
silently discard the early-stopped iteration count and the eval_set. To keep the early-stopped fit
intact, the fitted model is wrapped in sklearn.frozen.FrozenEstimator before calibration:
FrozenEstimator tells CalibratedClassifierCV "this is already fit, don't refit it — only fit
calibrator(s) on top of its existing predict_proba()". This is a built-in sklearn mechanism (not a
custom workaround), and sklearn's own `ensemble="auto"` default already resolves to
`ensemble=False`-equivalent behavior for a FrozenEstimator base (verified: exactly one
(estimator, calibrator) pair in calibrated_classifiers_, same shape onnx_calibration_bridge.py
expects). Calibration itself is fit on the VALIDATION split (the only split besides train available
that isn't the held-out test set) — train_xgb.py's train-set-internal-CV calibration approach isn't
usable here since it requires an UNfrozen (re-fittable) estimator.
"""

import argparse
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

# TICKET-025 Phần B — defaults reproduce the TICKET-023 bullish run exactly when no args are passed.
_parser = argparse.ArgumentParser()
_parser.add_argument("--label-column", default="label_bullish_momentum")
_parser.add_argument("--model-name", default="xgb_momentum_v1")
_args = _parser.parse_args()

CSV_PATH = os.path.join(REPO_ROOT, "data", "training", "momentum-labeled.csv")
LABEL_COLUMN = _args.label_column
ONNX_PATH = os.path.join(MODELS_DIR, f"{_args.model_name}.onnx")
SCHEMA_PATH = os.path.join(MODELS_DIR, f"{_args.model_name}_feature_schema.json")

# B.2/B.4 columns — order here IS the order fed into the model.
NUMERIC_FEATURES = ["volAdjReturn5m", "emaRatioFast", "emaRatioSlow", "adx1h", "atrPercentile5m", "bbWidthPercentile15m", "volumeZScore5m"]
# `symbol` included as a categorical feature (same precedent as train_xgb.py's confidence model) so
# the model can learn symbol-specific momentum patterns; not explicitly required or forbidden by the
# ticket text, which lists symbol as an identifier column alongside timestampUtc.
CATEGORICAL_FEATURES = ["atrTrend5m", "adxDirection1h", "macroDirection", "symbol"]
MISSING_CATEGORICAL_VALUE = "UNKNOWN"

# TICKET-023 Phần B — must match generateMomentumTrainingData.ts's HORIZON_CANDLES exactly (the purge
# gap below is sized to it).
HORIZON_CANDLES = 10

OVERFIT_AUC_GAP_THRESHOLD = 0.15

# C.2 — Trader's suggested starting point. n_estimators intentionally left at the XGBoost default
# (not specified by the ticket) since early_stopping_rounds picks the actual number of trees used.
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
    }
    with open(SCHEMA_PATH, "w", encoding="utf-8") as f:
        json.dump(schema, f, indent=2, ensure_ascii=False)
    print(f"→ {SCHEMA_PATH}")


def main() -> None:
    # B.1 (of Phần B's own output, read here)
    df = pd.read_csv(CSV_PATH)

    # C.1 — sort by timestampUtc ascending, 60/20/20 train/val/test, NO shuffling.
    # NOTE: momentum-labeled.csv interleaves 4 symbols sharing largely the same timestamp grid, so a
    # purge of HORIZON_CANDLES ROWS (as literally specified) purges roughly HORIZON_CANDLES/4 real
    # time-steps per symbol here, not a full HORIZON_CANDLES-candle gap per symbol. Implemented
    # exactly as specified (row-count purge, not per-symbol time purge) — flagged here and in the
    # final report as a known limitation of the literal row-count approach, not silently ignored.
    df = df.sort_values("timestampUtc").reset_index(drop=True)

    df, feature_cols, categories = build_features(df)
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

    # C.2
    model = XGBClassifier(**XGB_PARAMS)
    model.fit(X_train, y_train, eval_set=[(X_val, y_val)], verbose=True)
    print(f"best_iteration (early stopping): {model.best_iteration}")

    # C.3 — see module docstring: FrozenEstimator keeps the early-stopped fit intact through calibration.
    calib = CalibratedClassifierCV(FrozenEstimator(model), method="sigmoid")
    calib.fit(X_val, y_val)

    # C.4 — report train/validation/test AUC honestly, no sugar-coating.
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
        print(f"⚠ CẢNH BÁO: AUC(train) - AUC(test) = {gap:.4f} > {OVERFIT_AUC_GAP_THRESHOLD} — dấu hiệu overfit,")
        print("  diễn giải kết quả thận trọng. Không tự kết luận model tốt/xấu.")
    print("")
    print("Lưu ý diễn giải: AUC 0.55-0.62 trên tập test được coi là tín hiệu MẠNH trong trading —")
    print("KHÔNG kỳ vọng 0.80+, nếu thấy vậy nhiều khả năng là rò rỉ dữ liệu (data leakage).")

    # C.3 export
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


if __name__ == "__main__":
    main()
