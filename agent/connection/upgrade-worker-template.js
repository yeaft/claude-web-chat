'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');
const os = require('os');

const PKG = process.argv[2];
const TARGET = process.argv[3];
const LOGFILE = process.argv[4];

function log(msg) {
  const line = '[Upgrade-Worker] ' + msg;
  console.log(line);
  try { fs.appendFileSync(LOGFILE, line + '\n'); } catch {}
}

// Retry a file operation with exponential backoff (Windows file lock workaround)
function retryOp(fn, label, maxRetries = 5) {
  for (let i = 0; i <= maxRetries; i++) {
    try {
      return fn();
    } catch (err) {
      const isLockErr = err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES';
      if (!isLockErr || i === maxRetries) throw err;
      const delay = Math.min(1000 * Math.pow(2, i), 10000);
      log(`${label}: ${err.code}, retrying in ${delay}ms (${i + 1}/${maxRetries})...`);
      const end = Date.now() + delay;
      while (Date.now() < end) { /* busy-wait in sync context */ }
    }
  }
}

function parseTar(buf) {
  const files = [];
  let offset = 0;
  while (offset < buf.length - 512) {
    const header = buf.slice(offset, offset + 512);
    if (header.every(b => b === 0)) break;
    const name = header.slice(0, 100).toString('utf8').replace(/\0.*/, '');
    const sizeStr = header.slice(124, 136).toString('utf8').replace(/\0.*/, '').trim();
    const size = parseInt(sizeStr, 8) || 0;
    const typeFlag = header[156];
    offset += 512;
    if (size > 0) {
      const data = buf.slice(offset, offset + size);
      const relPath = name.replace(/^package\//, '');
      if (typeFlag === 48 || typeFlag === 0) {
        files.push({ path: relPath, data });
      }
      offset += Math.ceil(size / 512) * 512;
    }
  }
  return files;
}

function rmDirContents(dir, keep) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir)) {
    if (keep && keep.includes(entry)) continue;
    const full = path.join(dir, entry);
    const stat = fs.statSync(full, { throwIfNoEntry: false });
    if (!stat) continue;
    if (stat.isDirectory()) {
      retryOp(() => fs.rmSync(full, { recursive: true, force: true }), 'rmdir ' + entry);
    } else {
      retryOp(() => fs.unlinkSync(full), 'unlink ' + entry);
    }
  }
}

try {
  log('Starting upgrade: ' + PKG + ' -> ' + TARGET);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yeaft-upgrade-'));
  log('Temp dir: ' + tmpDir);

  const packOutput = execFileSync('npm', ['pack', PKG, '--pack-destination', tmpDir], {
    shell: process.platform === 'win32', encoding: 'utf8', cwd: tmpDir, timeout: 120000
  }).trim();
  const tgzName = packOutput.split('\n').pop().trim();
  const tgzPath = path.join(tmpDir, tgzName);
  log('Downloaded: ' + tgzPath);

  const gzBuf = fs.readFileSync(tgzPath);
  const tarBuf = zlib.gunzipSync(gzBuf);
  const files = parseTar(tarBuf);
  log('Extracted ' + files.length + ' files from archive');

  log('Removing old files from: ' + TARGET);
  rmDirContents(TARGET, ['node_modules']);

  for (const f of files) {
    const dest = path.join(TARGET, f.path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    retryOp(() => fs.writeFileSync(dest, f.data), 'write ' + f.path);
  }
  log('Copied ' + files.length + ' files to target');

  log('Installing dependencies...');
  try {
    execFileSync('npm', ['install', '--omit=dev'], {
      shell: process.platform === 'win32', cwd: TARGET, encoding: 'utf8', timeout: 120000
    });
    log('Dependencies installed');
  } catch (depErr) {
    log('WARN: npm install deps failed: ' + depErr.message);
  }

  const newPkg = JSON.parse(fs.readFileSync(path.join(TARGET, 'package.json'), 'utf8'));
  log('Upgrade complete. New version: ' + newPkg.version);

  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(0);
} catch (err) {
  log('FATAL: ' + err.message);
  log(err.stack || '');
  process.exit(1);
}
