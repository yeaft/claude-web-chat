import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  accessSync,
  chmodSync,
  copyFileSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { gunzipSync, inflateRawSync } from 'node:zlib';

const DEFAULT_ROOT = join(homedir(), '.yeaft');
const DOWNLOAD_TIMEOUT_MS = 30_000;
const MAX_ARCHIVE_BYTES = 25 * 1024 * 1024;
const MAX_BINARY_BYTES = 20 * 1024 * 1024;
const FAILURE_COOLDOWN_MS = 60 * 60 * 1000;
const LOCK_STALE_MS = 2 * 60 * 1000;
const LOCK_WAIT_MS = 15_000;
const STATE_FILE = 'managed-cli.json';
const installFlights = new Map();
const runtimePathDirectories = new Set();
let runtimePathCleanupRegistered = false;

const TOOL_SPECS = Object.freeze({
  rg: {
    version: '15.2.0',
    repository: 'BurntSushi/ripgrep',
    tag: '15.2.0',
    assets: {
      'linux-x64': ['ripgrep-15.2.0-x86_64-unknown-linux-musl.tar.gz', '33e15bcf1624b25cdd2a55813a47a2f95dbe126268203e76aa6a585d1e7b149c'],
      'linux-arm64': ['ripgrep-15.2.0-aarch64-unknown-linux-musl.tar.gz', '800b1e7206afe799dfb5a6901f23147cfaabe0e52210538100f61e86e1740915'],
      'darwin-x64': ['ripgrep-15.2.0-x86_64-apple-darwin.tar.gz', 'af7825fcc69a2afc7a7aea55fc9af90e26421d8f20fe59df32e233c0b8a231c1'],
      'darwin-arm64': ['ripgrep-15.2.0-aarch64-apple-darwin.tar.gz', '3750b2e93f37e0c692657da574d7019a101c0084da05a790c83fd335bad973e4'],
      'win32-x64': ['ripgrep-15.2.0-x86_64-pc-windows-msvc.zip', '71b2fef860abe467217a538ff31de02f5258807c0129f771846f87bd029aafc5'],
      'win32-arm64': ['ripgrep-15.2.0-aarch64-pc-windows-msvc.zip', 'e4abca10c3a64ebea742667dd7009449d49403db5460dd6873e389fa2945360f'],
    },
  },
  fd: {
    version: '10.3.0',
    repository: 'sharkdp/fd',
    tag: 'v10.3.0',
    aliases: ['fdfind'],
    assets: {
      'linux-x64': ['fd-v10.3.0-x86_64-unknown-linux-musl.tar.gz', '2b6bfaae8c48f12050813c2ffe1884c61ea26e750d803df9c9114550a314cd14'],
      'linux-arm64': ['fd-v10.3.0-aarch64-unknown-linux-musl.tar.gz', '996b9b1366433b211cb3bbedba91c9dbce2431842144d925428ead0adf32020b'],
      'darwin-x64': ['fd-v10.3.0-x86_64-apple-darwin.tar.gz', '50d30f13fe3d5914b14c4fff5abcbd4d0cdab4b855970a6956f4f006c17117a3'],
      'darwin-arm64': ['fd-v10.3.0-aarch64-apple-darwin.tar.gz', '0570263812089120bc2a5d84f9e65cd0c25e4a4d724c80075c357239c74ae904'],
      'win32-x64': ['fd-v10.3.0-x86_64-pc-windows-msvc.zip', '318aa2a6fa664325933e81fda60d523fff29444129e91ebf0726b5b3bcd8b059'],
      'win32-arm64': ['fd-v10.3.0-aarch64-pc-windows-msvc.zip', 'bf9b1e31bcac71c1e95d49c56f0d872f525b95d03854e94b1d4dd6786f825cc5'],
    },
  },
  dust: {
    version: '1.2.4',
    repository: 'bootandy/dust',
    tag: 'v1.2.4',
    assets: {
      'linux-x64': ['dust-v1.2.4-x86_64-unknown-linux-musl.tar.gz', '4e313f9f854017e58a2ada4c0d1774677b8cf53d63ab55a991d5871d5f504452'],
      'linux-arm64': ['dust-v1.2.4-aarch64-unknown-linux-musl.tar.gz', 'e09b0d24b5da0fa06aecf1561849c13ae41ef055c1ce7077e35e9a46744b16af'],
      'darwin-x64': ['dust-v1.2.4-x86_64-apple-darwin.tar.gz', 'bf84d3ff7f58e325d3eb5bb7696df6b22ef1e01fec80c2d8f7c9d3e611be66f4'],
      'win32-x64': ['dust-v1.2.4-x86_64-pc-windows-msvc.zip', 'eb08d642f016787bb9fc918a4dc5f34665463657fddf83a40f2441cbf020fb4c'],
    },
  },
});

function executableName(name, platform = process.platform) {
  return platform === 'win32' ? `${name}.exe` : name;
}

export function managedCliBinDir(yeaftDir = DEFAULT_ROOT) {
  return join(resolve(yeaftDir), 'bin');
}

function prependDirectoryToPath(
  binDir,
  env = process.env,
  platform = process.platform,
) {
  const current = typeof env.PATH === 'string'
    ? env.PATH
    : (typeof env.Path === 'string' ? env.Path : '');
  const parts = current.split(delimiter).filter(Boolean);
  const normalized = platform === 'win32' ? binDir.toLowerCase() : binDir;
  if (!parts.some(part => (platform === 'win32' ? part.toLowerCase() : part) === normalized)) {
    const nextPath = [binDir, ...parts].join(delimiter);
    env.PATH = nextPath;
    if (platform === 'win32' && Object.hasOwn(env, 'Path')) env.Path = nextPath;
  }
  return binDir;
}

export function prependManagedCliBinToPath(yeaftDir = DEFAULT_ROOT, env = process.env, platform = process.platform) {
  return prependDirectoryToPath(managedCliBinDir(yeaftDir), env, platform);
}

function canExecute(path, platform) {
  try {
    accessSync(path, platform === 'win32' ? constants.F_OK : constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function pathCandidates(name, { env, platform }) {
  const names = platform === 'win32'
    ? [name.endsWith('.exe') ? name : `${name}.exe`, name]
    : [name];
  const pathEntries = String(env.PATH || env.Path || '').split(delimiter).filter(Boolean);
  const candidates = [];
  for (const directory of pathEntries) {
    for (const candidate of names) candidates.push(join(directory, candidate));
  }
  return candidates;
}

function hashFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function samePath(left, right, platform) {
  let normalizedLeft;
  let normalizedRight;
  try { normalizedLeft = realpathSync(left); } catch { normalizedLeft = resolve(left); }
  try { normalizedRight = realpathSync(right); } catch { normalizedRight = resolve(right); }
  return platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function sameFileIdentity(left, right) {
  try {
    const leftStat = statSync(left, { bigint: true });
    const rightStat = statSync(right, { bigint: true });
    return leftStat.isFile()
      && rightStat.isFile()
      && leftStat.dev === rightStat.dev
      && leftStat.ino === rightStat.ino;
  } catch {
    return false;
  }
}

function inspectManagedBinary(name, { yeaftDir, platform, arch }) {
  const asset = selectAsset(name, platform, arch);
  const path = join(managedCliBinDir(yeaftDir), executableName(name, platform));
  if (!asset || !canExecute(path, platform)) return { path, exists: false, valid: false };
  const installation = readState(yeaftDir).installations?.[name];
  if (installation?.version !== asset.version
    || installation?.platform !== platform
    || installation?.arch !== arch
    || installation?.assetFileName !== asset.fileName
    || installation?.archiveSha256 !== asset.sha256
    || typeof installation?.binarySha256 !== 'string') {
    return { path, exists: true, valid: false };
  }
  try {
    const binarySha256 = hashFile(path);
    return {
      path,
      exists: true,
      valid: binarySha256 === installation.binarySha256,
      binarySha256,
    };
  } catch {
    return { path, exists: true, valid: false };
  }
}

function resolveExternalCommand(name, { yeaftDir, env, platform }) {
  const spec = TOOL_SPECS[name];
  const managedBinDir = managedCliBinDir(yeaftDir);
  const managedPath = join(managedBinDir, executableName(name, platform));
  for (const commandName of [name, ...(spec.aliases || [])]) {
    for (const candidate of pathCandidates(commandName, { env, platform })) {
      if (samePath(dirname(candidate), managedBinDir, platform)
        || samePath(candidate, managedPath, platform)
        || sameFileIdentity(candidate, managedPath)) continue;
      if (canExecute(candidate, platform)) return candidate;
    }
  }
  return null;
}

export function resolveManagedCliCommand(name, options = {}) {
  const spec = TOOL_SPECS[name];
  if (!spec) return null;
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const arch = options.arch || process.arch;
  const yeaftDir = resolve(options.yeaftDir || DEFAULT_ROOT);
  const managed = inspectManagedBinary(name, { yeaftDir, platform, arch });
  if (managed.valid) return managed.path;
  return resolveExternalCommand(name, { yeaftDir, env, platform });
}

function selectAsset(name, platform, arch) {
  const spec = TOOL_SPECS[name];
  if (!spec) return null;
  const asset = spec.assets[`${platform}-${arch}`];
  if (!asset) return null;
  const [fileName, sha256] = asset;
  return {
    ...spec,
    fileName,
    sha256,
    url: `https://github.com/${spec.repository}/releases/download/${spec.tag}/${fileName}`,
  };
}

function readState(yeaftDir) {
  try {
    const parsed = JSON.parse(readFileSync(join(yeaftDir, STATE_FILE), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeState(yeaftDir, state) {
  const target = join(yeaftDir, STATE_FILE);
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, target);
}

function sleep(ms) {
  return new Promise(resolveSleep => setTimeout(resolveSleep, ms));
}

async function acquireLock(lockDir, waitMs = LOCK_WAIT_MS, ready = null) {
  const startedAt = Date.now();
  for (;;) {
    try {
      mkdirSync(lockDir);
      return true;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (ready?.()) return false;

      let invalidLock = false;
      let staleLock = false;
      try {
        const lockStat = lstatSync(lockDir);
        invalidLock = !lockStat.isDirectory();
        staleLock = !invalidLock && Date.now() - lockStat.mtimeMs > LOCK_STALE_MS;
      } catch {
        // Inspection failures are treated as a busy lock until the deadline.
      }

      if (invalidLock) {
        try { unlinkSync(lockDir); } catch {}
        return false;
      }
      if (staleLock) {
        try { rmSync(lockDir, { recursive: true, force: true }); } catch {}
      }

      const remainingMs = waitMs - (Date.now() - startedAt);
      if (remainingMs <= 0) return false;
      await sleep(Math.min(250, remainingMs));
    }
  }
}

async function updateState(yeaftDir, update) {
  const lockDir = join(yeaftDir, '.managed-cli-state.lock');
  const acquired = await acquireLock(lockDir, LOCK_WAIT_MS);
  if (!acquired) throw new Error('managed CLI state is busy');
  try {
    const current = readState(yeaftDir);
    const next = update(current && typeof current === 'object' ? current : {});
    writeState(yeaftDir, next);
    return next;
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

async function downloadArchive(asset, fetchFn, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(asset.url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': 'yeaft-agent-managed-cli' },
    });
    if (!response.ok) throw new Error(`download returned HTTP ${response.status}`);
    const declaredSize = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declaredSize) && declaredSize > MAX_ARCHIVE_BYTES) {
      throw new Error(`archive is too large (${declaredSize} bytes)`);
    }

    const chunks = [];
    let total = 0;
    for await (const chunk of response.body || []) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > MAX_ARCHIVE_BYTES) throw new Error('archive exceeds download limit');
      chunks.push(buffer);
    }
    const archive = Buffer.concat(chunks);
    if (archive.length === 0) throw new Error('download returned an empty archive');
    const actual = createHash('sha256').update(archive).digest('hex');
    if (actual !== asset.sha256) throw new Error(`checksum mismatch for ${asset.fileName}`);
    return archive;
  } finally {
    clearTimeout(timer);
  }
}

function tarString(buffer, start, length) {
  return buffer.subarray(start, start + length).toString('utf8').replace(/\0.*$/, '');
}

function extractTarBinary(archive, binaryFileName) {
  const tar = gunzipSync(archive, { maxOutputLength: 64 * 1024 * 1024 });
  for (let offset = 0; offset + 512 <= tar.length;) {
    if (tar.subarray(offset, offset + 512).every(byte => byte === 0)) break;
    const name = tarString(tar, offset, 100);
    const prefix = tarString(tar, offset + 345, 155);
    const entryName = prefix ? `${prefix}/${name}` : name;
    const sizeText = tarString(tar, offset + 124, 12).trim();
    const size = Number.parseInt(sizeText || '0', 8);
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_BINARY_BYTES) {
      throw new Error('invalid tar entry size');
    }
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) throw new Error('truncated tar archive');
    const type = tar[offset + 156];
    if ((type === 0 || type === 48) && basename(entryName) === binaryFileName) {
      return Buffer.from(tar.subarray(dataStart, dataEnd));
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  throw new Error(`binary ${binaryFileName} was not found in tar archive`);
}

function findZipEnd(buffer) {
  const minimum = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  return -1;
}

function extractZipBinary(archive, binaryFileName) {
  const endOffset = findZipEnd(archive);
  if (endOffset < 0) throw new Error('zip central directory was not found');
  const entryCount = archive.readUInt16LE(endOffset + 10);
  let offset = archive.readUInt32LE(endOffset + 16);

  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > archive.length || archive.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error('invalid zip central directory');
    }
    const compression = archive.readUInt16LE(offset + 10);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const uncompressedSize = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const localOffset = archive.readUInt32LE(offset + 42);
    const entryName = archive.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');

    if (basename(entryName) === binaryFileName) {
      if (uncompressedSize > MAX_BINARY_BYTES) throw new Error('binary exceeds extraction limit');
      if (localOffset + 30 > archive.length || archive.readUInt32LE(localOffset) !== 0x04034b50) {
        throw new Error('invalid zip local header');
      }
      const localNameLength = archive.readUInt16LE(localOffset + 26);
      const localExtraLength = archive.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const dataEnd = dataStart + compressedSize;
      if (dataEnd > archive.length) throw new Error('truncated zip archive');
      const compressed = archive.subarray(dataStart, dataEnd);
      const binary = compression === 0
        ? Buffer.from(compressed)
        : (compression === 8
            ? inflateRawSync(compressed, { maxOutputLength: MAX_BINARY_BYTES })
            : null);
      if (!binary) throw new Error(`unsupported zip compression method ${compression}`);
      if (binary.length !== uncompressedSize) throw new Error('zip binary size mismatch');
      return binary;
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`binary ${binaryFileName} was not found in zip archive`);
}

export function extractManagedCliBinary(archive, archiveName, commandName, platform = process.platform) {
  const binaryFileName = executableName(commandName, platform);
  if (archiveName.endsWith('.tar.gz')) return extractTarBinary(archive, binaryFileName);
  if (archiveName.endsWith('.zip')) return extractZipBinary(archive, binaryFileName);
  throw new Error(`unsupported archive format: ${archiveName}`);
}

function versionOutputMatches(name, version, output) {
  const labels = name === 'rg' ? ['ripgrep'] : [name];
  const firstLine = String(output || '').trim().split(/\r?\n/, 1)[0]?.toLowerCase();
  return labels.some(label => firstLine === `${label} ${version}`.toLowerCase()
    || firstLine.startsWith(`${label} ${version} `));
}

function replaceManagedBinary(temporary, installedPath, platform) {
  if (platform !== 'win32' || !existsSync(installedPath)) {
    renameSync(temporary, installedPath);
    return;
  }
  const backup = `${installedPath}.${process.pid}.${Date.now()}.backup`;
  renameSync(installedPath, backup);
  try {
    renameSync(temporary, installedPath);
    rmSync(backup, { force: true });
  } catch (error) {
    try { renameSync(backup, installedPath); } catch {}
    throw error;
  }
}

async function installOne(name, options) {
  const { yeaftDir, platform, arch, env, fetchFn, timeoutMs, lockWaitMs } = options;
  let managed = inspectManagedBinary(name, { yeaftDir, platform, arch });
  if (managed.valid) return { name, status: 'available', path: managed.path };
  if (!managed.exists) {
    const external = resolveExternalCommand(name, { yeaftDir, platform, env });
    if (external) return { name, status: 'available', path: external, source: 'system' };
  }

  const asset = selectAsset(name, platform, arch);
  if (!asset) return { name, status: 'unsupported', platform, arch };

  const binDir = managedCliBinDir(yeaftDir);
  mkdirSync(binDir, { recursive: true, mode: 0o755 });
  const installedPath = managed.path;
  const lockDir = join(binDir, `.install-${name}.lock`);
  const acquired = await acquireLock(lockDir, lockWaitMs, () => (
    inspectManagedBinary(name, { yeaftDir, platform, arch }).valid
  ));
  if (!acquired) {
    managed = inspectManagedBinary(name, { yeaftDir, platform, arch });
    return managed.valid
      ? { name, status: 'available', path: managed.path }
      : { name, status: 'busy' };
  }

  try {
    managed = inspectManagedBinary(name, { yeaftDir, platform, arch });
    if (managed.valid) return { name, status: 'available', path: managed.path };
    if (!managed.exists) {
      const external = resolveExternalCommand(name, { yeaftDir, platform, env });
      if (external) return { name, status: 'available', path: external, source: 'system' };
    }
    const archive = await downloadArchive(asset, fetchFn, timeoutMs);
    const binary = extractManagedCliBinary(archive, asset.fileName, name, platform);
    if (binary.length === 0) throw new Error('archive contained an empty binary');
    const temporary = `${installedPath}.${process.pid}.${Date.now()}.tmp`;
    try {
      writeFileSync(temporary, binary, { mode: 0o755, flag: 'wx' });
      if (platform !== 'win32') chmodSync(temporary, 0o755);
      const verification = spawnSync(temporary, ['--version'], {
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true,
      });
      if (verification.error || verification.status !== 0
        || !versionOutputMatches(name, asset.version, verification.stdout)) {
        throw new Error(`installed ${name} binary failed its version check`);
      }
      replaceManagedBinary(temporary, installedPath, platform);
    } finally {
      rmSync(temporary, { force: true });
    }
    const binarySha256 = hashFile(installedPath);
    await updateState(yeaftDir, state => ({
      ...state,
      version: 2,
      updatedAt: Date.now(),
      installations: {
        ...(state.installations && typeof state.installations === 'object'
          ? state.installations
          : {}),
        [name]: {
          version: asset.version,
          platform,
          arch,
          assetFileName: asset.fileName,
          archiveSha256: asset.sha256,
          binarySha256,
        },
      },
    }));
    return {
      name,
      status: 'installed',
      path: installedPath,
      version: asset.version,
      binarySha256,
    };
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

export function ensureManagedCliTools(options = {}) {
  const yeaftDir = resolve(options.yeaftDir || DEFAULT_ROOT);
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  const env = options.env || process.env;

  const flightKey = `${yeaftDir}:${platform}:${arch}`;
  if (installFlights.has(flightKey)) return installFlights.get(flightKey);

  const toolReady = Object.fromEntries(Object.keys(TOOL_SPECS).map(name => {
    let resolveReady;
    const promise = new Promise(resolveTool => { resolveReady = resolveTool; });
    return [name, { promise, resolve: resolveReady }];
  }));
  const skipInstall = options.skipInstall || env.YEAFT_SKIP_MANAGED_CLI_INSTALLS === 'true';

  const flight = (async () => {
    mkdirSync(yeaftDir, { recursive: true, mode: 0o755 });
    const now = typeof options.now === 'function' ? options.now() : Date.now();
    const state = readState(yeaftDir);
    const failures = state.failures && typeof state.failures === 'object' ? { ...state.failures } : {};
    const fetchFn = options.fetchFn || globalThis.fetch;
    const timeoutMs = Number.isFinite(options.timeoutMs)
      ? Math.max(1000, options.timeoutMs)
      : DOWNLOAD_TIMEOUT_MS;
    const lockWaitMs = Number.isFinite(options.lockWaitMs)
      ? Math.max(0, options.lockWaitMs)
      : LOCK_WAIT_MS;

    const results = await Promise.all(Object.keys(TOOL_SPECS).map(async name => {
      let result;
      try {
        if (skipInstall) {
          result = { name, status: 'skipped' };
        } else {
          const managed = inspectManagedBinary(name, { yeaftDir, platform, arch });
          const external = managed.exists
            ? null
            : resolveExternalCommand(name, { yeaftDir, platform, env });
          if (managed.valid) {
            result = { name, status: 'available', path: managed.path };
          } else if (external) {
            result = { name, status: 'available', path: external, source: 'system' };
          } else {
            const failure = failures[name];
            if (!options.force && Number.isFinite(failure?.at) && now - failure.at < FAILURE_COOLDOWN_MS) {
              result = { name, status: 'cooldown', reason: failure.reason };
            } else if (typeof fetchFn !== 'function') {
              result = { name, status: 'failed', reason: 'fetch is unavailable' };
            } else {
              try {
                result = await installOne(name, {
                  yeaftDir, platform, arch, env, fetchFn, timeoutMs, lockWaitMs,
                });
              } catch (error) {
                result = { name, status: 'failed', reason: error?.message || String(error) };
              }
            }
          }
        }
        return result;
      } finally {
        toolReady[name].resolve(result || { name, status: 'failed', reason: 'setup did not complete' });
      }
    }));

    for (const result of results) {
      if (result.status === 'failed') {
        failures[result.name] = { at: now, reason: result.reason || result.status };
      } else if (result.status !== 'busy') {
        delete failures[result.name];
      }
    }
    try {
      await updateState(yeaftDir, state => ({
        ...state,
        version: 2,
        updatedAt: now,
        failures,
        installations: state.installations && typeof state.installations === 'object'
          ? state.installations
          : {},
      }));
    } catch {
      // Tool installation remains usable when the diagnostic state is unwritable.
    }
    return results;
  })();

  flight.toolReady = Object.fromEntries(
    Object.entries(toolReady).map(([name, entry]) => [name, entry.promise]),
  );
  installFlights.set(flightKey, flight);
  flight.finally(() => {
    for (const [name, entry] of Object.entries(toolReady)) {
      entry.resolve({ name, status: 'failed', reason: 'setup did not complete' });
    }
    installFlights.delete(flightKey);
  }).catch(() => {});
  return flight;
}

export function managedCliToolReady(ready, name) {
  return ready?.toolReady?.[name] || ready || Promise.resolve([]);
}

function removeRuntimePathDirectory(path) {
  try { chmodSync(path, 0o700); } catch {}
  try { rmSync(path, { recursive: true, force: true }); } catch {}
  if (!existsSync(path)) runtimePathDirectories.delete(path);
}

export function cleanupManagedCliRuntimePaths() {
  for (const directory of [...runtimePathDirectories]) {
    removeRuntimePathDirectory(directory);
  }
}

/**
 * Run shutdown work only after managed CLI runtime paths are synchronously
 * cleaned. The returned task may remain pending without delaying that cleanup.
 */
export function runAfterManagedCliRuntimeCleanup(task) {
  cleanupManagedCliRuntimePaths();
  return task();
}

function registerRuntimePathDirectory(path) {
  runtimePathDirectories.add(path);
  if (runtimePathCleanupRegistered) return;
  runtimePathCleanupRegistered = true;
  process.once('exit', cleanupManagedCliRuntimePaths);
}

function createIsolatedManagedCommand(name, managed, platform) {
  const binDir = mkdtempSync(join(tmpdir(), 'yeaft-managed-cli-'));
  const command = join(binDir, executableName(name, platform));
  const temporary = `${command}.tmp`;
  try {
    copyFileSync(managed.path, temporary, constants.COPYFILE_EXCL);
    if (platform !== 'win32') chmodSync(temporary, 0o500);
    if (hashFile(temporary) !== managed.binarySha256) {
      throw new Error(`managed ${name} changed while preparing its runtime command`);
    }
    renameSync(temporary, command);
    const verification = spawnSync(command, ['--version'], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    });
    if (verification.error || verification.status !== 0
      || !versionOutputMatches(name, TOOL_SPECS[name].version, verification.stdout)) {
      throw new Error(`isolated managed ${name} failed its version check`);
    }
    if (platform !== 'win32') chmodSync(binDir, 0o500);
    registerRuntimePathDirectory(binDir);
    return { binDir, command };
  } catch (error) {
    rmSync(temporary, { force: true });
    removeRuntimePathDirectory(binDir);
    throw error;
  }
}

/**
 * Wait for one managed command and expose it to child processes through an
 * isolated PATH directory. The directory contains only the checksum-verified
 * command, so unrelated files in the shared managed bin directory stay hidden.
 */
export async function prepareManagedCliToolEnvironment(
  ready,
  name,
  options = {},
) {
  const yeaftDir = resolve(options.yeaftDir || DEFAULT_ROOT);
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  const env = options.env || process.env;
  await managedCliToolReady(ready, name);

  const managed = inspectManagedBinary(name, { yeaftDir, platform, arch });
  if (!managed.valid) {
    const command = resolveExternalCommand(name, { yeaftDir, platform, env });
    return { name, activated: false, command };
  }

  const isolated = createIsolatedManagedCommand(name, managed, platform);
  prependDirectoryToPath(isolated.binDir, env, platform);
  return { name, activated: true, ...isolated };
}

export function summarizeManagedCliResults(results) {
  return (results || []).map(result => {
    const detail = result.path || result.reason || `${result.platform || ''}-${result.arch || ''}`;
    return `${result.name}:${result.status}${detail ? `(${detail})` : ''}`;
  }).join(', ');
}

export const managedCliToolSpecs = TOOL_SPECS;
