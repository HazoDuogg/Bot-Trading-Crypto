# Guarded runner for the consolidated forward scanner (tjl_forward_scanner.py),
# which covers BTCUSDT (4 variants), ETHUSDT (v2f Long), and SOLUSDT (v2e
# Long) in one process per tick - replaces the separate
# run_tjl_three_variant_guarded.ps1 and run_tjl_solusdt_scanner_guarded.ps1
# wrappers/tasks. Pure Python (urllib), no bash/curl involved.
#
# -WindowStyle Hidden is passed on this script's OWN invocation by the
# scheduled task (see the task's Action), not here - this wrapper just
# keeps the Start-Process + explicit stdio redirection pattern as cheap
# insurance against detached-launch hangs under Task Scheduler.
#
# Moved into legacy/scanners/ during the chore/restructure (2026-10-09).
# RunGateFile/LogFile and the Python script's own data files all stay at
# the repo root ($RepoRoot, unchanged below) - only this wrapper's and
# the Python script's own CODE location moved. See paths_config.py.
param(
    [int]$MinGapMinutes = 25
)

$ErrorActionPreference = "Stop"

$RepoRoot = "D:\BotTradingV2"
$RunGateFile = Join-Path $RepoRoot ".tjl_forward_scanner_run.json"
$LogFile = Join-Path $RepoRoot "tjl_forward_scanner_run_log.txt"
$PythonExe = "python"

$nowUtc = [DateTime]::UtcNow
$nowLocal = Get-Date

function Write-Log($msg) {
    $utcStamp = $nowUtc.ToString("yyyy-MM-ddTHH:mm:ssZ")
    $localStamp = $nowLocal.ToString("yyyy-MM-dd HH:mm:ss")
    Add-Content -Path $LogFile -Value "[utc=$utcStamp local=$localStamp] $msg"
}

# ---- Guard: don't run again within $MinGapMinutes of the last run ----
$gate = $null
if (Test-Path $RunGateFile) {
    try { $gate = Get-Content $RunGateFile -Raw | ConvertFrom-Json } catch { $gate = $null }
}
if ($gate -and $gate.last_run_utc) {
    try {
        $lastRun = [DateTime]::Parse($gate.last_run_utc, $null, [System.Globalization.DateTimeStyles]::RoundtripKind)
        $minutesSince = ($nowUtc - $lastRun).TotalMinutes
        if ($minutesSince -lt $MinGapMinutes) {
            Write-Log ("Skipping: last run was {0:N1} min ago (< {1} min minimum)." -f $minutesSince, $MinGapMinutes)
            exit 0
        }
    } catch {
        Write-Log "Run-gate file unreadable/corrupt ($($_.Exception.Message)) - proceeding with scan anyway."
    }
}

Write-Log "Guard passed. Running consolidated TJL forward scan (BTCUSDT/ETHUSDT/SOLUSDT)..."

Push-Location $RepoRoot
try {
    $stdOutFile = [System.IO.Path]::GetTempFileName()
    $stdErrFile = [System.IO.Path]::GetTempFileName()
    $stdInFile = [System.IO.Path]::GetTempFileName()
    try {
        $proc = Start-Process -FilePath $PythonExe -ArgumentList "legacy\scanners\tjl_forward_scanner.py" `
            -WorkingDirectory $RepoRoot -NoNewWindow -Wait -PassThru `
            -RedirectStandardOutput $stdOutFile -RedirectStandardError $stdErrFile -RedirectStandardInput $stdInFile
        $exitCode = $proc.ExitCode
        $output = (Get-Content $stdOutFile -Raw -ErrorAction SilentlyContinue) + "`n" + (Get-Content $stdErrFile -Raw -ErrorAction SilentlyContinue)
    } finally {
        Remove-Item $stdOutFile, $stdErrFile, $stdInFile -ErrorAction SilentlyContinue
    }
    [System.IO.File]::AppendAllText($LogFile, $output, [System.Text.Encoding]::UTF8)
} finally {
    Pop-Location
}

if ($exitCode -eq 0) {
    $newGate = @{
        last_run_utc = $nowUtc.ToString("yyyy-MM-ddTHH:mm:ssZ")
    }
    $newGate | ConvertTo-Json | Set-Content -Path $RunGateFile
    Write-Log "Scan succeeded (exit 0). Run-gate updated."
} else {
    Write-Log "Scan FAILED (exit code $exitCode). Run-gate NOT updated - eligible for retry on the next tick."
}

exit $exitCode
