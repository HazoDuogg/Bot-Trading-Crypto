# Guarded runner for the Short-side baseline-vs-buffered comparison scanner
# (tjl_btcusdt_short_compare_scanner.sh). Same detached-launch fixes as
# run_tjl_scan_guarded.ps1 / run_btc_scan_guarded.ps1 (PATH for bash's
# /usr/bin tools, explicit stdio redirection to avoid the inherited-stdin
# hang under Task Scheduler's detached launch) - both confirmed to reproduce
# identically here since the launch mechanism is the same.
#
# Uses its own dedicated run-guard state file (.tjl_btcusdt_short_compare_run.json)
# rather than either variant's own state file, since those track should_notify
# business state (baseline/buffered PASS transitions) separately per variant -
# conflating them with the run-gate would be confusing to read later.
param(
    [int]$MinGapMinutes = 25
)

$ErrorActionPreference = "Stop"

$RepoRoot = "D:\BotTradingV2"
$RunGateFile = Join-Path $RepoRoot ".tjl_btcusdt_short_compare_run.json"
$LogFile = Join-Path $RepoRoot "tjl_btcusdt_short_compare_run_log.txt"
$BashExe = "C:\Program Files\Git\usr\bin\bash.exe"

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

Write-Log "Guard passed. Running TJL BTCUSDT Short compare scan..."

Push-Location $RepoRoot
try {
    $env:PATH = "C:\Program Files\Git\usr\bin;C:\Program Files\Git\mingw64\bin;$env:PATH"

    $stdOutFile = [System.IO.Path]::GetTempFileName()
    $stdErrFile = [System.IO.Path]::GetTempFileName()
    $stdInFile = [System.IO.Path]::GetTempFileName()
    try {
        $proc = Start-Process -FilePath $BashExe -ArgumentList "tjl_btcusdt_short_compare_scanner.sh" `
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
