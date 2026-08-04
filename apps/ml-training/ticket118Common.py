"""
TICKET-118 — shared helpers for Cách A / Cách B training + Việc-2-style reporting on the FIXED V6
dataset (data/training/momentum-v6-labeled.csv, TICKET-117's side-conflict bug fixed).

Copied VERBATIM from ticket116Common.py (TICKET-116) where the ticket requires "exact same" behavior
(same reasoning as ticket116Common.py's own docstring: independent-file convention, not imported, so
each script has no import-time dependency on another ticket's module) — build_features() one-hot logic,
HORIZON_CANDLES=10 purge convention, window_split()/fixed_602020_split() split logic, threshold/PR/
calibration/histogram reporting. Two differences only:
  - CSV_PATH points at momentum-v6-labeled.csv (not v5) and PLOTS_DIR at data/ticket118-plots (not
    ticket116-plots).
  - build_features() takes an explicit `categorical_features` list (defaults to the same 4 as V5b) so
    Cách A can pass CATEGORICAL_FEATURES + ["side"] without touching Cách B's 4.

ANALYSIS/EXPERIMENTAL ONLY (TICKET-118) — does not touch any production file, does not change
hyperparameters or split methodology vs V5b/TICKET-116 (only the side-feature/population-splitting fix
is the isolated variable here, per the ticket).
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
PLOTS_DIR = os.path.join(REPO_ROOT, "data", "ticket118-plots")
CSV_PATH = os.path.join(REPO_ROOT, "data", "training", "momentum-v6-labeled.csv")

LABEL_COLUMN = "label_win"
# Same 12 features as V5b — Cách B trains 2 separate side-filtered models on these 12 (side is NOT
# included since each model only sees one side by construction). Cách A adds "side" on top for its ONE
# combined model — see CATEGORICAL_FEATURES_CACH_A below.
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
CATEGORICAL_FEATURES_CACH_A = CATEGORICAL_FEATURES + ["side"]
MISSING_CATEGORICAL_VALUE = "UNKNOWN"
HORIZON_CANDLES = 10

# Identical to V5b's XGB_PARAMS (train_xgb_momentum_v5b.py) — no monotone_constraints, no
# scale_pos_weight, no hyperparameter changes anywhere in TICKET-118 (isolated variable = side fix only).
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


def build_features(df: pd.DataFrame, categorical_features: list[str] = CATEGORICAL_FEATURES) -> tuple[pd.DataFrame, list[str], dict[str, list[str]]]:
    """Identical one-hot logic to ticket116Common.py's build_features, parameterized on which
    categorical columns to encode (Cách B passes the default 4, Cách A passes 4 + "side")."""
    df = df.copy()
    for col in categorical_features:
        df[col] = df[col].fillna(MISSING_CATEGORICAL_VALUE).replace("", MISSING_CATEGORICAL_VALUE)

    categories = {col: sorted(df[col].unique().tolist()) for col in categorical_features}

    feature_cols = list(NUMERIC_FEATURES)
    for col in categorical_features:
        for cat in categories[col]:
            onehot_col = f"{col}__{cat}"
            df[onehot_col] = (df[col] == cat).astype(np.float32)
            feature_cols.append(onehot_col)

    return df, feature_cols, categories


def load_labeled_df(csv_path: str = CSV_PATH) -> pd.DataFrame:
    df = pd.read_csv(csv_path)
    df = df.sort_values("timestampUtc").reset_index(drop=True)
    df["_ts"] = pd.to_datetime(df["timestampUtc"], unit="ms", utc=True)
    return df


def purge_trailing(df: pd.DataFrame, purge: int) -> pd.DataFrame:
    """Drops the last `purge` rows (chronologically) of df — identical to ticket116Common.py."""
    if purge <= 0 or len(df) <= purge:
        return df.iloc[0:0] if len(df) <= purge else df
    return df.iloc[: len(df) - purge]


def fixed_602020_split(df: pd.DataFrame, purge: int = HORIZON_CANDLES) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    """Same fixed 60/20/20 chronological split + purge convention as train_xgb_momentum_v5b.py /
    ticket116Common.py, applied to whatever df is passed in (side-filtered or not)."""
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
    """Identical to ticket116Common.py's window_split — real date boundaries, half-open except test_end
    inclusive, same trailing-purge convention. Applied to whatever df is passed in (side-filtered here)."""
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
    """Identical to ticket116Common.py's full_report_for_model — Việc-2 report payload for one
    trained+calibrated model, using its own TEST split. Saves 3 plots under PLOTS_DIR (ticket118-plots)."""
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
