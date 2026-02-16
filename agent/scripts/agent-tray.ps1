# Claude Agent 托盘管理器
# 右键托盘图标可以查看日志、重启、停止等

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$AgentDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $AgentDir

# 创建托盘图标
$notifyIcon = New-Object System.Windows.Forms.NotifyIcon
$notifyIcon.Text = "Claude Agent"
$notifyIcon.Visible = $true

# 创建 Claude 风格图标（橙色圆形 + 白色 C）
function Create-ClaudeIcon {
    $size = 32
    $bitmap = New-Object System.Drawing.Bitmap($size, $size)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias

    # 橙色背景圆形 (Claude 的品牌色)
    $orangeBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 204, 102, 51))
    $graphics.FillEllipse($orangeBrush, 1, 1, $size - 2, $size - 2)

    # 白色 "C" 字母
    $whiteBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
    $font = New-Object System.Drawing.Font("Arial", 16, [System.Drawing.FontStyle]::Bold)
    # 测量文字大小并精确居中
    $textSize = $graphics.MeasureString("C", $font)
    $x = ($size - $textSize.Width) / 2
    $y = ($size - $textSize.Height) / 2
    $graphics.DrawString("C", $font, $whiteBrush, $x, $y)

    $graphics.Dispose()

    # 转换为图标
    $hIcon = $bitmap.GetHicon()
    $icon = [System.Drawing.Icon]::FromHandle($hIcon)
    return $icon
}

$notifyIcon.Icon = Create-ClaudeIcon

# 创建右键菜单
$contextMenu = New-Object System.Windows.Forms.ContextMenuStrip

# 查看状态
$menuStatus = New-Object System.Windows.Forms.ToolStripMenuItem
$menuStatus.Text = "View Status"
$menuStatus.Add_Click({
    Start-Process "powershell" -ArgumentList "-NoExit -Command `"pm2 status`""
})
$contextMenu.Items.Add($menuStatus)

# 查看日志
$menuLogs = New-Object System.Windows.Forms.ToolStripMenuItem
$menuLogs.Text = "View Logs"
$menuLogs.Add_Click({
    Start-Process "powershell" -ArgumentList "-NoExit -Command `"pm2 logs claude-agent --lines 100`""
})
$contextMenu.Items.Add($menuLogs)

# 分隔线
$contextMenu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

# 重启
$menuRestart = New-Object System.Windows.Forms.ToolStripMenuItem
$menuRestart.Text = "Restart Agent"
$menuRestart.Add_Click({
    pm2 restart claude-agent
    $notifyIcon.ShowBalloonTip(2000, "Claude Agent", "Agent restarted", [System.Windows.Forms.ToolTipIcon]::Info)
})
$contextMenu.Items.Add($menuRestart)

# 停止
$menuStop = New-Object System.Windows.Forms.ToolStripMenuItem
$menuStop.Text = "Stop Agent"
$menuStop.Add_Click({
    pm2 stop claude-agent
    $notifyIcon.ShowBalloonTip(2000, "Claude Agent", "Agent stopped", [System.Windows.Forms.ToolTipIcon]::Warning)
})
$contextMenu.Items.Add($menuStop)

# 启动
$menuStart = New-Object System.Windows.Forms.ToolStripMenuItem
$menuStart.Text = "Start Agent"
$menuStart.Add_Click({
    pm2 start ecosystem.config.cjs
    $notifyIcon.ShowBalloonTip(2000, "Claude Agent", "Agent started", [System.Windows.Forms.ToolTipIcon]::Info)
})
$contextMenu.Items.Add($menuStart)

# 分隔线
$contextMenu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

# 打开日志文件夹
$menuOpenLogs = New-Object System.Windows.Forms.ToolStripMenuItem
$menuOpenLogs.Text = "Open Logs Folder"
$menuOpenLogs.Add_Click({
    Start-Process "explorer" -ArgumentList "$AgentDir\logs"
})
$contextMenu.Items.Add($menuOpenLogs)

# 分隔线
$contextMenu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

# 退出（停止 agent + 关闭托盘）
$menuExit = New-Object System.Windows.Forms.ToolStripMenuItem
$menuExit.Text = "Exit"
$menuExit.Add_Click({
    pm2 delete claude-agent 2>$null
    $notifyIcon.ShowBalloonTip(1000, "Claude Agent", "Agent stopped", [System.Windows.Forms.ToolTipIcon]::Info)
    Start-Sleep -Milliseconds 500
    $notifyIcon.Visible = $false
    $notifyIcon.Dispose()
    [System.Windows.Forms.Application]::Exit()
})
$contextMenu.Items.Add($menuExit)

$notifyIcon.ContextMenuStrip = $contextMenu

# 双击打开日志
$notifyIcon.Add_DoubleClick({
    Start-Process "powershell" -ArgumentList "-NoExit -Command `"pm2 logs claude-agent`""
})

# 显示启动提示
$notifyIcon.ShowBalloonTip(2000, "Claude Agent", "Tray manager started. Right-click for options.", [System.Windows.Forms.ToolTipIcon]::Info)

# 保持运行
[System.Windows.Forms.Application]::Run()
