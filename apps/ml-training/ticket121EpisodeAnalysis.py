"""
TICKET-121 Phần A / Việc 1 — Episode/clustering analysis (row independence check) for Bearish
Cách B v7-original Decile 10 vs Decile 8.

Reads apps/ml-training/../../data/ticket121-artifacts/{decile10,decile8}.csv produced by
ticket121Decile10Forensic.py. ANALYSIS ONLY.

Run: apps/ml-training/.venv/Scripts/python.exe apps/ml-training/ticket121EpisodeAnalysis.py
"""
import os
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

import numpy as np
import pandas as pd

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
ARTIFACT_DIR = os.path.join(REPO_ROOT, "data", "ticket121-artifacts")
GAP_THRESHOLD_MS = 900000  # 15 minutes = 3 candles of 5m


def assign_episodes(df: pd.DataFrame) -> pd.DataFrame:
    df = df.sort_values(["symbol", "timestampUtc"]).reset_index(drop=True)
    episode_id = np.zeros(len(df), dtype=np.int64)
    cur = 0
    for i in range(len(df)):
        if i == 0:
            episode_id[i] = cur
            continue
        same_symbol = df.loc[i, "symbol"] == df.loc[i - 1, "symbol"]
        gap = df.loc[i, "timestampUtc"] - df.loc[i - 1, "timestampUtc"]
        if same_symbol and gap <= GAP_THRESHOLD_MS:
            episode_id[i] = cur
        else:
            cur += 1
            episode_id[i] = cur
    df["episode_id"] = episode_id
    return df


def episode_summary(df: pd.DataFrame, label: str) -> dict:
    df = assign_episodes(df)
    grp = df.groupby("episode_id")
    sizes = grp.size()
    n_episodes = len(sizes)
    median_size = float(sizes.median())
    p90_size = float(sizes.quantile(0.90))
    longest_idx = sizes.idxmax()
    longest_rows = df[df["episode_id"] == longest_idx]
    longest_symbol = longest_rows["symbol"].iloc[0]
    longest_start = pd.to_datetime(longest_rows["timestampUtc"].min(), unit="ms", utc=True)
    longest_end = pd.to_datetime(longest_rows["timestampUtc"].max(), unit="ms", utc=True)
    longest_size = int(sizes.max())

    row_winrate = float(df["label_win"].mean())

    # majority-vote episode-level win
    ep_majority_win = grp["label_win"].apply(lambda s: 1 if s.mean() > 0.5 else (0 if s.mean() < 0.5 else np.nan))
    ep_majority_win = ep_majority_win.dropna()
    majority_vote_episode_winrate = float(ep_majority_win.mean()) if len(ep_majority_win) else float("nan")
    n_ties_excluded = int(n_episodes - len(ep_majority_win))

    # mean-win-rate-within-episode-then-averaged-across-episodes
    ep_mean_win = grp["label_win"].mean()
    mean_of_episode_means = float(ep_mean_win.mean())

    # top-5 longest episodes contribution
    top5 = sizes.sort_values(ascending=False).head(5)
    top5_row_count = int(top5.sum())
    top5_frac_of_rows = top5_row_count / len(df)
    top5_winrate = float(df[df["episode_id"].isin(top5.index)]["label_win"].mean())

    print(f"\n=== {label} ===")
    print(f"n_rows={len(df)}  n_episodes={n_episodes}  median_rows/ep={median_size}  p90_rows/ep={p90_size}")
    print(f"longest episode: {longest_size} rows, symbol={longest_symbol}, {longest_start} -> {longest_end}")
    print(f"row-level winrate={row_winrate:.4f}")
    print(f"episode-level winrate (majority vote, ties excluded n={n_ties_excluded}) = {majority_vote_episode_winrate:.4f}")
    print(f"episode-level winrate (mean-within-episode then averaged across episodes) = {mean_of_episode_means:.4f}")
    print(f"top-5 longest episodes: {top5_row_count} rows ({top5_frac_of_rows:.2%} of all rows), their combined winrate={top5_winrate:.4f}")

    return {
        "label": label,
        "n_rows": len(df),
        "n_episodes": n_episodes,
        "median_rows_per_episode": median_size,
        "p90_rows_per_episode": p90_size,
        "longest_episode_size": longest_size,
        "longest_episode_symbol": longest_symbol,
        "longest_episode_start": str(longest_start),
        "longest_episode_end": str(longest_end),
        "row_winrate": row_winrate,
        "episode_winrate_majority_vote": majority_vote_episode_winrate,
        "n_ties_excluded": n_ties_excluded,
        "episode_winrate_mean_of_means": mean_of_episode_means,
        "top5_row_count": top5_row_count,
        "top5_frac_of_rows": top5_frac_of_rows,
        "top5_winrate": top5_winrate,
        "sizes": sizes,
        "df": df,
    }


def main() -> None:
    d10 = pd.read_csv(os.path.join(ARTIFACT_DIR, "decile10.csv"))
    d8 = pd.read_csv(os.path.join(ARTIFACT_DIR, "decile8.csv"))

    res10 = episode_summary(d10, "Decile 10")
    res8 = episode_summary(d8, "Decile 8")

    # Save episode size distributions for report tables
    res10["sizes"].to_csv(os.path.join(ARTIFACT_DIR, "decile10_episode_sizes.csv"))
    res8["sizes"].to_csv(os.path.join(ARTIFACT_DIR, "decile8_episode_sizes.csv"))

    # Longest episode row dump for detail
    res10["df"][res10["df"]["episode_id"] == res10["df"].groupby("episode_id").size().idxmax()].to_csv(
        os.path.join(ARTIFACT_DIR, "decile10_longest_episode_rows.csv"), index=False
    )

    summary_rows = [{k: v for k, v in r.items() if k not in ("sizes", "df")} for r in (res10, res8)]
    pd.DataFrame(summary_rows).to_csv(os.path.join(ARTIFACT_DIR, "episode_summary.csv"), index=False)
    print(f"\nSaved episode summaries -> {ARTIFACT_DIR}")


if __name__ == "__main__":
    main()
