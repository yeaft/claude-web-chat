# Claude Agent PM2 托管启动脚本
# 用法: .\pm2-start.ps1

$ErrorActionPreference = "Stop"
$AgentDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# 切换到 agent 目录
Set-Location $AgentDir

# 检查 pm2 是否安装
$pm2Path = Get-Command pm2 -ErrorAction SilentlyContinue
if (-not $pm2Path) {
    Write-Host "Installing pm2 globally..." -ForegroundColor Yellow
    npm install -g pm2
    # Windows 上需要安装 pm2-windows-startup
    npm install -g pm2-windows-startup
}

# 安装依赖 (每次都检查确保完整)
Write-Host "Checking dependencies..." -ForegroundColor Yellow
npm install --silent
if ($LASTEXITCODE -ne 0) {
    Write-Host "Failed to install dependencies!" -ForegroundColor Red
    exit 1
}

# 检查 .env 文件
if (-not (Test-Path ".env")) {
    Write-Host "No .env file found. Creating from .env.example..." -ForegroundColor Yellow
    if (Test-Path ".env.example") {
        Copy-Item ".env.example" ".env"
        Write-Host "Please edit .env with your configuration, then run this script again." -ForegroundColor Red
        exit 1
    } else {
        Write-Host "No .env.example found!" -ForegroundColor Red
        exit 1
    }
}

# 启动 pm2
Write-Host ""
Write-Host "Starting Claude Agent with pm2..." -ForegroundColor Green
pm2 start ecosystem.config.cjs

Write-Host ""
Write-Host "Agent started!" -ForegroundColor Green
Write-Host ""
Write-Host "Management commands:" -ForegroundColor Cyan
Write-Host "  pm2 status              - Check status"
Write-Host "  pm2 logs claude-agent   - View logs (follow mode)"
Write-Host "  pm2 logs claude-agent --lines 100  - View last 100 lines"
Write-Host "  pm2 stop claude-agent   - Stop agent"
Write-Host "  pm2 restart claude-agent - Restart agent"
Write-Host "  pm2 delete claude-agent - Remove from pm2"
Write-Host ""
Write-Host "To enable startup on Windows boot:" -ForegroundColor Yellow
Write-Host "  1. pm2 save"
Write-Host "  2. pm2-startup install"
Write-Host ""
