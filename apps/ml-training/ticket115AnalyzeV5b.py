"""
TICKET-115 Nhom H - ANALYSIS ONLY, khong tao model moi de wire vao production. Tai lai dung
data/training/momentum-v5-labeled.csv, dung EXACT feature-building + chia tap thoi gian (60/20/20 +
purge gap HORIZON_CANDLES=10) nhu train_xgb_momentum_v5b.py (TICKET-112), tai-train model V5b TRONG BO
NHO (khong co booster/pickle da luu san, chi co ONNX export) de tai tao dung V5b, roi tinh tren tap TEST:
- H2/H3/H4: precision/recall/confusion matrix o threshold 0.5
- H5: feature importance (gain-based)
- H6: SHAP values tren tap TEST

Khong dung file production, khong ghi de models/xgb_momentum_v5b_experimental.onnx.
Run: apps/ml-training/.venv/Scripts/python.exe apps/ml-training/ticket115AnalyzeV5b.py
"""

import json
import os
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

import numpy as np
import pandas as pd
from sklearn.calibration import CalibratedClassifierCV
from sklearn.frozen import FrozenEstimator
from sklearn.metrics import confusion_matrix, precision_score, recall_score
from xgboost import XGBClassifier

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
CSV_PATH = os.path.join(REPO_ROOT, "data", "training", "momentum-v5-labeled.csv")
LABEL_COLUMN = "label_win"

# Identical to train_xgb_momentum_v5b.py
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

XGB_PARAMS = dict(
    objective="binary:logistic",
    eval_metric="auc",
    learning_rate=0.03,
    max_depth=4,
    subsample=0.8,
    colsample_bytree=0.8,
    early_stopping_rounds=50,
)


def build_features(df: pd.DataFrame):
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


def main():
    df = pd.read_csv(CSV_PATH)
    df = df.sort_values("timestampUtc").reset_index(drop=True)
    df, feature_cols, categories = build_features(df)

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

    print(f"Train {len(train_df)} / Val {len(val_df)} / Test {len(test_df)}")

    model = XGBClassifier(**XGB_PARAMS)
    model.fit(X_train, y_train, eval_set=[(X_val, y_val)], verbose=False)
    print(f"best_iteration = {model.best_iteration}")

    # V5b that (ONNX export) dung CalibratedClassifierCV(sigmoid, fit tren tap val) truoc khi ap
    # threshold 0.5 -- calibration la mot phep bien doi DON DIEU nhung KHONG bao toan diem cat 0.5 tuyet
    # doi (chi bao toan THU HANG tuong doi). De H2-H4 phan anh dung hanh vi threshold 0.5 cua model V5b
    # THAT, dung xac suat DA CALIBRATE (giong het train_xgb_momentum_v5b.py). H5 (gain) va H6 (SHAP) van
    # dung truc tiep booster/model goc vi ca 2 giai thich cau truc cay, khong lien quan calibration.
    calib = CalibratedClassifierCV(FrozenEstimator(model), method="sigmoid")
    calib.fit(X_val, y_val)
    p_test = calib.predict_proba(X_test)[:, 1]
    y_pred = (p_test >= 0.5).astype(int)

    precision = precision_score(y_test, y_pred, zero_division=0)
    recall = recall_score(y_test, y_pred, zero_division=0)
    cm = confusion_matrix(y_test, y_pred, labels=[0, 1])
    tn, fp, fn, tp = cm.ravel()

    print("")
    print("=== H2/H3/H4 (threshold=0.5, tap TEST) ===")
    print(f"Precision = {precision:.4f}")
    print(f"Recall    = {recall:.4f}")
    print(f"Confusion matrix (labels=[0,1]):\n{cm}")
    print(f"TP={tp} FP={fp} TN={tn} FN={fn}")

    print("")
    print("=== H5: feature importance (gain-based) ===")
    # sklearn XGBClassifier.feature_importances_ mac dinh dung importance_type='gain' (chuan hoa tong=1)
    # -- xac nhan qua get_booster().get_score(importance_type='gain') (KHONG chuan hoa, don vi khac).
    booster = model.get_booster()
    gain_raw = booster.get_score(importance_type="gain")
    # Map feature index -> gain (booster dung ten f0..fN theo thu tu feature_cols truyen vao)
    fmap = {f"f{i}": name for i, name in enumerate(feature_cols)}
    gain_named = {fmap.get(k, k): v for k, v in gain_raw.items()}
    ranked = sorted(gain_named.items(), key=lambda kv: kv[1], reverse=True)
    all_feats_present = set(gain_named.keys())
    missing_feats = [f for f in feature_cols if f not in all_feats_present]
    print(f"So feature xuat hien trong it nhat 1 lan split cua cay: {len(ranked)} / {len(feature_cols)} tong")
    if missing_feats:
        print(f"Feature KHONG bao gio duoc dung de split (gain=0, khong xuat hien trong booster): {missing_feats}")
    print("Full ranked list (feature: gain):")
    for name, val in ranked:
        print(f"  {name}: {val:.4f}")
    for name in missing_feats:
        print(f"  {name}: 0.0000 (khong dung)")

    print("")
    print("sklearn feature_importances_ (should match normalized gain):")
    fi = model.feature_importances_
    fi_ranked = sorted(zip(feature_cols, fi), key=lambda kv: kv[1], reverse=True)
    for name, val in fi_ranked[:12]:
        print(f"  {name}: {val:.4f}")

    print("")
    print("=== H6: SHAP tren tap TEST ===")
    try:
        import shap
    except ImportError:
        print("KHONG THE TRA LOI: thu vien `shap` chua duoc cai trong apps/ml-training/.venv va khong")
        print("duoc tu dong cai theo yeu cau (tranh cai package ngoai y muon nguoi dung) -- neu muon co")
        print("H6, chay: apps/ml-training/.venv/Scripts/python.exe -m pip install shap")
        return

    explainer = shap.TreeExplainer(model)
    shap_values = explainer.shap_values(X_test)
    if isinstance(shap_values, list):
        shap_values = shap_values[1]  # class 1 (win)

    mean_abs_shap = np.abs(shap_values).mean(axis=0)
    shap_ranked = sorted(zip(feature_cols, mean_abs_shap), key=lambda kv: kv[1], reverse=True)
    print("Top feature theo mean(|SHAP|) tren tap TEST:")
    for name, val in shap_ranked[:12]:
        print(f"  {name}: {val:.5f}")
    print(f"Feature anh huong manh nhat: {shap_ranked[0][0]} (mean|SHAP|={shap_ranked[0][1]:.5f})")

    print("")
    print("Kiem tra quan he don dieu (monotonic) giua gia tri raw feature va SHAP value, cho tung feature so:")
    for i, name in enumerate(feature_cols):
        raw_vals = X_test[:, i]
        sv = shap_values[:, i]
        if np.std(raw_vals) == 0:
            continue
        corr = np.corrcoef(raw_vals, sv)[0, 1]
        # Flag: feature co corr gan 0 hoac dau am ro (nghich voi ky vong thong thuong "cao hon -> SHAP
        # cao hon"), VA dong thoi co ca gia tri SHAP duong lan am o vung raw-value cao (top tercile).
        high_mask = raw_vals >= np.percentile(raw_vals, 66)
        high_sv = sv[high_mask]
        mixed_sign_high = (high_sv.max() > 0) and (high_sv.min() < 0) if len(high_sv) > 0 else False
        flag = ""
        if abs(corr) < 0.15 and mixed_sign_high:
            flag = "  <-- KHA NANG NON-MONOTONIC/INTERACTION-DRIVEN (corr yeu + SHAP trai dau o vung raw cao)"
        print(f"  {name}: corr(raw,SHAP)={corr:+.3f}{flag}")


if __name__ == "__main__":
    main()
