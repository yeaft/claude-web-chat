// 加载 .env 文件
const fs = require('fs');
const path = require('path');

function loadEnv() {
  const agentDir = path.join(__dirname, '..');
  const envPath = path.join(agentDir, '.env');
  const env = { NODE_ENV: 'production' };

  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const match = line.match(/^\s*([^#][^=]*)\s*=\s*(.*)$/);
      if (match) {
        const key = match[1].trim();
        let value = match[2].trim();
        // 移除引号
        value = value.replace(/^["']|["']$/g, '');
        env[key] = value;
      }
    }
  }
  return env;
}

module.exports = {
  apps: [{
    name: 'claude-agent',
    script: 'cli.js',
    cwd: path.join(__dirname, '..'),
    // 从 .env 文件加载环境变量
    env: loadEnv(),
    // 自动重启配置
    autorestart: true,
    watch: false,
    max_restarts: 10,
    restart_delay: 5000,
    // 日志配置
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    error_file: 'logs/error.log',
    out_file: 'logs/out.log',
    merge_logs: true,
    // 内存超限自动重启
    max_memory_restart: '500M',
  }]
};
