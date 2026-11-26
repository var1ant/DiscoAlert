#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Removes the DiscordWatcher Scheduled Task. Keeps your files unless -RemoveFiles is given.

.DESCRIPTION
    powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
    powershell -ExecutionPolicy Bypass -File .\uninstall.ps1 -RemoveFiles
#>
[CmdletBinding()]
param(
    [string]$InstallDir = 'C:\discord-watcher',
    [string]$TaskName   = 'DiscordWatcher',
    [switch]$RemoveFiles
)

$ErrorActionPreference = 'Stop'

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Removed task $TaskName."
} else {
    Write-Host "Task $TaskName not found."
}

if ($RemoveFiles) {
    if (Test-Path $InstallDir) {
        Remove-Item $InstallDir -Recurse -Force
        Write-Host "Deleted $InstallDir."
    }
} else {
    Write-Host "Files kept in $InstallDir (config.env holds your tokens). Run again with -RemoveFiles to delete them."
}
