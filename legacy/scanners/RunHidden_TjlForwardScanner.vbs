' Hidden launcher for the consolidated TJL forward scanner.
'
' Root cause of the visible-window issue: none of the scanner scheduled
' tasks' Actions passed -WindowStyle Hidden to powershell.exe, and Task
' Scheduler's "Hidden" checkbox (Settings.Hidden) only hides the TASK from
' the Task Scheduler UI listing - it does NOT suppress the console window
' a program creates when it actually runs. Confirmed by inspecting every
' currently-registered scanner task (Get-ScheduledTask ... .Settings.Hidden
' was False on all of them, and none had -WindowStyle Hidden in Arguments).
'
' wscript.exe is a GUI-subsystem executable (no console of its own), and
' WshShell.Run's window-style parameter (0 = hidden) actually suppresses
' the CHILD process's window too - unlike "powershell.exe -WindowStyle
' Hidden" alone, which some Windows builds still briefly flash before the
' style applies. Routing the scheduled task's Action through this VBS
' wrapper is the standard, reliable fix for Task Scheduler + PowerShell
' window flashes.
'
' Moved into legacy/scanners/ during the chore/restructure (2026-10-09) -
' path below updated to match; the scheduled task's own Action argument
' pointing AT this .vbs file was updated separately.
Dim objShell, exitCode
Set objShell = CreateObject("WScript.Shell")
exitCode = objShell.Run("powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""D:\BotTradingV2\legacy\scanners\run_tjl_forward_scanner_guarded.ps1""", 0, True)
WScript.Quit(exitCode)
