# Guarded runner for the BTCUSDT momentum scanner (btc_momentum_scanner.sh).
#
# BTC trades 24/7, so unlike the (now-removed) stock pre-market scanner this
# has no weekday/market-hours gating - it fires every 30 minutes around the
# clock. The only guard is a minimum-gap check: if the last successful scan
# was less than $MinGapMinutes ago, skip. This is what makes
# StartWhenAvailable safe to combine with a 30-minute repeating trigger -
# without it, a laptop that just woke up could fire a catch-up run seconds
# after a normal tick already ran, producing near-duplicate scans.
param(
    [int]$MinGapMinutes = 25
)

$ErrorActionPreference = "Stop"

$RepoRoot = "D:\BotTradingV2"
$StateFile = Join-Path $RepoRoot ".btc_scan_state.json"
$LogFile = Join-Path $RepoRoot "btc_scan_run_log.txt"
$BashExe = "C:\Program Files\Git\usr\bin\bash.exe"

$nowUtc = [DateTime]::UtcNow
$nowLocal = Get-Date

function Write-Log($msg) {
    $utcStamp = $nowUtc.ToString("yyyy-MM-ddTHH:mm:ssZ")
    $localStamp = $nowLocal.ToString("yyyy-MM-dd HH:mm:ss")
    Add-Content -Path $LogFile -Value "[utc=$utcStamp local=$localStamp] $msg"
}

# ---- Guard: don't run again within $MinGapMinutes of the last success ----
$state = $null
if (Test-Path $StateFile) {
    try { $state = Get-Content $StateFile -Raw | ConvertFrom-Json } catch { $state = $null }
}
if ($state -and $state.last_success_utc) {
    try {
        $lastSuccess = [DateTime]::Parse($state.last_success_utc, $null, [System.Globalization.DateTimeStyles]::RoundtripKind)
        $minutesSince = ($nowUtc - $lastSuccess).TotalMinutes
        if ($minutesSince -lt $MinGapMinutes) {
            Write-Log ("Skipping: last successful scan was {0:N1} min ago (< {1} min minimum)." -f $minutesSince, $MinGapMinutes)
            exit 0
        }
    } catch {
        Write-Log "State file unreadable/corrupt ($($_.Exception.Message)) - proceeding with scan anyway."
    }
}

# ---- Run the scan ----
Write-Log "Guard passed. Running BTC scan..."

Push-Location $RepoRoot
try {
    # A bare bash.exe invocation from PowerShell does NOT have /usr/bin on
    # PATH (dirname, mktemp, etc. all live there), so the scanner script fails
    # immediately with "dirname: command not found". `bash --login` fixes the
    # PATH by sourcing the user's interactive profile scripts - but that's
    # exactly the problem: those scripts are meant for a human's interactive
    # session and one of them hung indefinitely when run unattended here
    # (confirmed directly - a --login test run sat for 3+ minutes before being
    # killed, vs. ~4s normally). Fatal for a 24/7 unattended task, since a
    # hung run blocks every subsequent tick (MultipleInstances=IgnoreNew).
    # Prepending Git's own bin dirs to PATH gets the same practical fix
    # (bash resolves dirname etc.) without sourcing any profile script.
    $env:PATH = "C:\Program Files\Git\usr\bin;C:\Program Files\Git\mingw64\bin;$env:PATH"

    # `& $BashExe ... 2>&1 | Out-String` works fine interactively but hangs
    # indefinitely when this script itself is launched via a detached
    # `powershell.exe -File` call - confirmed directly: identical code, same
    # machine, hangs for minutes under a nested/detached launch but completes
    # in ~4s run interactively. Task Scheduler launches actions exactly this
    # way (detached, no console), so this would have hung on every real
    # scheduled run. Root cause is almost certainly bash/curl blocking on an
    # inherited stdin handle with no console behind it. Start-Process with
    # explicit stream redirection (including stdin, from an empty file)
    # sidesteps the inherited-handle problem entirely.
    $stdOutFile = [System.IO.Path]::GetTempFileName()
    $stdErrFile = [System.IO.Path]::GetTempFileName()
    $stdInFile = [System.IO.Path]::GetTempFileName()  # empty file - just needs to not be a live console handle
    try {
        $proc = Start-Process -FilePath $BashExe -ArgumentList "btc_momentum_scanner.sh" `
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
    $newState = @{
        last_success_utc = $nowUtc.ToString("yyyy-MM-ddTHH:mm:ssZ")
    }
    $newState | ConvertTo-Json | Set-Content -Path $StateFile
    Write-Log "Scan succeeded. State file updated."
} else {
    Write-Log "Scan FAILED (exit code $exitCode). State file NOT updated - eligible for retry on the next tick."
}

exit $exitCode
