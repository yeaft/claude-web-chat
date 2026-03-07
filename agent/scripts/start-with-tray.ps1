# 启动 Claude Agent (pm2 托管) + 托盘图标
$AgentDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $AgentDir

# 检查 pm2
$pm2 = Get-Command pm2 -ErrorAction SilentlyContinue
if (-not $pm2) {
    Write-Host "Installing pm2..." -ForegroundColor Yellow
    npm install -g pm2
}

# 检查并安装 pm2-logrotate
$logrotateInstalled = pm2 list 2>$null | Select-String "pm2-logrotate"
if (-not $logrotateInstalled) {
    Write-Host "Installing pm2-logrotate..." -ForegroundColor Yellow
    pm2 install pm2-logrotate
    # 配置 logrotate
    pm2 set pm2-logrotate:max_size 10M
    pm2 set pm2-logrotate:retain 7
    pm2 set pm2-logrotate:compress true
    Write-Host "pm2-logrotate configured (max 10MB, keep 7 files)" -ForegroundColor Cyan
}

# 先停止已有进程，确保干净启动
Write-Host "Checking existing processes..." -ForegroundColor Gray
pm2 delete claude-agent 2>$null | Out-Null

# 启动 agent
Write-Host "Starting Claude Agent..." -ForegroundColor Green
pm2 start ecosystem.config.cjs

# 启动托盘（隐藏窗口）
Write-Host "Starting tray icon..." -ForegroundColor Green
Start-Process powershell -ArgumentList "-WindowStyle Hidden -File `"$AgentDir\agent-tray.ps1`"" -WindowStyle Hidden

Write-Host "Done! Check the system tray." -ForegroundColor Green
