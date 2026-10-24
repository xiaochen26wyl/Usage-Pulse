# Launch smoke test for a Windows build of Usage-Pulse.
#
# Starts the exe, lets it run, then checks that it is still alive and that it
# started a WebView2 process (a window was created and the front end loaded).
# A crash in setup (tray, plugins, window creation) shows up here as an early exit.
param(
  [Parameter(Mandatory = $true)][string]$Exe,
  [int]$Seconds = 20
)

$ErrorActionPreference = 'Stop'

$proc = Start-Process -FilePath $Exe -PassThru
Start-Sleep -Seconds $Seconds

if ($proc.HasExited) {
  throw "Usage-Pulse exited early with code $($proc.ExitCode)"
}

$web = @(Get-CimInstance Win32_Process -Filter "Name = 'msedgewebview2.exe'" |
  Where-Object { $_.ParentProcessId -eq $proc.Id })
if ($web.Count -eq 0) {
  Stop-Process -Id $proc.Id -Force
  throw 'The app did not start a WebView2 process'
}

Write-Output "OK: still running after $Seconds s with $($web.Count) WebView2 process(es)"
Stop-Process -Id $proc.Id -Force
