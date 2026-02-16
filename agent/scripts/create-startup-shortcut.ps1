# 创建开机自启动快捷方式
$AgentDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$StartupFolder = [Environment]::GetFolderPath('Startup')
$ShortcutPath = Join-Path $StartupFolder "Claude Agent.lnk"

$WshShell = New-Object -ComObject WScript.Shell
$Shortcut = $WshShell.CreateShortcut($ShortcutPath)
$Shortcut.TargetPath = "powershell.exe"
$Shortcut.Arguments = "-WindowStyle Hidden -ExecutionPolicy Bypass -File `"$AgentDir\start-with-tray.ps1`""
$Shortcut.WorkingDirectory = $AgentDir
$Shortcut.Description = "Claude Agent with Tray"
$Shortcut.WindowStyle = 7  # Minimized
$Shortcut.Save()

Write-Host "Startup shortcut created at:" -ForegroundColor Green
Write-Host "  $ShortcutPath" -ForegroundColor Cyan
Write-Host ""
Write-Host "The agent will now start automatically when you log in." -ForegroundColor Green
