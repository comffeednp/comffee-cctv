<#
.SYNOPSIS
  Removes the Comffee CCTV bridge from Windows: the startup task, the program and its config.

.EXAMPLE
  .\uninstall-windows.ps1
  .\uninstall-windows.ps1 -KeepConfig
#>
[CmdletBinding()]
param(
  [switch]$KeepConfig
)

$ErrorActionPreference = 'Stop'
$TaskName = 'Comffee CCTV Bridge'
$InstallDir = Join-Path $env:ProgramFiles 'Comffee CCTV Bridge'
$ConfigDir = Join-Path $env:ProgramData 'Comffee CCTV Bridge'
$InstalledExe = Join-Path $InstallDir 'comffee-cctv-bridge.exe'

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Run this script from PowerShell opened with "Run as administrator".'
}

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}
Get-Process -Name 'comffee-cctv-bridge' -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -eq $InstalledExe } |
  Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1

if (Test-Path -LiteralPath $InstallDir) { Remove-Item -LiteralPath $InstallDir -Recurse -Force }
if (-not $KeepConfig -and (Test-Path -LiteralPath $ConfigDir)) { Remove-Item -LiteralPath $ConfigDir -Recurse -Force }

Write-Host 'Comffee CCTV bridge removed.'
if ($KeepConfig) { Write-Host "Config kept in $ConfigDir" }
Write-Host 'You can also delete the bridge token: make a new one on the location page, which cuts off the old one.'
