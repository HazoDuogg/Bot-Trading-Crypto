# T158 — Formal OB-Disabled Portfolio Experiment

> **TICKET-160A path note:** the "Evidence paths" list below originally used the filenames as written at
> T158 time (`data/ticket158-*.{csv,json}`). TICKET-160's cleanup moved these byte-identical files to
> `data/archive/ticket158/ticket158-*.{csv,json}`; TICKET-160A updated the paths in this report to match
> (no other text in this report was changed). See `docs/active-baseline-and-artifact-index.md` /
> `docs/baseline-registry.md` for the current baseline registry.

## Decision

**SHADOW_ONLY**. The disable direction is favorable, but existing-history holdout remains too thin for merge authorization. No deployment occurred.

## Central portfolio

- Enabled: 211 trades, PF 1.3019, net 460.5084, expectancy 2.1825, MaxDD 418.6271.
- Disabled: 264 trades, PF 1.3948, net 606.6195, expectancy 2.2978, MaxDD 418.6271.
- Delta: net +146.1112, PF +0.0929, expectancy +0.1153, MaxDD -0.0000, trades +53.

Fee-only and Light improve PF/net; Conservative stress worsens net by 20.0871 and MaxDD by 35.0304. Leave-one-month-out Central improvement survives every month. Exact-timestamp fallback attribution is separated from the downstream path residual in the exports.

The reversible configuration is `obEnabled`; true/undefined preserves current behavior, false skips OB and continues FVG/Sweep. The merge diff remains unauthorized; the configuration is shadow-only.

## T158 FINAL DECISION

```text
T158 FINAL DECISION
Decision: SHADOW_ONLY
Code/commit: working tree / cced931b39265d51b41017689ecec378fd9cb88b
Input manifest/hash: 0040ec0ad76a206d141042b5d93e82b95ae62e960a358d291a38c9dae3d93535
OB-enabled parity: PASS
Regression/build/typecheck: PASS
Rollback test: PASS
Production deployed: NO

Central portfolio:
- OB_ENABLED: PF 1.3018644097963348, net 460.50836737263216, expectancy 2.1825041107707683, MaxDD 418.6270592276059, trades 211
- OB_DISABLED: PF 1.3947839228431962, net 606.6195245715165, expectancy 2.2978012294375625, MaxDD 418.62705922760574, trades 264
- Net PnL delta: 146.11115719888437
- PF delta: 0.09291951304686141
- Expectancy delta: 0.11529711866679415
- MaxDD delta: -1.7053025658242404e-13
- Trade-count delta: 53

Benefit attribution:
- Avoided OB losses: 0
- FVG replacements: -0.6154233975148138
- Sweep replacements: 0
- Downstream path effects: 146.72658059639917
- Unresolved: 0

Stability:
- Monthly/leave-one-month-out: PASS
- Symbol/side: see stability export
- Extreme-trade sensitivity: see stability export
- New loss clusters: see loss-cluster export
Known limitations: thin independent holdout; no additional compatible history; downstream path residual is not direct causal attribution; Conservative stress regresses.
Is merge-ready OB-disabled configuration authorized? SHADOW_ONLY
Is VPS deployment authorized? NO
Required release/rollback action: shadow with obEnabled=false; immediate rollback obEnabled=true
Next ticket: shadow observation and release gate

Evidence paths (updated by TICKET-160A to current post-T160-archive locations; content byte-identical to
the original data/ticket158-*.{json,csv} files written at T158 time):
- data/archive/ticket158/ticket158-run-manifest.json
- data/archive/ticket158/ticket158-scenario-portfolio-comparison.csv
- data/archive/ticket158/ticket158-fallback-attribution-ledger.csv
- data/archive/ticket158/ticket158-fallback-attribution-summary.csv
- data/archive/ticket158/ticket158-stability.csv
- data/archive/ticket158/ticket158-loss-clusters.csv
- data/archive/ticket158/ticket158-regression-rollback.csv
- data/archive/ticket158/ticket158-config-diff.json
```
