# Guarded runner for the deterministic TJL BTCUSDT scanner (tjl_btcusdt_scanner.sh).
#
# Reuses two fixes discovered and validated while building the BTC momentum
# scanner's equivalent wrapper (run_btc_scan_guarded.ps1) - both bugs would
# reproduce identically here since the mechanism (bash.exe launched from a
# detached powershell.exe -File, as Task Scheduler does) is the same:
#   1. A bare bash.exe has no /usr/bin on PATH ("dirname: command not found").
#      `bash --login` fixes PATH but sources the user's interactive profile,
#      which hung indefinitely when run unattended - confirmed directly.
#      Fix: prepend Git's bin dirs to PATH instead, no profile sourcing.
#   2. `& $BashExe ... 2>&1 | Out-String` hangs indefinitely specifically when
#      THIS wrapper is itself launched via a detached `powershell.exe -File`
#      call (i.e. exactly how Task Scheduler invokes actions) - confirmed
#      directly (worked in ~4s interactively, hung 2+ min detached). Root
#      cause: inherited stdin/console handle with nothing behind it. Fix:
#      Start-Process with explicit stdin/stdout/stderr redirection.
param(
    [int]$MinGapMinutes = 25
)

$ErrorActionPreference = "Stop"

$RepoRoot = "D:\BotTradingV2"
$StateFile = Join-Path $RepoRoot ".tjl_btcusdt_state.json"
$LogFile = Join-Path $RepoRoot "tjl_btcusdt_run_log.txt"
$BashExe = "C:\Program Files\Git\usr\bin\bash.exe"

$nowUtc = [DateTime]::UtcNow
$nowLocal = Get-Date

function Write-Log($msg) {
    $utcStamp = $nowUtc.ToString("yyyy-MM-ddTHH:mm:ssZ")
    $localStamp = $nowLocal.ToString("yyyy-MM-dd HH:mm:ss")
    Add-Content -Path $LogFile -Value "[utc=$utcStamp local=$localStamp] $msg"
}

# ---- Guard: don't run again within $MinGapMinutes of the last scan ----
# (The scan itself is idempotent and harmless to run twice, but this avoids
# StartWhenAvailable firing a near-duplicate run right after a normal tick.)
$state = $null
if (Test-Path $StateFile) {
    try { $state = Get-Content $StateFile -Raw | ConvertFrom-Json } catch { $state = $null }
}
if ($state -and $state.last_scan_at) {
    try {
        $lastScan = [DateTime]::Parse($state.last_scan_at, $null, [System.Globalization.DateTimeStyles]::RoundtripKind)
        $minutesSince = ($nowUtc - $lastScan).TotalMinutes
        if ($minutesSince -lt $MinGapMinutes) {
            Write-Log ("Skipping: last scan was {0:N1} min ago (< {1} min minimum)." -f $minutesSince, $MinGapMinutes)
            exit 0
        }
    } catch {
        Write-Log "State file unreadable/corrupt ($($_.Exception.Message)) - proceeding with scan anyway."
    }
}

Write-Log "Guard passed. Running TJL BTCUSDT scan..."

Push-Location $RepoRoot
try {
    $env:PATH = "C:\Program Files\Git\usr\bin;C:\Program Files\Git\mingw64\bin;$env:PATH"

    $stdOutFile = [System.IO.Path]::GetTempFileName()
    $stdErrFile = [System.IO.Path]::GetTempFileName()
    $stdInFile = [System.IO.Path]::GetTempFileName()
    try {
        $proc = Start-Process -FilePath $BashExe -ArgumentList "tjl_btcusdt_scanner.sh" `
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
    Write-Log "Scan succeeded (exit 0)."
} else {
    Write-Log "Scan FAILED (exit code $exitCode)."
}

exit $exitCode
