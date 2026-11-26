#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Installs the Discord -> Telegram watcher as a Windows Scheduled Task that starts at boot.

.DESCRIPTION
  Run from the repo folder in an elevated PowerShell:
    powershell -ExecutionPolicy Bypass -File .\install.ps1
  Safe to re-run: it keeps your config.env and state.json, updates watcher.js and re-registers the task.

.PARAMETER InstallDir
  Where the watcher is installed. Default C:\discord-watcher

.PARAMETER TaskName
  Scheduled Task name. Default DiscordWatcher
#>
[CmdletBinding()]
param(
    [string]$InstallDir = 'C:\discord-watcher',
    [string]$TaskName   = 'DiscordWatcher'
)

$ErrorActionPreference = 'Stop'
$Src = $PSScriptRoot

# ---------- 1. Preconditions ----------
if (-not (Test-Path (Join-Path $Src 'watcher.js'))) {
    throw "watcher.js not found next to install.ps1 ($Src). Run this script from the repo folder."
}

function Find-Node {
    $cmd = Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cmd) { return $cmd.Source }
    foreach ($p in @("$env:ProgramFiles\nodejs\node.exe", "${env:ProgramFiles(x86)}\nodejs\node.exe", "$env:LOCALAPPDATA\Programs\nodejs\node.exe")) {
        if (Test-Path $p) { return $p }
    }
    return $null
}

$node = Find-Node
if (-not $node) {
    throw 'node.exe not found. Install Node.js (LTS) from nodejs.org, then reopen PowerShell and rerun.'
}
$major = [int](& $node -p "process.versions.node.split('.')[0]")
if ($major -lt 14) { throw "Node $major is too old. Need Node 14 or newer." }
Write-Host "Using Node $major at: $node"

# Machine-wide Node -> run as SYSTEM. Per-user Node -> run as the current user (no password stored).
$RunAsSystem = $node -like "$env:ProgramFiles*"

# ---------- 2. Copy files ----------
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$srcFull = (Resolve-Path $Src).Path.TrimEnd('\')
$dstFull = (Resolve-Path $InstallDir).Path.TrimEnd('\')
if ($srcFull -ine $dstFull) {
    Copy-Item (Join-Path $Src 'watcher.js') (Join-Path $InstallDir 'watcher.js') -Force
}

& $node --check (Join-Path $InstallDir 'watcher.js')
if ($LASTEXITCODE -ne 0) { throw 'watcher.js has a syntax error. Re-download the repo and try again.' }

# ---------- 3. Config ----------
$cfgPath = Join-Path $InstallDir 'config.env'
if (-not (Test-Path $cfgPath)) {
    $example = Join-Path $Src 'config.env.example'
    if (-not (Test-Path $example)) { throw 'config.env.example not found next to install.ps1.' }
    Copy-Item $example $cfgPath
}
icacls $cfgPath /inheritance:r /grant:r "${env:USERNAME}:(R,W)" "SYSTEM:(R)" "Administrators:(R)" | Out-Null

function Read-Cfg {
    $h = @{}
    Get-Content $cfgPath | ForEach-Object {
        if ($_ -match '^\s*([^#=\s]+)\s*=\s*(.*)$') { $h[$matches[1]] = $matches[2].Trim() }
    }
    return $h
}

function Get-Missing([string[]]$keys) {
    $c = Read-Cfg
    return @($keys | Where-Object { -not $c[$_] })
}

$required = @('DISCORD_BOT_TOKEN', 'DISCORD_CHANNEL_ID', 'TELEGRAM_BOT_TOKEN')
if ((Get-Missing $required).Count -gt 0) {
    Write-Host 'Fill in config.env (leave TELEGRAM_CHAT_ID empty for now), save, then close Notepad.'
    Start-Process notepad.exe $cfgPath -Wait
    $still = Get-Missing $required
    if ($still.Count -gt 0) { throw ('config.env is still missing: ' + ($still -join ', ')) }
}

if ((Get-Missing @('TELEGRAM_CHAT_ID')).Count -gt 0) {
    Write-Host 'Send any message to your Telegram bot now. Looking up your chat ID...'
    Read-Host 'Press Enter after you have messaged the bot'
    & $node (Join-Path $InstallDir 'watcher.js') --find-chat
    if ($LASTEXITCODE -ne 0) { throw 'Could not find a chat ID. Message your bot, then rerun this script.' }
    Write-Host 'Paste the TELEGRAM_CHAT_ID value into config.env, save, then close Notepad.'
    Start-Process notepad.exe $cfgPath -Wait
    if ((Get-Missing @('TELEGRAM_CHAT_ID')).Count -gt 0) { throw 'TELEGRAM_CHAT_ID is still empty in config.env.' }
}

# ---------- 4. Live test (also tests this machine's network against Discord) ----------
& $node (Join-Path $InstallDir 'watcher.js') --check
if ($LASTEXITCODE -ne 0) {
    throw 'Check failed. Read the Hint line above. The task was NOT installed. Fix config.env and rerun this script.'
}

# ---------- 5. Register the Scheduled Task ----------
$action  = New-ScheduledTaskAction -Execute $node -Argument ('"' + (Join-Path $InstallDir 'watcher.js') + '"') -WorkingDirectory $InstallDir
$trigger = New-ScheduledTaskTrigger -AtStartup
if ($RunAsSystem) {
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
} else {
    $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType S4U -RunLevel Limited
}
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null
Start-ScheduledTask -TaskName $TaskName

Start-Sleep -Seconds 8
Write-Host ''
Write-Host ('Task state: ' + (Get-ScheduledTask -TaskName $TaskName).State)
$logFile = Join-Path $InstallDir 'watcher.log'
if (Test-Path $logFile) { Get-Content $logFile -Tail 5 }
Write-Host 'Done. You should have a "Discord watcher is live" message in Telegram.'
