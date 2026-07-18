"""
TICKET-023 — shared ONNX export/validation logic for a fitted sklearn
CalibratedClassifierCV(XGBClassifier, method='sigmoid') model, factored out so a second training
script doesn't copy-paste the sigmoid-calibration ONNX graph formula a second time.

train_xgb.py (TICKET-021) has its OWN inline copy of this exact logic — it predates this module, and
TICKET-023's hard constraint explicitly forbids modifying train_xgb.py, so it was intentionally NOT
retrofitted to import from here (that would count as touching a frozen file). Any FUTURE training
script should import from this module instead of writing the formula a third time.

Read train_xgb.py's module docstring for the full background on WHY this graph-splicing approach is
used instead of a single onnxmltools.convert_xgboost() call (onnxmltools/skl2onnx version
incompatibility discovered and approved by the user in TICKET-021) and exactly which sklearn
internals were read to confirm the formula (`sklearn.calibration._SigmoidCalibration.predict()`).
"""

import numpy as np
import onnx
import onnxruntime as ort
from onnx import TensorProto, helper
from onnxmltools import convert_xgboost
from onnxmltools.convert.common.data_types import FloatTensorType as OMLFloatTensorType
from sklearn.calibration import CalibratedClassifierCV
from sklearn.frozen import FrozenEstimator


def export_calibrated_onnx(calib: CalibratedClassifierCV, n_features: int) -> onnx.ModelProto:
    """Converts the raw fitted XGBoost model inside `calib` to ONNX via onnxmltools (works natively —
    no compatibility issue), then grafts a small standard-ONNX subgraph
    (Slice -> Mul -> Add -> Neg -> Sigmoid -> Sub -> Concat -> ArgMax) reproducing sklearn's OWN
    sigmoid-calibration formula: expit(-(a_ * T + b_)), T = the base estimator's raw predict_proba()
    positive-class column. Requires exactly one (estimator, calibrator) pair in
    `calib.calibrated_classifiers_` (i.e. ensemble=False, or a FrozenEstimator base — both produce
    exactly one pair)."""
    if len(calib.calibrated_classifiers_) != 1:
        raise ValueError(
            f"export_calibrated_onnx expects exactly 1 (estimator, calibrator) pair "
            f"(ensemble=False or a FrozenEstimator base), got {len(calib.calibrated_classifiers_)} — "
            "this bridge does not implement averaging multiple ONNX sub-models."
        )
    base_est = calib.calibrated_classifiers_[0].estimator
    if isinstance(base_est, FrozenEstimator):
        base_est = base_est.estimator  # unwrap — onnxmltools needs the raw XGBClassifier, not the wrapper
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
    """Runs the exported ONNX graph and the original sklearn calib.predict_proba() on the same rows
    and returns the max absolute difference — call this and check the result BEFORE writing the
    .onnx file to disk; do not ship an unverified export."""
    sess = ort.InferenceSession(onnx_model.SerializeToString())
    onnx_proba = sess.run(["calibrated_probabilities"], {"input": X.astype(np.float32)})[0]
    sklearn_proba = calib.predict_proba(X)
    max_diff = float(np.max(np.abs(onnx_proba - sklearn_proba)))
    print(f"  {label}: max abs diff ONNX vs sklearn predict_proba = {max_diff:.2e}")
    return max_diff
