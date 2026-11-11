<#
.SYNOPSIS
  Installs the Comffee CCTV bridge on Windows as a startup task that runs as LOCAL SERVICE.

.DESCRIPTION
  Copies the bridge program to Program Files, writes its config (hub address and token) to
  ProgramData with access for administrators, SYSTEM and LOCAL SERVICE only, and registers a
  scheduled task that starts at boot, runs as LOCAL SERVICE and restarts after a failure.
  Run from an elevated PowerShell. Running it again updates the program and the config.

.EXAMPLE
  .\install-windows.ps1 -Hub wss://cctv.example.com/bridge
  (asks for the token so it does not stay in the command history)

.NOTES
  The program comffee-cctv-bridge.exe is taken from next to this script, or from the dist folder
  that "node bridge/build.mjs" writes it to, unless -Exe names another file.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Hub,
  [string]$Token,
  [string]$Name = $env:COMPUTERNAME,
  [string]$Exe
)

$ErrorActionPreference = 'Stop'
$TaskName = 'Comffee CCTV Bridge'
$InstallDir = Join-Path $env:ProgramFiles 'Comffee CCTV Bridge'
$ConfigDir = Join-Path $env:ProgramData 'Comffee CCTV Bridge'
$InstalledExe = Join-Path $InstallDir 'comffee-cctv-bridge.exe'
$ConfigPath = Join-Path $ConfigDir 'bridge.json'

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Run this script from PowerShell opened with "Run as administrator".'
}
if (-not $Exe) {
  $candidates = @(
    (Join-Path $PSScriptRoot 'comffee-cctv-bridge.exe'),
    (Join-Path (Join-Path $PSScriptRoot 'dist') 'comffee-cctv-bridge.exe')
  )
  $Exe = $candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
  if (-not $Exe) { $Exe = $candidates[0] }
}
if (-not (Test-Path -LiteralPath $Exe -PathType Leaf)) {
  throw "Bridge program not found at $Exe. Put comffee-cctv-bridge.exe next to this script or pass -Exe."
}
if ($Hub -notmatch '^(wss|https)://[A-Za-z0-9.-]+(:\d{1,5})?(/[A-Za-z0-9._~/-]*)?$') {
  throw 'The hub address must look like wss://cctv.example.com/bridge'
}
if (-not $Token) {
  $secure = Read-Host -AsSecureString 'Bridge token (from the location page)'
  $Token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
}
if ($Token -notmatch '^[A-Za-z0-9_-]{43}$') {
  throw 'The bridge token does not look right. Copy it again from the location page.'
}
$Name = ($Name -replace '[\x00-\x1f\x7f]', '').Trim()
if ($Name.Length -gt 64) { $Name = $Name.Substring(0, 64) }

# Well-known SIDs, so this works on any Windows language.
$sidSystem = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
$sidAdmins = New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')
$sidLocalService = New-Object Security.Principal.SecurityIdentifier('S-1-5-19')
$localServiceName = $sidLocalService.Translate([Security.Principal.NTAccount]).Value

# Stop a running copy before replacing the program.
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
}
Get-Process -Name 'comffee-cctv-bridge' -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -eq $InstalledExe } |
  Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item -LiteralPath $Exe -Destination $InstalledExe -Force

function Protect-Path([string]$Path, [bool]$IsDirectory) {
  $acl = if ($IsDirectory) { New-Object Security.AccessControl.DirectorySecurity } else { New-Object Security.AccessControl.FileSecurity }
  $acl.SetAccessRuleProtection($true, $false)
  $inherit = if ($IsDirectory) { [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit' } else { [Security.AccessControl.InheritanceFlags]::None }
  $none = [Security.AccessControl.PropagationFlags]::None
  $allow = [Security.AccessControl.AccessControlType]::Allow
  foreach ($sid in @($sidSystem, $sidAdmins)) {
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', $inherit, $none, $allow)))
  }
  $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sidLocalService, 'ReadAndExecute', $inherit, $none, $allow)))
  Set-Acl -LiteralPath $Path -AclObject $acl
}

New-Item -ItemType Directory -Force -Path $ConfigDir | Out-Null
Protect-Path -Path $ConfigDir -IsDirectory $true
$config = [ordered]@{ hub = $Hub; token = $Token; name = $Name } | ConvertTo-Json
[IO.File]::WriteAllText($ConfigPath, $config, (New-Object Text.UTF8Encoding($false)))
Protect-Path -Path $ConfigPath -IsDirectory $false

$action = New-ScheduledTaskAction -Execute $InstalledExe -Argument "--config `"$ConfigPath`""
$trigger = New-ScheduledTaskTrigger -AtStartup
$taskPrincipal = New-ScheduledTaskPrincipal -UserId $localServiceName -LogonType ServiceAccount -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $taskPrincipal `
  -Settings $settings -Description 'Relays camera connections to the Comffee CCTV hub.' -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName

Write-Host "Comffee CCTV bridge installed and started."
Write-Host "  Program: $InstalledExe"
Write-Host "  Config:  $ConfigPath"
Write-Host "It starts with Windows and restarts by itself after a failure. Check the location page: it should show the bridge as connected."
