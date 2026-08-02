"""
TICKET-116 — shared helpers for the walk-forward validation + threshold/PR/calibration reporting task.

Reused conventions from train_xgb_momentum_v5b.py (TICKET-112), copied verbatim where the ticket
requires "exact same" behavior:
  - build_features(): identical one-hot encoding logic (12 features: 9 numeric + 4 categorical one-hot).
  - HORIZON_CANDLES=10 purge-gap convention: drop the LAST `purge` rows (chronologically) of the
    earlier split at every train->val and val->test boundary, so a Fixed-Time-Horizon label (looks
    10 candles into the future) never leaks across a split boundary.
  - XGB_PARAMS or calibration/ONNX code are NOT duplicated here (Việc 1/2 does not export ONNX — only
    train_xgb_momentum_v5b.py and ticket116TrainV5bScalePosWeight.py do that, per the ticket).

ANALYSIS/EXPERIMENTAL ONLY (TICKET-116) — does not touch any production file.
"""

import os

import matplotlib

matplotlib.use("Agg")

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from sklearn.calibration import CalibratedClassifierCV, calibration_curve
from sklearn.frozen import FrozenEstimator
from sklearn.metrics import (
    average_precision_score,
    precision_recall_curve,
    precision_score,
    recall_score,
    roc_auc_score,
)
from xgboost import XGBClassifier

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
PLOTS_DIR = os.path.join(REPO_ROOT, "data", "ticket116-plots")

LABEL_COLUMN = "label_win"
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
HORIZON_CANDLES = 10

# Identical to V5b's XGB_PARAMS (train_xgb_momentum_v5b.py) — no monotone_constraints, no
# scale_pos_weight. ticket116TrainV5bScalePosWeight.py copies this dict and adds ONE key to it.
XGB_PARAMS = dict(
    objective="binary:logistic",
    eval_metric="auc",
    learning_rate=0.03,
    max_depth=4,
    subsample=0.8,
    colsample_bytree=0.8,
    early_stopping_rounds=50,
)

THRESHOLDS = [round(0.10 + 0.05 * i, 2) for i in range(17)]  # 0.10, 0.15, ..., 0.90


def build_features(df: pd.DataFrame) -> tuple[pd.DataFrame, list[str], dict[str, list[str]]]:
    """Identical to train_xgb_momentum_v5b.py's build_features — copied, not imported, so this
    module has no import-time dependency on the training script (keeps scripts independently runnable)."""
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


def load_labeled_df(csv_path: str) -> pd.DataFrame:
    df = pd.read_csv(csv_path)
    df = df.sort_values("timestampUtc").reset_index(drop=True)
    df["_ts"] = pd.to_datetime(df["timestampUtc"], unit="ms", utc=True)
    return df


def purge_trailing(df: pd.DataFrame, purge: int) -> pd.DataFrame:
    """Drops the last `purge` rows (chronologically) of df — mirrors v5b's
    `df.iloc[: boundary - purge]` convention, applied to an arbitrary (already time-sorted) slice."""
    if purge <= 0 or len(df) <= purge:
        return df.iloc[0:0] if len(df) <= purge else df
    return df.iloc[: len(df) - purge]


def fixed_602020_split(df: pd.DataFrame, purge: int = HORIZON_CANDLES) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    """Same fixed 60/20/20 chronological split + purge convention as train_xgb_momentum_v5b.py."""
    n = len(df)
    train_end = int(n * 0.6)
    val_end = int(n * 0.8)
    train_df = df.iloc[: train_end - purge]
    val_df = df.iloc[train_end : val_end - purge]
    test_df = df.iloc[val_end:]
    return train_df, val_df, test_df


def window_split(
    df: pd.DataFrame,
    train_start: str,
    train_end: str,
    val_end: str,
    test_end: str,
    purge: int = HORIZON_CANDLES,
) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    """Selects a window by REAL date boundaries (half-open [start, end) except the final test_end,
    which is inclusive so W4's test reaches the true last row of the dataset), then applies the same
    trailing-purge convention as fixed_602020_split at each internal (train->val, val->test) boundary.
    Test split is NOT purged at its trailing edge (matches v5b: only earlier-of-pair splits are purged).
    """
    ts = df["_ts"]
    train_start_ts = pd.Timestamp(train_start, tz="UTC")
    train_end_ts = pd.Timestamp(train_end, tz="UTC")
    val_end_ts = pd.Timestamp(val_end, tz="UTC")
    test_end_ts = pd.Timestamp(test_end, tz="UTC")

    train_window = df[(ts >= train_start_ts) & (ts < train_end_ts)]
    val_window = df[(ts >= train_end_ts) & (ts < val_end_ts)]
    test_window = df[(ts >= val_end_ts) & (ts <= test_end_ts)]

    train_df = purge_trailing(train_window, purge)
    val_df = purge_trailing(val_window, purge)
    test_df = test_window
    return train_df, val_df, test_df


def train_calibrated_model(
    train_df: pd.DataFrame, val_df: pd.DataFrame, feature_cols: list[str], xgb_params: dict
) -> tuple[CalibratedClassifierCV, XGBClassifier]:
    X_train = train_df[feature_cols].values.astype(np.float32)
    y_train = train_df[LABEL_COLUMN].values.astype(int)
    X_val = val_df[feature_cols].values.astype(np.float32)
    y_val = val_df[LABEL_COLUMN].values.astype(int)

    model = XGBClassifier(**xgb_params)
    model.fit(X_train, y_train, eval_set=[(X_val, y_val)], verbose=False)

    calib = CalibratedClassifierCV(FrozenEstimator(model), method="sigmoid")
    calib.fit(X_val, y_val)
    return calib, model


def threshold_table(y_true: np.ndarray, p: np.ndarray) -> list[dict]:
    """Precision/recall at each threshold in THRESHOLDS. Explicitly reports the zero-predicted-
    positive edge case as undefined rather than crashing or silently defaulting to 0."""
    rows = []
    for t in THRESHOLDS:
        y_pred = (p >= t).astype(int)
        n_pred_pos = int(y_pred.sum())
        if n_pred_pos == 0:
            precision = None
            precision_str = "undefined (0 predicted positive)"
        else:
            precision = float(precision_score(y_true, y_pred, zero_division=0))
            precision_str = f"{precision:.4f}"
        recall = float(recall_score(y_true, y_pred, zero_division=0))
        rows.append(
            {
                "threshold": t,
                "n_pred_pos": n_pred_pos,
                "precision": precision,
                "precision_str": precision_str,
                "recall": recall,
            }
        )
    return rows


def make_pr_curve_plot(y_true: np.ndarray, p: np.ndarray, title: str, out_path: str) -> float:
    precision, recall, _ = precision_recall_curve(y_true, p)
    ap = float(average_precision_score(y_true, p))
    plt.figure(figsize=(6, 5))
    plt.plot(recall, precision, label=f"AP = {ap:.4f}")
    plt.xlabel("Recall")
    plt.ylabel("Precision")
    plt.title(title)
    plt.ylim(0, 1.05)
    plt.xlim(0, 1.0)
    plt.legend()
    plt.grid(alpha=0.3)
    plt.tight_layout()
    plt.savefig(out_path, dpi=110)
    plt.close()
    return ap


def make_calibration_plot(y_true: np.ndarray, p: np.ndarray, title: str, out_path: str, n_bins: int = 10) -> list[dict]:
    prob_true, prob_pred = calibration_curve(y_true, p, n_bins=n_bins, strategy="uniform")
    plt.figure(figsize=(6, 5))
    plt.plot(prob_pred, prob_true, marker="o", label="model")
    plt.plot([0, 1], [0, 1], linestyle="--", color="gray", label="perfectly calibrated")
    plt.xlabel("Mean predicted probability")
    plt.ylabel("Observed win rate")
    plt.title(title)
    plt.xlim(0, 1.0)
    plt.ylim(0, 1.0)
    plt.legend()
    plt.grid(alpha=0.3)
    plt.tight_layout()
    plt.savefig(out_path, dpi=110)
    plt.close()
    return [{"mean_predicted": float(a), "observed_win_rate": float(b)} for a, b in zip(prob_pred, prob_true)]


def make_histogram_plot(p: np.ndarray, title: str, out_path: str) -> dict:
    plt.figure(figsize=(6, 5))
    plt.hist(p, bins=30, range=(0, 1), color="steelblue", edgecolor="black", alpha=0.8)
    plt.axvline(0.5, color="red", linestyle="--", label="threshold 0.5")
    plt.xlabel("Predicted probability (win)")
    plt.ylabel("Count")
    plt.title(title)
    plt.legend()
    plt.tight_layout()
    plt.savefig(out_path, dpi=110)
    plt.close()
    frac_above_half = float((p >= 0.5).mean())
    return {
        "min": float(np.min(p)),
        "max": float(np.max(p)),
        "mean": float(np.mean(p)),
        "median": float(np.median(p)),
        "std": float(np.std(p)),
        "frac_above_0.5": frac_above_half,
        "n": int(len(p)),
    }


def full_report_for_model(
    model_key: str,
    calib: CalibratedClassifierCV,
    model: XGBClassifier,
    train_df: pd.DataFrame,
    val_df: pd.DataFrame,
    test_df: pd.DataFrame,
    feature_cols: list[str],
) -> dict:
    """Produces the full Việc-2 report payload for one trained+calibrated model, using its own TEST
    split. Saves 3 plots under PLOTS_DIR named f'{model_key}-*.png'."""
    os.makedirs(PLOTS_DIR, exist_ok=True)

    X_train = train_df[feature_cols].values.astype(np.float32)
    y_train = train_df[LABEL_COLUMN].values.astype(int)
    X_val = val_df[feature_cols].values.astype(np.float32)
    y_val = val_df[LABEL_COLUMN].values.astype(int)
    X_test = test_df[feature_cols].values.astype(np.float32)
    y_test = test_df[LABEL_COLUMN].values.astype(int)

    p_train = calib.predict_proba(X_train)[:, 1]
    p_val = calib.predict_proba(X_val)[:, 1]
    p_test = calib.predict_proba(X_test)[:, 1]

    auc_train = float(roc_auc_score(y_train, p_train))
    auc_val = float(roc_auc_score(y_val, p_val))
    auc_test = float(roc_auc_score(y_test, p_test))

    thresholds = threshold_table(y_test, p_test)

    pr_path = os.path.join(PLOTS_DIR, f"{model_key}-pr-curve.png")
    ap = make_pr_curve_plot(y_test, p_test, f"{model_key} — PR curve (test)", pr_path)

    calib_path = os.path.join(PLOTS_DIR, f"{model_key}-calibration.png")
    calib_bins = make_calibration_plot(y_test, p_test, f"{model_key} — calibration (test)", calib_path)

    hist_path = os.path.join(PLOTS_DIR, f"{model_key}-prob-histogram.png")
    hist_stats = make_histogram_plot(p_test, f"{model_key} — predicted probability histogram (test)", hist_path)

    return {
        "model_key": model_key,
        "best_iteration": int(model.best_iteration) if model.best_iteration is not None else None,
        "n_train": len(train_df),
        "n_val": len(val_df),
        "n_test": len(test_df),
        "label_rate_train": float(y_train.mean()) if len(y_train) else None,
        "label_rate_val": float(y_val.mean()) if len(y_val) else None,
        "label_rate_test": float(y_test.mean()) if len(y_test) else None,
        "auc_train": auc_train,
        "auc_val": auc_val,
        "auc_test": auc_test,
        "thresholds": thresholds,
        "average_precision": ap,
        "pr_curve_plot": os.path.relpath(pr_path, REPO_ROOT).replace(os.sep, "/"),
        "calibration_bins": calib_bins,
        "calibration_plot": os.path.relpath(calib_path, REPO_ROOT).replace(os.sep, "/"),
        "hist_stats": hist_stats,
        "hist_plot": os.path.relpath(hist_path, REPO_ROOT).replace(os.sep, "/"),
    }
