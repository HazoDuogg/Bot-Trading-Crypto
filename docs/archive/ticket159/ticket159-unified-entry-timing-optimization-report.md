# T159 — Unified Entry Timing Optimization

> **TICKET-160A path note:** the "Evidence paths" list below originally used the filenames as written at
> T159 time (`data/ticket159-*.{csv,md}`). TICKET-160's cleanup moved these byte-identical files to
> `data/archive/ticket159/ticket159-*.{csv,md}`; TICKET-160A updated the paths in this report to match
> (no other text in this report was changed, including the CORRECTION note above which was already
> accurate before T160's move). See `docs/active-baseline-and-artifact-index.md` /
> `docs/baseline-registry.md` for the current baseline registry.

## Decision

**KEEP_CURRENT_ENTRY**. Neither fixed challenger passes the portfolio or coverage gate. No production or VPS change is authorized.

## Central portfolio

- CURRENT_ENTRY: 264 trades, WR 41.67%, PF 1.3948, net $606.6195, expectancy $2.2978.
- OVEREXTENSION_GUARD: 97 trades, WR 38.14%, PF 0.6978, net $-87.6002, expectancy $-0.9031.
- BREAKOUT_PULLBACK_CONTINUATION: 114 trades, WR 42.11%, PF 0.7711, net $-74.4094, expectancy $-0.6527.

The guard retains only 36.7% of Central portfolio trades and two Momentum Direct trades. Pullback emits zero Momentum Direct entries and retains 43.2% of the portfolio. Both collapse below the 75% coverage floor and lose money.

**CORRECTION (independently verified against `data/archive/ticket159/ticket159-failure-classification.csv` and `data/archive/ticket159/ticket159-timing-dataset.csv` [TICKET-160A: path updated to post-T160-archive location; original path at correction time was `data/ticket159-failure-classification.csv`/`data/ticket159-timing-dataset.csv`], which the report-generation script failed to read from — it was still writing the placeholder text from the interrupted prior attempt)**: MFE/MAE/time-to-R WERE persisted (139/139 trades have `mfeR`/`maeR`/`realizedR` populated in the timing dataset) and the real classifier (`ticket159FailureClassifier.ts`) DID produce a differentiated, evidence-based classification:

- THESIS_FAILURE: 11
- LATE_OR_OVEREXTENDED: 12
- PULLBACK_SURVIVABLE: 32
- ROBUST_ENTRY: 17
- AMBIGUOUS: 67
(total 139 MOMENTUM_DIRECT trades; full breakdown by symbol/side/month/regime in `data/archive/ticket159/ticket159-failure-classification-by-group.csv`)

Focused SHORT ETH/XRP (53 MOMENTUM_DIRECT trades, Central cost): net **+$247.67**, PF **1.48**, WR 37.7% — **currently net PROFITABLE**, not the loss cluster the ticket's premise assumed. Per-symbol-side breakdown: ETHUSDT_SHORT (n=28): THESIS_FAILURE=3, LATE_OR_OVEREXTENDED=3, PULLBACK_SURVIVABLE=11, ROBUST_ENTRY=1, AMBIGUOUS=10. XRPUSDT_SHORT (n=25): THESIS_FAILURE=0, LATE_OR_OVEREXTENDED=4, PULLBACK_SURVIVABLE=4, ROBUST_ENTRY=4, AMBIGUOUS=13.

The decision to KEEP_CURRENT_ENTRY is unaffected by this correction — it rests entirely on both challengers' portfolio-level failure (both PF < 1, both net-negative, both below the 75% trade-retention floor), which is independent of the failure-classification breakdown. This correction only fixes the report's own internal inconsistency; it does not change the Central portfolio numbers above, which were already read from the real scenario runs. Declared sensitivity runs were not used to rescue primary rules after both failed the mandatory coverage and portfolio gates.

## T159 FINAL DECISION

```text
T159 FINAL DECISION
Decision: KEEP_CURRENT_ENTRY
Code/commit: working tree research-only
Input manifest/hash: 0040ec0ad76a206d141042b5d93e82b95ae62e960a358d291a38c9dae3d93535
Baseline parity: PASS
Leakage audit: PASS (corrected — see note above; classification evidence was NOT actually missing, the report-generation script was reading a stale placeholder instead of the real classifier output)
Production behavior modified: NO (required)

Central portfolio:
- CURRENT_ENTRY: PF 1.3947839228431962, net 606.6195245715165, expectancy 2.2978012294375625, trades 264
- OVEREXTENSION_GUARD: PF 0.6978358014828496, net -87.60022253430397, expectancy -0.9030950776732368, trades 97
- BREAKOUT_PULLBACK_CONTINUATION: PF 0.7711081175722452, net -74.40944061128715, expectancy -0.6527143913270803, trades 114

Failure attribution (corrected from real data/archive/ticket159/ticket159-failure-classification.csv, see note above):
- THESIS_FAILURE: 11
- LATE_OR_OVEREXTENDED: 12
- PULLBACK_SURVIVABLE: 32
- ROBUST_ENTRY: 17
- AMBIGUOUS: 67

SHORT ETH/XRP result (53 MOMENTUM_DIRECT trades, Central cost): net +$247.67, PF 1.48, WR 37.7% — currently net profitable, not a loss cluster.

Selected challenger: NONE
Known limitations: neither challenger was tuned/rescued via declared sensitivity after failing the primary-parameter gate; classification's AMBIGUOUS bucket (67/139, 48%) reflects trades where evidence genuinely does not resolve the mechanism (per the ticket's own definition), not a data-availability gap.
Is formal implementation/merge validation authorized? NO
Is VPS deployment authorized? NO
Next ticket: none required by this ticket's own gate — KEEP_CURRENT_ENTRY is a valid terminal outcome.

Evidence paths (updated by TICKET-160A to current post-T160-archive locations; content byte-identical to
the original data/ticket159-*.{md,csv} files written at T159 time):
- data/archive/ticket159/ticket159-parity-leakage-report.md
- data/archive/ticket159/ticket159-timing-dataset.csv + data/archive/ticket159/ticket159-field-dictionary.md
- data/archive/ticket159/ticket159-failure-classification.csv + data/archive/ticket159/ticket159-failure-classification-by-group.csv
- data/archive/ticket159/ticket159-challenger-funnel.csv
- data/archive/ticket159/ticket159-scenario-portfolio-comparison.csv
- data/archive/ticket159/ticket159-holdout-stability-sensitivity.md
```
