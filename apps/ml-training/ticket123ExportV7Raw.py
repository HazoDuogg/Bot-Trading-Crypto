"""
TICKET-123 Variant C — export the ALREADY-TRAINED V7 side-fixed models (TICKET-118's Cách B
bullish/bearish, fixed 60/20/20 split, "original" key — exact same training call as
ticket118TrainAndReport.py's train_one()/train_calibrated_model(), reusing ticket118Common.py
VERBATIM: same CSV, same NUMERIC_FEATURES/CATEGORICAL_FEATURES, same XGB_PARAMS, same
fixed_602020_split()) as RAW (uncalibrated) ONNX models.

Difference from apps/ml-training/onnx_calibration_bridge.py's export_calibrated_onnx(): that function
grafts a Platt-scaling subgraph onto the XGBoost ONNX output. This script does NOT — it takes
onnxmltools.convert_xgboost()'s native "probabilities" output tensor and RENAMES it to
"calibrated_probabilities" so apps/bot/src/xgbFilter/momentumScorer.ts's scoreMomentum() (which reads
that exact tensor name — see momentumScorer.ts line ~25) works structurally unchanged. The model is
NOT calibrated despite the tensor name — this is documented here and in the paired
*_raw_feature_schema.json's "calibration" field. Self-verifies ONNX output against
model.predict_proba() directly (the RAW XGBClassifier, not any CalibratedClassifierCV wrapper) on the
model's own TEST split before writing any file to disk, mirroring
onnx_calibration_bridge.py's validate_onnx_matches_sklearn() pattern.

ANALYSIS/EXPERIMENTAL, opt-in only (TICKET-123 Variant C/D, gated behind MODEL_MODE=V7_RAW in
backtest.ts — never used unless explicitly requested). Writes:
  - models/xgb_momentum_bullish_v7_raw.onnx (+ _feature_schema.json)
  - models/xgb_momentum_bearish_v7_raw.onnx (+ _feature_schema.json)

Run: apps/ml-training/.venv/Scripts/python.exe apps/ml-training/ticket123ExportV7Raw.py
"""

import json
import os

import numpy as np
import onnx
import onnxruntime as ort
from onnxmltools import convert_xgboost
from onnxmltools.convert.common.data_types import FloatTensorType

from ticket118Common import (
    CATEGORICAL_FEATURES,
    HORIZON_CANDLES,
    LABEL_COLUMN,
    NUMERIC_FEATURES,
    REPO_ROOT,
    XGB_PARAMS,
    build_features,
    fixed_602020_split,
    load_labeled_df,
)

MODELS_DIR = os.path.join(REPO_ROOT, "models")

SIDES = [("LONG", "bullish"), ("SHORT", "bearish")]


def rename_output(graph, old: str, new: str) -> None:
    for o in graph.output:
        if o.name == old:
            o.name = new
    for node in graph.node:
        node.input[:] = [new if n == old else n for n in node.input]
        node.output[:] = [new if n == old else n for n in node.output]


def export_raw_onnx(model, n_features: int) -> onnx.ModelProto:
    onnx_model = convert_xgboost(model, initial_types=[("input", FloatTensorType([None, n_features]))])
    graph = onnx_model.graph
    assert any(o.name == "probabilities" for o in graph.output), (
        f"expected onnxmltools convert_xgboost() output named 'probabilities', got {[o.name for o in graph.output]}"
    )
    rename_output(graph, "probabilities", "calibrated_probabilities")
    onnx.checker.check_model(onnx_model)
    return onnx_model


def validate(onnx_model: onnx.ModelProto, model, X: np.ndarray, label: str) -> float:
    sess = ort.InferenceSession(onnx_model.SerializeToString())
    onnx_proba = sess.run(["calibrated_probabilities"], {"input": X.astype(np.float32)})[0]
    sklearn_proba = model.predict_proba(X)
    max_diff = float(np.max(np.abs(onnx_proba - sklearn_proba)))
    print(f"  {label}: max abs diff ONNX vs XGBClassifier.predict_proba() = {max_diff:.2e} (n={len(X)})")
    return max_diff


def main() -> None:
    df_full = load_labeled_df()
    os.makedirs(MODELS_DIR, exist_ok=True)

    for side_value, side_label in SIDES:
        print(f"\n=== {side_label} ({side_value}) — V7 RAW export ===")
        df_side = df_full[df_full["side"] == side_value].sort_values("timestampUtc").reset_index(drop=True)
        df_side, feature_cols, categories = build_features(df_side, CATEGORICAL_FEATURES)
        train_df, val_df, test_df = fixed_602020_split(df_side, purge=HORIZON_CANDLES)

        X_train = train_df[feature_cols].values.astype(np.float32)
        y_train = train_df[LABEL_COLUMN].values.astype(int)
        X_val = val_df[feature_cols].values.astype(np.float32)
        y_val = val_df[LABEL_COLUMN].values.astype(int)
        X_test = test_df[feature_cols].values.astype(np.float32)

        from xgboost import XGBClassifier

        model = XGBClassifier(**XGB_PARAMS)
        model.fit(X_train, y_train, eval_set=[(X_val, y_val)], verbose=False)
        print(f"  trained: best_iteration={model.best_iteration}, n_train={len(train_df)}, n_val={len(val_df)}, n_test={len(test_df)}")

        onnx_model = export_raw_onnx(model, n_features=len(feature_cols))
        max_diff_test = validate(onnx_model, model, X_test, f"{side_label} TEST")
        max_diff_train_sample = validate(onnx_model, model, X_train[:500], f"{side_label} TRAIN[:500]")
        if max_diff_test > 1e-4 or max_diff_train_sample > 1e-4:
            raise RuntimeError(
                f"{side_label}: ONNX export does not match sklearn predict_proba() closely enough "
                f"(test={max_diff_test:.2e}, train_sample={max_diff_train_sample:.2e}) — wiring bug, refusing to write model file."
            )

        onnx_path = os.path.join(MODELS_DIR, f"xgb_momentum_{side_label}_v7_raw.onnx")
        with open(onnx_path, "wb") as f:
            f.write(onnx_model.SerializeToString())
        print(f"  -> {onnx_path}")

        schema = {
            "numeric_features": NUMERIC_FEATURES,
            "categorical_feature_order": CATEGORICAL_FEATURES,
            "categorical_features": {col: categories[col] for col in CATEGORICAL_FEATURES},
            "missing_categorical_value": "UNKNOWN",
            "feature_order": feature_cols,
            "calibration": "NONE — raw XGBClassifier.predict_proba() output. Output tensor is named "
            "'calibrated_probabilities' ONLY for structural compatibility with momentumScorer.ts's "
            "scoreMomentum(); it is NOT Platt-scaled or otherwise calibrated. See TICKET-123 Variant C.",
            "source": "TICKET-118 Cach B fixed 60/20/20 split (cachB-{side}-original), ticket118Common.py XGB_PARAMS, momentum-v6-labeled.csv",
        }
        schema_path = os.path.join(MODELS_DIR, f"xgb_momentum_{side_label}_v7_raw_feature_schema.json")
        with open(schema_path, "w", encoding="utf-8") as f:
            json.dump(schema, f, indent=2)
        print(f"  -> {schema_path}")


if __name__ == "__main__":
    main()
