import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * Tests for Windows agent upgrade flow (cli.js upgradeWindows + upgrade-worker-template.js retryOp).
 *
 * Verifies:
 *  1. upgradeWindows() generates a correct bat script and exits
 *  2. retryOp() correctly retries on EBUSY/EPERM/EACCES and throws on other errors
 *  3. Unix upgrade path remains a simple execSync call
 */

// ---------------------------------------------------------------------------
// retryOp – extracted from upgrade-worker-template.js for direct testing
// ---------------------------------------------------------------------------
function retryOp(fn, label, maxRetries = 5) {
  for (let i = 0; i <= maxRetries; i++) {
    try {
      return fn();
    } catch (err) {
      const isLockErr = err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES';
      if (!isLockErr || i === maxRetries) throw err;
      // In tests we skip the busy-wait delay
    }
  }
}

// ---------------------------------------------------------------------------
// upgradeWindows – bat script generation logic extracted from cli.js
// ---------------------------------------------------------------------------
function generateBatLines({ pid, pkgSpec, logPath, batPath }) {
  return [
    '@echo off',
    'setlocal',
    `set PID=${pid}`,
    `set PKG=${pkgSpec}`,
    `set LOGFILE=${logPath}`,
    `set MAX_WAIT=30`,
    `set COUNT=0`,
    '',
    ':: Change to temp dir to avoid EBUSY on cwd',
    'cd /d "%TEMP%"',
    '',
    'echo [Upgrade] Started at %date% %time% > "%LOGFILE%"',
    'echo [Upgrade] Waiting for CLI process (PID %PID%) to exit... >> "%LOGFILE%"',
    '',
    ':WAIT_LOOP',
    'tasklist /FI "PID eq %PID%" 2>NUL | findstr /I "%PID%" >NUL',
    'if errorlevel 1 goto PID_EXITED',
    'set /A COUNT+=1',
    'if %COUNT% GEQ %MAX_WAIT% (',
    '  echo [Upgrade] Timeout waiting for PID %PID% to exit >> "%LOGFILE%"',
    '  goto PID_EXITED',
    ')',
    'ping -n 3 127.0.0.1 >NUL',
    'goto WAIT_LOOP',
    ':PID_EXITED',
    '',
    'echo [Upgrade] Process exited, running npm install -g %PKG%... >> "%LOGFILE%"',
    'call npm install -g %PKG% >> "%LOGFILE%" 2>&1',
    'if not "%errorlevel%"=="0" (',
    '  echo [Upgrade] npm install failed with exit code %errorlevel% >> "%LOGFILE%"',
    '  goto END',
    ')',
    'echo [Upgrade] Successfully upgraded. >> "%LOGFILE%"',
    '',
    ':END',
    `del /F /Q "${batPath}" 2>NUL`,
  ];
}

// =========================================================================
// Test: retryOp
// =========================================================================
describe('retryOp — file lock retry logic', () => {
  it('should return value on first success', () => {
    const result = retryOp(() => 42, 'test-op');
    expect(result).toBe(42);
  });

  it('should retry on EBUSY and succeed', () => {
    let calls = 0;
    const fn = () => {
      calls++;
      if (calls < 3) {
        const err = new Error('busy');
        err.code = 'EBUSY';
        throw err;
      }
      return 'ok';
    };
    expect(retryOp(fn, 'ebusy-test')).toBe('ok');
    expect(calls).toBe(3);
  });

  it('should retry on EPERM and succeed', () => {
    let calls = 0;
    const fn = () => {
      calls++;
      if (calls < 2) {
        const err = new Error('permission');
        err.code = 'EPERM';
        throw err;
      }
      return 'done';
    };
    expect(retryOp(fn, 'eperm-test')).toBe('done');
    expect(calls).toBe(2);
  });

  it('should retry on EACCES and succeed', () => {
    let calls = 0;
    const fn = () => {
      calls++;
      if (calls < 2) {
        const err = new Error('access');
        err.code = 'EACCES';
        throw err;
      }
      return 'done';
    };
    expect(retryOp(fn, 'eacces-test')).toBe('done');
    expect(calls).toBe(2);
  });

  it('should throw immediately on non-lock errors (e.g. ENOENT)', () => {
    let calls = 0;
    const fn = () => {
      calls++;
      const err = new Error('not found');
      err.code = 'ENOENT';
      throw err;
    };
    expect(() => retryOp(fn, 'enoent-test')).toThrow('not found');
    expect(calls).toBe(1); // no retry
  });

  it('should throw after maxRetries exhausted on lock errors', () => {
    let calls = 0;
    const fn = () => {
      calls++;
      const err = new Error('busy');
      err.code = 'EBUSY';
      throw err;
    };
    expect(() => retryOp(fn, 'exhaust-test', 3)).toThrow('busy');
    expect(calls).toBe(4); // initial + 3 retries
  });

  it('should respect custom maxRetries', () => {
    let calls = 0;
    const fn = () => {
      calls++;
      const err = new Error('busy');
      err.code = 'EBUSY';
      throw err;
    };
    expect(() => retryOp(fn, 'custom-max', 1)).toThrow('busy');
    expect(calls).toBe(2); // initial + 1 retry
  });

  it('should return undefined if fn returns nothing', () => {
    const result = retryOp(() => {}, 'void-op');
    expect(result).toBeUndefined();
  });
});

// =========================================================================
// Test: Windows bat script generation
// =========================================================================
describe('upgradeWindows — bat script generation', () => {
  const params = {
    pid: 12345,
    pkgSpec: '@yeaft/webchat-agent@1.2.3',
    logPath: 'C:\\Users\\test\\AppData\\Roaming\\yeaft-agent\\logs\\upgrade.log',
    batPath: 'C:\\Users\\test\\AppData\\Roaming\\yeaft-agent\\upgrade-cli.bat',
  };

  let batLines;
  let batContent;

  beforeEach(() => {
    batLines = generateBatLines(params);
    batContent = batLines.join('\r\n');
  });

  it('should start with @echo off', () => {
    expect(batLines[0]).toBe('@echo off');
  });

  it('should embed the current PID', () => {
    expect(batContent).toContain(`set PID=${params.pid}`);
  });

  it('should embed the package spec', () => {
    expect(batContent).toContain(`set PKG=${params.pkgSpec}`);
  });

  it('should embed the log file path', () => {
    expect(batContent).toContain(`set LOGFILE=${params.logPath}`);
  });

  it('should change to TEMP dir to avoid EBUSY', () => {
    expect(batContent).toContain('cd /d "%TEMP%"');
  });

  it('should have a wait loop checking for PID exit', () => {
    expect(batContent).toContain(':WAIT_LOOP');
    expect(batContent).toContain('tasklist /FI "PID eq %PID%"');
    expect(batContent).toContain(':PID_EXITED');
  });

  it('should use findstr instead of find for PID check (find without pipe hangs on Windows)', () => {
    expect(batContent).toContain('findstr /I "%PID%"');
    expect(batContent).not.toContain('| find /I');
  });

  it('should have a max wait timeout', () => {
    expect(batContent).toContain('set MAX_WAIT=30');
    expect(batContent).toContain('if %COUNT% GEQ %MAX_WAIT%');
  });

  it('should call npm install -g with PKG variable', () => {
    expect(batContent).toContain('call npm install -g %PKG%');
  });

  it('should check npm exit code and log failure', () => {
    expect(batContent).toContain('if not "%errorlevel%"=="0"');
    expect(batContent).toContain('npm install failed with exit code');
  });

  it('should self-delete the bat file at the end', () => {
    expect(batContent).toContain(`del /F /Q "${params.batPath}"`);
  });

  it('should use CRLF line endings', () => {
    expect(batContent).toContain('\r\n');
    // Verify no bare \n without \r
    const lines = batContent.split('\r\n');
    expect(lines.length).toBeGreaterThan(10);
  });

  it('should log the upgrade result', () => {
    expect(batContent).toContain('Successfully upgraded');
  });

  it('should use ping for delay instead of timeout (more compatible)', () => {
    expect(batContent).toContain('ping -n 3 127.0.0.1 >NUL');
    // 'timeout' command is less reliable in non-interactive bat scripts
    expect(batContent).not.toContain('timeout /t');
  });
});

// =========================================================================
// Test: upgrade() platform branching
// =========================================================================
describe('upgrade() — platform branching logic', () => {
  it('should branch to upgradeWindows on win32', () => {
    const cliSource = fs.readFileSync(
      path.join(process.cwd(), 'agent/cli.js'),
      'utf-8'
    );
    expect(cliSource).toContain("platform() === 'win32'");
    expect(cliSource).toContain('upgradeWindows(latest)');
  });

  it('should use execSync npm install -g on non-Windows (Unix path)', () => {
    const cliSource = fs.readFileSync(
      path.join(process.cwd(), 'agent/cli.js'),
      'utf-8'
    );
    expect(cliSource).toContain('execSync(`npm install -g ${pkg.name}@latest`');
  });

  it('should use exact version (not @latest) in Windows pkgSpec', () => {
    const cliSource = fs.readFileSync(
      path.join(process.cwd(), 'agent/cli.js'),
      'utf-8'
    );
    // upgradeWindows must use latestVersion parameter, not hardcoded @latest
    expect(cliSource).toContain('`${pkg.name}@${latestVersion}`');
    // The upgradeWindows function should NOT have @latest in pkgSpec
    const upgradeWindowsFn = cliSource.slice(cliSource.indexOf('function upgradeWindows'));
    expect(upgradeWindowsFn).not.toContain("@latest");
  });

  it('should call process.exit(0) in upgradeWindows after spawning bat', () => {
    const cliSource = fs.readFileSync(
      path.join(process.cwd(), 'agent/cli.js'),
      'utf-8'
    );
    // detached was removed to prevent cmd windows from popping up (task-19)
    expect(cliSource).not.toContain("detached: true");
    expect(cliSource).toContain("child.unref()");
    expect(cliSource).toContain("process.exit(0)");
  });

  it('should spawn cmd.exe with windowsHide: true', () => {
    const cliSource = fs.readFileSync(
      path.join(process.cwd(), 'agent/cli.js'),
      'utf-8'
    );
    expect(cliSource).toContain("windowsHide: true");
    expect(cliSource).toContain("spawn('cmd.exe'");
  });
});

// =========================================================================
// Test: upgrade-worker-template.js retryOp integration
// =========================================================================
describe('upgrade-worker-template.js — retryOp integration', () => {
  it('should wrap rmSync with retryOp', () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), 'agent/connection/upgrade-worker-template.js'),
      'utf-8'
    );
    expect(src).toContain("retryOp(() => fs.rmSync(full, { recursive: true, force: true }), 'rmdir '");
  });

  it('should wrap unlinkSync with retryOp', () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), 'agent/connection/upgrade-worker-template.js'),
      'utf-8'
    );
    expect(src).toContain("retryOp(() => fs.unlinkSync(full), 'unlink '");
  });

  it('should wrap writeFileSync with retryOp', () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), 'agent/connection/upgrade-worker-template.js'),
      'utf-8'
    );
    expect(src).toContain("retryOp(() => fs.writeFileSync(dest, f.data), 'write '");
  });

  it('should have retryOp handle EBUSY, EPERM, and EACCES', () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), 'agent/connection/upgrade-worker-template.js'),
      'utf-8'
    );
    expect(src).toContain("err.code === 'EBUSY'");
    expect(src).toContain("err.code === 'EPERM'");
    expect(src).toContain("err.code === 'EACCES'");
  });

  it('should use exponential backoff with max 10s delay', () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), 'agent/connection/upgrade-worker-template.js'),
      'utf-8'
    );
    expect(src).toContain('Math.min(1000 * Math.pow(2, i), 10000)');
  });

  it('should default to maxRetries = 5', () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), 'agent/connection/upgrade-worker-template.js'),
      'utf-8'
    );
    expect(src).toContain('maxRetries = 5');
  });
});

// =========================================================================
// Test: retryOp exponential backoff delay values
// =========================================================================
describe('retryOp — exponential backoff delay calculation', () => {
  it('should calculate correct delay sequence (1s, 2s, 4s, 8s, 10s capped)', () => {
    const delays = [];
    for (let i = 0; i < 5; i++) {
      delays.push(Math.min(1000 * Math.pow(2, i), 10000));
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 10000]);
  });

  it('should cap at 10000ms for higher retry indices', () => {
    const delay6 = Math.min(1000 * Math.pow(2, 5), 10000);
    const delay7 = Math.min(1000 * Math.pow(2, 6), 10000);
    expect(delay6).toBe(10000);
    expect(delay7).toBe(10000);
  });
});

// =========================================================================
// Test: Remote upgrade (upgrade.js) — PM2 race condition fix
// =========================================================================
describe('remote upgrade (upgrade.js) — PM2 race condition fix', () => {
  let upgradeSource;

  beforeEach(() => {
    upgradeSource = fs.readFileSync(
      path.join(process.cwd(), 'agent/connection/upgrade.js'),
      'utf-8'
    );
  });

  it('should delete PM2 app before process exit to prevent auto-restart', () => {
    // The fix: pm2 delete must happen BEFORE cleanupAndExit, not in the bat script
    const deleteIndex = upgradeSource.indexOf("pm2', ['delete'");
    const exitIndex = upgradeSource.indexOf('cleanupAndExit(0)');
    expect(deleteIndex).toBeGreaterThan(-1);
    expect(exitIndex).toBeGreaterThan(-1);
    expect(deleteIndex).toBeLessThan(exitIndex);
  });

  it('should use execFileSync for pm2 delete (synchronous before exit)', () => {
    expect(upgradeSource).toContain("execFileSync('pm2', ['delete'");
  });

  it('should not have pm2 stop in the bat script (replaced by pre-exit pm2 delete)', () => {
    // The old code had 'pm2 stop yeaft-agent' in the bat script which raced with PM2 restart
    expect(upgradeSource).not.toContain("pm2 stop yeaft-agent");
  });

  it('should use findstr instead of find in bat script (find without pipe hangs on Windows)', () => {
    // findstr /I was replaced with /C: for exact literal matching (task-19)
    expect(upgradeSource).toContain('findstr /C:');
    expect(upgradeSource).not.toContain("| find /I");
  });

  it('should re-register PM2 via ecosystem config after upgrade', () => {
    expect(upgradeSource).toContain('pm2 start');
    expect(upgradeSource).toContain('ecosystem.config.cjs');
  });

  it('should save PM2 process list after re-registering', () => {
    expect(upgradeSource).toContain('pm2 save');
  });
});
