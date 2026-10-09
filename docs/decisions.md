# Decisions and open notes

This file is seeded early (during the `chore/restructure` work) with an open
diagnostic note. The full decisions log (locked parameters, rejected
approaches, phase plan) is written up in Step 8 of the restructure.

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
