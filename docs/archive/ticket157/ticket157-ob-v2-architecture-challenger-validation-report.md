# T157 — OB V2 Architecture Challenger Validation

> **TICKET-160A path note:** the "Evidence paths" list below originally used the filenames as written at
> T157 time (`data/ticket157-*.csv`). TICKET-160's cleanup moved these byte-identical files to
> `data/archive/ticket157/ticket157-*.csv`; TICKET-160A updated the paths in this report to match (no
> other text in this report was changed). See `docs/active-baseline-and-artifact-index.md` /
> `docs/baseline-registry.md` for the current baseline registry.

## Decision

**OB_DISABLE_EXPERIMENT**. No V2 candidate passes the winner gate; no production change is authorized.

## Central comparison

- **OB_V1_CURRENT:** OB n=47, PF=0.5843728434299685, expectancy=-1.786; portfolio PF=1.302, net=460.508, MaxDD=418.627
- **OB_V2_LIFECYCLE:** OB n=24, PF=0.5851438485100655, expectancy=-2.519; portfolio PF=1.346, net=567.706, MaxDD=418.627
- **OB_V2_STRUCTURAL_RETEST:** OB n=5, PF=0.05230455510888673, expectancy=-6.630; portfolio PF=1.101, net=136.486, MaxDD=340.841
- **OB_V2_STRUCTURAL_RETEST_REWARD:** OB n=0, PF=N/A, expectancy=0.000; portfolio PF=1.395, net=606.620, MaxDD=418.627
- **OB_DISABLED:** OB n=0, PF=N/A, expectancy=0.000; portfolio PF=1.395, net=606.620, MaxDD=418.627

Lifecycle alone remains negative. The structural FVG/body-BOS definition leaves only five Central trades and performs worse. The reward variant emits no OB trades and exactly matches OB_DISABLED in every scenario, so its portfolio result is credited to disabling OB, not to a viable V2 architecture.

V1 parity and anti-leakage checks pass. Expiry 24/48/96 remains directionally negative; buffers 0.1/0.2/0.3 retain zero reward-variant coverage. Holdout populations are too thin for adoption.

## T157 FINAL DECISION

```text
T157 FINAL DECISION
Decision: OB_DISABLE_EXPERIMENT
Code/commit: working tree / cced931b39265d51b41017689ecec378fd9cb88b
Input manifest/hash: 0040ec0ad76a206d141042b5d93e82b95ae62e960a358d291a38c9dae3d93535
V1 parity: PASS
Leakage audit: PASS
Production behavior modified: NO (required)

Central results:
- OB_V1_CURRENT: OB n=47, PF=0.5843728434299685, expectancy=-1.786; portfolio PF=1.302, net=460.508, MaxDD=418.627
- OB_V2_LIFECYCLE: OB n=24, PF=0.5851438485100655, expectancy=-2.519; portfolio PF=1.346, net=567.706, MaxDD=418.627
- OB_V2_STRUCTURAL_RETEST: OB n=5, PF=0.05230455510888673, expectancy=-6.630; portfolio PF=1.101, net=136.486, MaxDD=340.841
- OB_V2_STRUCTURAL_RETEST_REWARD: OB n=0, PF=N/A, expectancy=0.000; portfolio PF=1.395, net=606.620, MaxDD=418.627
- OB_DISABLED: OB n=0, PF=N/A, expectancy=0.000; portfolio PF=1.395, net=606.620, MaxDD=418.627

Root-cause conclusion:
- Lifecycle contribution: does not repair expectancy
- Structural-definition contribution: harmful and too restrictive
- Geometry/reward contribution: zero coverage; collapses to disabled control
Selected candidate: NONE
Holdout result: too thin; no candidate passes
Portfolio impact: OB_DISABLED improves Central net from 460.508 to 606.620 with unchanged MaxDD 418.627
OB coverage impact: V2 lifecycle 24 trades; structural 5; reward 0
MaxDD impact: no qualifying candidate
Sensitivity result: directionally stable failure
Known limitations: lifecycle aggregate callback counts were not persisted in completed replay; compatible extra historical periods unavailable
Is formal implementation/merge validation authorized? NO
Is production deployment authorized? NO
Next ticket: formal OB-disabled experiment

Evidence paths (updated by TICKET-160A to current post-T160-archive locations; content byte-identical to
the original data/ticket157-*.csv files written at T157 time):
- data/archive/ticket157/ticket157-v1-parity.csv
- data/archive/ticket157/ticket157-zone-lifecycle-funnel.csv
- data/archive/ticket157/ticket157-variant-scenario-summary.csv
- data/archive/ticket157/ticket157-holdout-stability.csv
- data/archive/ticket157/ticket157-sensitivity.csv
- data/archive/ticket157/ticket157-trade-reconciliation.csv
- data/archive/ticket157/ticket157-leakage-ambiguity.csv
```
