"""
TICKET-021 — validates the TS export feature -> Python train -> ONNX -> (future) TS load pipeline.
NOT a production model: data/training/draft-setups-labeled.csv has only 159 rows. Priority is a
correct, working train->calibrate->export chain, not chasing AUC (see B.6 overfit warning below).

Run from repo root: apps/ml-training/.venv/Scripts/python.exe apps/ml-training/train_xgb.py
(after `pip install -r apps/ml-training/requirements.txt` in that venv).

=== ONNX export note (read before touching the export section) ===
onnxmltools.convert_xgboost() only accepts a raw XGBoost model (XGBClassifier/Booster) — it cannot
convert a fitted sklearn CalibratedClassifierCV, which is what B.7 requires exporting ("model ĐÃ
CALIBRATE, không phải model XGBoost thô"). The documented workaround (register onnxmltools' XGBoost
converter into skl2onnx's own registry, then call skl2onnx.convert_sklearn() on the
CalibratedClassifierCV) was tried and hits a hard version conflict between the latest pip releases
of onnxmltools (1.16.0) and skl2onnx (1.20.0): each library's XGBoost shape-calculator/type-checking
code asserts isinstance against its OWN FloatTensorType/DataType class, and the two are no longer the
same class in these versions. Downgrading skl2onnx to a version contemporaneous with onnxmltools
1.16.0 (tried 1.16.0) then breaks on the currently-installed onnx 1.22.0 (missing `onnx.mapping`,
removed in newer onnx). This was surfaced to the user before proceeding (per ticket instruction), who
approved the option below.

Approach actually used: convert the RAW fitted XGBoost model with onnxmltools.convert_xgboost() (this
part works natively, no compatibility issue), then graft a small standard-ONNX subgraph
(Slice -> Mul -> Add -> Neg -> Sigmoid -> Sub -> Concat -> ArgMax) onto that graph, reproducing
sklearn's OWN sigmoid-calibration formula (Platt scaling) with the exact a_/b_ coefficients
CalibratedClassifierCV already learned. No new calibration math is invented — this is
sklearn.calibration._SigmoidCalibration.predict(): `expit(-(a_ * T + b_))`, read directly from the
installed sklearn 1.9.0 source (sklearn/calibration.py) to confirm exactly what score T calibration
was fit/applied on. For method='sigmoid' with an estimator that has no decision_function (XGBClassifier
doesn't), T is the base estimator's raw predict_proba() positive-class column — NOT a logit transform
(that only happens for method='temperature', a different code path, unrelated to this ticket). The
composed ONNX graph's output is verified below to match sklearn's calib.predict_proba() to ~1e-7
(float32 precision) on every row, train AND test, before the file is written — the model is NOT saved
if this check fails.

CalibratedClassifierCV is fit with ensemble=False (sklearn default is "auto" -> True for a plain
estimator, i.e. cv separate fitted-estimator/calibrator pairs averaged at predict time). ensemble=False
was chosen deliberately: it produces exactly ONE fitted base estimator + ONE calibrator (still uses
internal cross-validation to obtain the out-of-fold scores the calibrator is fit on — same
"cross-validation nội bộ" requirement from B.5), which is what gets exported here. The alternative
(ensemble=True, the sklearn default) would require converting and averaging `cv` separate XGBoost
models inside the ONNX graph — much more moving parts to get exactly right on a first-pass pipeline
validation, and not requested explicitly by the ticket text (which only specifies method='sigmoid').
"""

import json
import os
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")  # Windows console default codepage can't print Vietnamese/→

import numpy as np
import onnx
import onnxruntime as ort
import pandas as pd
from onnx import TensorProto, helper
from onnxmltools import convert_xgboost
from onnxmltools.convert.common.data_types import FloatTensorType as OMLFloatTensorType
from sklearn.calibration import CalibratedClassifierCV
from sklearn.metrics import accuracy_score, roc_auc_score
from xgboost import XGBClassifier

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
CSV_PATH = os.path.join(REPO_ROOT, "data", "training", "draft-setups-labeled.csv")
MODELS_DIR = os.path.join(REPO_ROOT, "models")
ONNX_PATH = os.path.join(MODELS_DIR, "xgb_confidence_v1.onnx")
SCHEMA_PATH = os.path.join(MODELS_DIR, "xgb_confidence_v1_feature_schema.json")

# B.2 — order here IS the order fed into the model. Do not reorder without re-generating the schema
# AND updating whatever TS code consumes it later.
NUMERIC_FEATURES = ["adx1h", "atrPercentile5m", "bbWidthPercentile15m", "volumeZScore5m", "slDistancePercent"]
CATEGORICAL_FEATURES = ["regime", "setupType", "side", "atrTrend5m", "adxDirection1h", "macroDirection", "symbol"]
MISSING_CATEGORICAL_VALUE = "UNKNOWN"

OVERFIT_AUC_GAP_THRESHOLD = 0.15

# B.4 — conservative starting point, NOT tuned. PM may revisit once more data exists.
XGB_PARAMS = dict(
    objective="binary:logistic",
    max_depth=3,
    n_estimators=100,
    learning_rate=0.1,
    subsample=0.8,
    reg_lambda=1.0,
)


def build_features(df: pd.DataFrame) -> tuple[pd.DataFrame, list[str], dict[str, list[str]]]:
    """B.2 — one-hot encodes categoricals (alphabetical category order), fills missing/empty
    categoricals as MISSING_CATEGORICAL_VALUE (no rows dropped, no guessed values)."""
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


def export_calibrated_onnx(calib: CalibratedClassifierCV, n_features: int) -> onnx.ModelProto:
    """B.7 — see module docstring for why this isn't a single onnxmltools.convert_xgboost() call."""
    base_est = calib.calibrated_classifiers_[0].estimator
    calibrator = calib.calibrated_classifiers_[0].calibrators[0]
    a_ = float(calibrator.a_)
    b_ = float(calibrator.b_)

    xgb_onnx = convert_xgboost(base_est, initial_types=[("input", OMLFloatTensorType([None, n_features]))])
    graph = xgb_onnx.graph
    prob_output_name = next(o.name for o in graph.output if o.name == "probabilities")
    del graph.output[:]

    graph.initializer.extend(
        [
            helper.make_tensor("slice_starts", TensorProto.INT64, [1], [1]),
            helper.make_tensor("slice_ends", TensorProto.INT64, [1], [2]),
            helper.make_tensor("slice_axes", TensorProto.INT64, [1], [1]),
            helper.make_tensor("calib_a", TensorProto.FLOAT, [1], [a_]),
            helper.make_tensor("calib_b", TensorProto.FLOAT, [1], [b_]),
            helper.make_tensor("one_const", TensorProto.FLOAT, [1], [1.0]),
        ]
    )
    graph.node.extend(
        [
            # Positive-class raw probability column from the XGBoost tree ensemble.
            helper.make_node("Slice", [prob_output_name, "slice_starts", "slice_ends", "slice_axes"], ["p1_raw"], name="slice_p1"),
            # sklearn's _SigmoidCalibration.predict(T) = expit(-(a_*T + b_)) — same formula, same a_/b_.
            helper.make_node("Mul", ["p1_raw", "calib_a"], ["ax"], name="mul_a"),
            helper.make_node("Add", ["ax", "calib_b"], ["ax_b"], name="add_b"),
            helper.make_node("Neg", ["ax_b"], ["neg_ax_b"], name="neg"),
            helper.make_node("Sigmoid", ["neg_ax_b"], ["calibrated_p1"], name="sigmoid_calib"),
            helper.make_node("Sub", ["one_const", "calibrated_p1"], ["calibrated_p0"], name="sub_p0"),
            helper.make_node("Concat", ["calibrated_p0", "calibrated_p1"], ["calibrated_probabilities"], axis=1, name="concat_proba"),
            helper.make_node("ArgMax", ["calibrated_probabilities"], ["calibrated_label"], axis=1, name="argmax_label"),
        ]
    )
    graph.output.extend(
        [
            helper.make_tensor_value_info("calibrated_probabilities", TensorProto.FLOAT, [None, 2]),
            helper.make_tensor_value_info("calibrated_label", TensorProto.INT64, [None, 1]),
        ]
    )
    xgb_onnx.opset_import.append(helper.make_opsetid("", 13))
    onnx.checker.check_model(xgb_onnx)
    return xgb_onnx


def validate_onnx_matches_sklearn(onnx_model: onnx.ModelProto, calib: CalibratedClassifierCV, X: np.ndarray, label: str) -> float:
    sess = ort.InferenceSession(onnx_model.SerializeToString())
    onnx_proba = sess.run(["calibrated_probabilities"], {"input": X.astype(np.float32)})[0]
    sklearn_proba = calib.predict_proba(X)
    max_diff = float(np.max(np.abs(onnx_proba - sklearn_proba)))
    print(f"  {label}: max abs diff ONNX vs sklearn predict_proba = {max_diff:.2e}")
    return max_diff


def main() -> None:
    # B.1
    df = pd.read_csv(CSV_PATH)

    # B.3 — sort by timestampUtc ascending, 70% train / 30% test, NO shuffling.
    df = df.sort_values("timestampUtc").reset_index(drop=True)

    df, feature_cols, categories = build_features(df)
    os.makedirs(MODELS_DIR, exist_ok=True)
    write_feature_schema(feature_cols, categories)

    split_idx = int(len(df) * 0.7)
    train_df = df.iloc[:split_idx]
    test_df = df.iloc[split_idx:]

    X_train = train_df[feature_cols].values.astype(np.float32)
    y_train = train_df["label_win"].values.astype(int)
    X_test = test_df[feature_cols].values.astype(np.float32)
    y_test = test_df["label_win"].values.astype(int)

    print(f"Train: {len(train_df)} dòng, label_win rate = {y_train.mean():.3f}")
    print(f"Test:  {len(test_df)} dòng, label_win rate = {y_test.mean():.3f}")

    # B.4 + B.5
    base = XGBClassifier(**XGB_PARAMS)
    calib = CalibratedClassifierCV(base, method="sigmoid", cv=3, ensemble=False)
    calib.fit(X_train, y_train)

    # B.6 — report train AND test, no sugar-coating.
    p_train = calib.predict_proba(X_train)[:, 1]
    p_test = calib.predict_proba(X_test)[:, 1]
    auc_train = roc_auc_score(y_train, p_train)
    auc_test = roc_auc_score(y_test, p_test)
    acc_train = accuracy_score(y_train, (p_train >= 0.5).astype(int))
    acc_test = accuracy_score(y_test, (p_test >= 0.5).astype(int))

    print("")
    print(f"AUC  train = {auc_train:.4f}   test = {auc_test:.4f}")
    print(f"Acc  train = {acc_train:.4f}   test = {acc_test:.4f}")
    gap = auc_train - auc_test
    if gap > OVERFIT_AUC_GAP_THRESHOLD:
        print(f"⚠ CẢNH BÁO: AUC(train) - AUC(test) = {gap:.4f} > {OVERFIT_AUC_GAP_THRESHOLD} — dấu hiệu overfit,")
        print("  cỡ mẫu (159 dòng) có thể chưa đủ, diễn giải kết quả thận trọng. Không tự kết luận model tốt/xấu.")

    # B.7
    print("")
    print("Export ONNX (model đã calibrate)...")
    onnx_model = export_calibrated_onnx(calib, n_features=len(feature_cols))

    print("Kiểm chứng ONNX khớp sklearn predict_proba trước khi ghi file...")
    diff_train = validate_onnx_matches_sklearn(onnx_model, calib, X_train, "train")
    diff_test = validate_onnx_matches_sklearn(onnx_model, calib, X_test, "test")
    max_diff = max(diff_train, diff_test)
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
