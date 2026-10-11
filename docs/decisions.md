# Decisions and open notes

Project goal: a TypeScript trading-bot FRAMEWORK with a place for an AI
layer (XGBoost-style signal scoring). Pine on TradingView is only the
research lab. **Strategy is not locked yet** - everything below the
"Current forward-test parameters" section is provisional, swept and
tested but not committed to a final production spec.

## Current forward-test parameters (provisional - see config/*.json)

Running live in `legacy/scanners/tjl_forward_scanner.py`, dual-write into
`runtime/bot.db` since 2026-10-09:

| Symbol | Variant | Sides | Gate | Buffer | R:R |
|---|---|---|---|---|---|
| BTCUSDT | v2f | Long + Short | trend_structure | 0.5 | 2.25 |
| ETHUSDT | v2f | Long only | trend_structure | 0.5 | 2.25 |
| SOLUSDT | v2e | Long only | none (ungated) | 0.5 | 2.25 |

Risk (provisional, see `config/risk.json`): 1% risk/trade; 15% margin cap
**as margin, not notional** (margin_used = notional/leverage; allowed
notional = margin_cap% * equity * leverage); leverage 20x BTC/ETH, 10x
SOL; circuit breaker = halve position size after 3 consecutive losses on
a symbol, reset on that symbol's next win (per-symbol, not cross-symbol).

Fees (provisional, see `config/fees.json`): 0.075%/fill (0.15% round
trip). Fill model (signal-bar close vs next-bar open) is **undecided** -
the current scanner assumes same-bar-close fills, which is optimistic
vs real execution.

## Rejected approaches

- **v3 (Trend+Zone+Reaction, Daily-chart methodology)** - fundamentally
  different from the breakout+gate family; not adopted. Archived at
  `research/pine/archive/tjl_btcusdt_v3_trendzone.pine`.
- **SMC (Smart Money Concepts)** - tried twice: once as a from-scratch
  Pine rebuild (`research/pine/archive/tjl_btcusdt_smc_v1.pine` /
  `smc_v2.pine` - Phase 1 showed promising Long PF but all 6 Short
  trades lost), and once as a full prior TypeScript implementation
  (the pre-existing `src/{regime,direction,entry,exit,...}` code - see
  the "existing src/ codebase" note below). Neither was adopted; the
  project continued with the breakout+gate (v1/v2/v2c/v2e/v2f) lineage
  instead.
- **Cross-symbol correlation cap** - capping total simultaneous same-
  direction risk across BTC/ETH/SOL. Tested via backtest simulation:
  reduced max drawdown but cost proportionally MORE return than the
  drawdown it saved (worse Return/MaxDD than flat sizing), and didn't
  target the actual dominant risk (SOL's own sequential-loss streaks,
  not cross-symbol correlation). Not adopted - see the per-symbol
  circuit breaker below instead.
- **XRP** - tested via a Python-replica backtest that turned out
  wrong/misleading once checked against reality. This is the specific
  incident behind the "real Pine Strategy Tester, not a Python proxy,
  for anything load-bearing" rule applied for the rest of the project
  (e.g. the SOL Short real-Pine sweep below).
- **SOL Short** - properly tested (unlike ETH Short, below) via a real
  Pine Strategy Tester buffer/RR sweep (11 parameter combinations, SMA200
  gate, same discipline as BTC's original sweep). Every combination was
  net-negative, PF never exceeded 0.79 - structurally weak, not merely
  untested. Rejected.
- **ETH Short** - tested earlier in the project and failed explicitly
  (referenced throughout the session as the known-bad baseline SOL
  Short was compared against).

## Key lessons

1. **Python replicas of Pine strategies can diverge from real Pine** -
   the XRP incident is the cautionary example. Validate via the real
   TradingView Strategy Tester wherever the platform's history depth
   allows it; label Python-replica results clearly as such when it
   doesn't (see `tools/backtest_tjl_v2_binance.py`'s header note).
2. **TradingView's Basic plan has a hard intraday-history wall** (~5-6
   weeks back from "now", confirmed via SOLUSDT's earliest-loadable 15m
   bar), independent of symbol. This blocks real-Pine backtesting of
   older windows (e.g. the Apr-Jul crash-coverage window) - Python
   replica is the only option there, clearly labeled.
3. **BTC/ETH/SOL are highly correlated** (0.75-0.87 Daily/15m return
   correlation, measured directly). The 3-symbol portfolio is closer to
   one BTC-trend bet expressed in three tickers than three independent
   edges - ETH's Long "edge" is almost pure beta (flips to a net loser
   on days BTC isn't pumping, n=10); SOL's is beta-dominated but retains
   a thin independent slice.
4. **Fees change the picture at this trade frequency/size.** Every one
   of the 6 live configs' samples (as of the Oct 9 review) flipped from
   net-positive to net-negative once 0.075%/fill fees were applied -
   invisible in the original unfee'd design, only surfaced when checked
   explicitly. `tools/status.py` now always reports net-of-fees figures.
5. **Live-vs-backtest gap, still open** - BTC v2/v2c/v2e's Long-side win
   rate ran ~21-23% live vs ~47-52% in the Jul1-Sep20 backtest, at
   genuinely comparable sample sizes (13-15 trades each side, not a
   small-sample fluke by itself). Not resolved - see "Open items" below.
6. **A per-symbol circuit breaker (halve size after 3 consecutive
   losses) beat both flat sizing and the cross-symbol correlation cap**
   on two different historical windows (Jul1-Sep20 and Apr1-Jul15 2026),
   each with a different streak pattern. Directionally validated, but
   not scientifically settled (N=3 vs 4 vs 5 tested on only two
   overlapping-period windows - see `config/risk.json`'s
   `circuit_breaker` note).
7. **Windows Task Scheduler + PowerShell window flashing** needed a VBS
   launcher (`WshShell.Run` with window style 0), not just
   `-WindowStyle Hidden` on `powershell.exe` directly - the latter can
   still flash briefly on some builds.
8. **Transient non-zero `LastTaskResult` codes are not always real
   failures** - two were observed during this restructure
   (`0x80070520`, `SCHED_S_TASK_RUNNING`/267009), both resolving to 0
   moments later with the task's own run log confirming no actual
   failure. Always cross-check the scanner's own log before concluding
   a real fault - see the dated note below for the full detail.

## Open items

- **Pine-vs-scanner comparison**: the live Python scanner's logic is
  modeled on the Pine strategies but has never been directly cross-
  validated against a live-running Pine strategy on TradingView, side
  by side, for the same config over the same real-time period. Worth
  doing before trusting the scanner's forward-test numbers as a proxy
  for "what Pine would have done."
- **Fee/fill model**: fee rate is set, but the fill-timing model
  (same-bar close, the scanner's current assumption, vs next-bar open,
  more realistic) is explicitly undecided - see `config/fees.json`.
  This affects every backtest and live number computed so far, all of
  which assume the optimistic same-bar-close fill.
- **Backtest-vs-live gap**: BTC v2/v2c/v2e's Long-side live performance
  gap (point 5 above) isn't explained yet - regime change (Jul1-Sep20
  being a cleaner uptrend than the current Sep22-Oct window) is the
  natural guess but hasn't been verified against actual price action.
- **Existing `src/` codebase**: `src/{core,config,direction,entry,
  exchange,exit,indicators,notify,regime,risk,analysis}` plus `tests/`
  and `scripts/research/` (and `data/`, ~88MB of cached OHLCV/backtest
  results) are a complete prior SMC-based TypeScript implementation,
  last touched 2026-09-17 - effectively the "separate blind VS Code/
  TypeScript backtester" that `research/pine/archive/tjl_btcusdt_smc_v1.pine`'s
  own header refers to being replaced by Pine-based research. Proposed
  (not yet executed - awaiting approval) to relocate this whole prior
  attempt into `research/` as TS-based research history, parallel to
  `research/pine/`, keeping `src/`'s new interfaces-only skeleton
  (`src/pipeline.ts`, `src/strategy/`, `src/execution/`, `src/ai/`,
  `src/configSchema.ts`) uncontaminated by the old implementation.

## Open notes

### 2026-10-09: transient `0x80070520` on TjlForwardScanner, cause undetermined

While polling `Get-ScheduledTaskInfo` during the restructure's G1
verification wait, one intermediate read showed
`LastTaskResult: 2147946720` (`0x80070520`, `ERROR_NO_SUCH_LOGON_SESSION`)
for the `TjlForwardScanner` task. A fresh read moments later showed
`LastTaskResult: 0`, and the scanner's own run log independently confirmed
a clean `Scan succeeded (exit 0)` entry at the exact tick in question
(2026-10-09T05:41:00Z), with `.tjl_forward_scanner_run.json`'s
`last_run_utc` advanced accordingly - behavioral evidence inconsistent with
a real logon-session failure, since that would have prevented the script
from running at all.

The `Microsoft-Windows-TaskScheduler/Operational` event log was **disabled**
on this machine at the time, so no event IDs could be retrieved to confirm
either way. The log has since been enabled
(`wevtutil sl Microsoft-Windows-TaskScheduler/Operational /e:true`, run by
the user with elevated rights). Every subsequent tick through both the
dry-run and the first real tick on the new Action path succeeded cleanly.

**Status: treated as transient, cause undetermined.** If this recurs now
that the Operational log is active, capture the actual event IDs/messages
from that log before concluding it's benign again.

**Update (same day, during G2 verification)**: caught a second, different
transient non-zero code on the same task - `LastTaskResult: 267009`
(`0x41301` = `SCHED_S_TASK_RUNNING`), read 3 seconds after `LastRunTime`
while the task was still actively executing. This is a documented
Windows-informational code (not an error), and corroborates the general
pattern: `Get-ScheduledTaskInfo` can surface transient in-flight status
codes that resolve to `0` moments later once the task actually finishes -
independent of whatever caused the original `0x80070520` reading. The
Operational log was still disabled at this point (the elevated
`wevtutil sl` command from the earlier note had not yet been run/had not
persisted) - revisit if it recurs once that log is confirmed active.

### 2026-10-11: real ~2h gap diagnosed as a full reboot, not a task fault

A genuine gap (missing `tjl_forward_scanner_run_log.txt` entries for the
12:10:59 PM and 12:40:59 PM ticks, plus a third `0x80070520` reading at
11:55:57 AM that - unlike the earlier two transient reads - had no
corresponding successful run anywhere) was diagnosed using the System
event log (`Microsoft-Windows-Kernel-Power`, `Winlogon`):

- 12:04:08 PM: Winlogon User Logoff Notification
- 12:04:14 PM: Kernel-Power - shutdown transition initiated, **Reason:
  Kernel API** (i.e. programmatically triggered, not a manual shutdown -
  most likely a pending Windows Update restart)
- 12:04:15 PM: "system has prepared for a system-initiated reboot from Active"
- (machine fully off/rebooting)
- 1:11:56 PM-1:12:03 PM: early boot hardware enumeration (ACPI thermal
  zone, battery count)
- 1:12:19 PM: Winlogon User Logon Notification (back in)
- 1:40:59 PM: next scheduled tick fired cleanly, `exit_code=0`, matching
  the task's normal 30-min cadence, ~28 minutes after logon

**Conclusion: this was a full system reboot (~68 minutes, 12:04-1:12 PM),
not a task or code fault.** The 11:55:57 AM `0x80070520` reading coincides
with the session teardown that begins the logoff/shutdown sequence -
consistent with the error's literal meaning ("logon session does not
exist, may already have been terminated"). The task's `Principal`/
`LogonType` were independently confirmed unchanged by the G2 move (raw
XML diff: the only difference anywhere in the task definition, pre- vs
post-G2, is the `Arguments` path) - this gap predates and is unrelated to
any restructure work.

**Fix applied same day**: `StartWhenAvailable` changed `false -> true`
via `Set-ScheduledTask -Settings` (XML diff confirmed exactly one line
added, `Principal`/`LogonType`/everything else unchanged - no account
switch, no password stored). This lets Task Scheduler attempt a missed
trigger once the machine becomes available again, shrinking (not
eliminating) a future reboot's gap - it cannot make anything run while
the machine is fully off, and `LogonType=Interactive` still requires the
user's session to exist again.

**Structural constraint this surfaces**: this is a personal machine that
sleeps nightly and occasionally reboots (e.g. for Windows Update) - it
cannot host the live trading phase. **The live phase needs a VPS or
another always-on machine**, and because no machine can guarantee 100%
uptime, **SL/TP must be placed as reduce-only orders on the exchange
itself**, not simulated/managed only by the bot's own process - an
exchange-side stop/TP survives the bot (or its host) being briefly
unreachable; a bot-managed-only stop does not.
