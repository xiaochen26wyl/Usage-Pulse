# Install smoke test for the Windows NSIS installer.
#
# Silent install -> files and Start Menu shortcut exist (and carry the app's
# AppUserModelID, which Windows toast notifications need) -> the installed app
# runs, has run its update check, and a second launch hands over instead of
# starting another copy -> silent uninstall leaves nothing behind.
param(
  [Parameter(Mandatory = $true)][string]$Installer,
  [string]$Identifier = 'com.xiaochen26wyl.usagepulse',
  [string]$ProductName = 'Usage-Pulse'
)

$ErrorActionPreference = 'Stop'
$work = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { $env:TEMP }
$stdoutLog = Join-Path $work 'usage-pulse-stdout.log'
$stderrLog = Join-Path $work 'usage-pulse-stderr.log'

function Fail($message) { throw "install smoke: $message" }

# 1. Install (per user, silent)
$install = Start-Process -FilePath $Installer -ArgumentList '/S' -Wait -PassThru
if ($install.ExitCode -ne 0) { Fail "installer exited with $($install.ExitCode)" }

$dir = Join-Path $env:LOCALAPPDATA $ProductName
if (-not (Test-Path $dir)) { Fail "install directory $dir was not created" }
$exe = Get-ChildItem -Path $dir -Filter '*.exe' -Recurse |
  Where-Object { $_.Name -notmatch 'uninstall' } | Select-Object -First 1
if (-not $exe) { Fail "no application exe under $dir" }
$uninstaller = Join-Path $dir 'uninstall.exe'
if (-not (Test-Path $uninstaller)) { Fail 'uninstall.exe is missing' }
Write-Output "installed: $($exe.FullName)"

# 2. Start Menu shortcut with the right AppUserModelID
$startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
$lnk = Get-ChildItem -Path $startMenu -Filter '*.lnk' -Recurse |
  Where-Object { $_.BaseName -like "*$ProductName*" } | Select-Object -First 1
if (-not $lnk) { Fail 'no Start Menu shortcut' }
$shell = New-Object -ComObject Shell.Application
$item = $shell.NameSpace($lnk.DirectoryName).ParseName($lnk.Name)
$aumid = $item.ExtendedProperty('System.AppUserModel.ID')
if ($aumid -ne $Identifier) { Fail "shortcut AppUserModelID is '$aumid', expected '$Identifier'" }
Write-Output "shortcut: $($lnk.FullName) (AUMID $aumid)"

# 3. First launch: stays alive and runs its update check
$first = Start-Process -FilePath $exe.FullName -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog -PassThru
Start-Sleep -Seconds 25
if ($first.HasExited) { Fail "app exited early with code $($first.ExitCode)" }
$out = if (Test-Path $stdoutLog) { [string](Get-Content $stdoutLog -Raw) } else { '' }
$err = if (Test-Path $stderrLog) { [string](Get-Content $stderrLog -Raw) } else { '' }
Write-Output "----- app stdout -----"
Write-Output $out
Write-Output "----- app stderr -----"
Write-Output $err
Write-Output "----------------------"
$combined = "$out`n$err"
if ([string]::IsNullOrWhiteSpace($combined)) { Fail 'the app wrote nothing, so the update check cannot be confirmed' }
if (-not $combined.Contains('updater: startup check')) { Fail 'the startup update check never ran' }

# 4. Second launch: single instance
$second = Start-Process -FilePath $exe.FullName -PassThru
Start-Sleep -Seconds 8
$running = @(Get-Process -Name ([IO.Path]::GetFileNameWithoutExtension($exe.Name)) -ErrorAction SilentlyContinue)
if ($running.Count -ne 1) { Fail "expected 1 running instance, found $($running.Count)" }
if (-not $second.HasExited) { Fail 'the second launch did not hand over and exit' }
Stop-Process -Id $first.Id -Force
Start-Sleep -Seconds 2

# 5. Uninstall (the NSIS uninstaller re-launches itself from %TEMP%, so poll)
Start-Process -FilePath $uninstaller -ArgumentList '/S' -Wait | Out-Null
for ($i = 0; $i -lt 30 -and (Test-Path $exe.FullName); $i++) { Start-Sleep -Seconds 1 }
if (Test-Path $exe.FullName) { Fail 'the exe is still there after uninstall' }
if (Test-Path $lnk.FullName) { Fail 'the Start Menu shortcut is still there after uninstall' }
Write-Output 'OK: install, launch, single instance and uninstall all behaved'
