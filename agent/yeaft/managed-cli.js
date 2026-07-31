import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  accessSync,
  chmodSync,
  constants,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, join, resolve } from 'node:path';
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

export function prependManagedCliBinToPath(yeaftDir = DEFAULT_ROOT, env = process.env, platform = process.platform) {
  const binDir = managedCliBinDir(yeaftDir);
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

export function resolveManagedCliCommand(name, options = {}) {
  const spec = TOOL_SPECS[name];
  if (!spec) return null;
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const yeaftDir = options.yeaftDir || DEFAULT_ROOT;
  const managedPath = join(managedCliBinDir(yeaftDir), executableName(name, platform));
  if (canExecute(managedPath, platform)) return managedPath;

  for (const commandName of [name, ...(spec.aliases || [])]) {
    for (const candidate of pathCandidates(commandName, { env, platform })) {
      if (canExecute(candidate, platform)) return candidate;
    }
  }
  return null;
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

async function acquireLock(lockDir, installedPath, platform) {
  const startedAt = Date.now();
  for (;;) {
    try {
      mkdirSync(lockDir);
      return true;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (canExecute(installedPath, platform)) return false;
      try {
        if (Date.now() - statSync(lockDir).mtimeMs > LOCK_STALE_MS) {
          rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() - startedAt >= LOCK_WAIT_MS) return false;
      await sleep(250);
    }
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

async function installOne(name, options) {
  const { yeaftDir, platform, arch, env, fetchFn, timeoutMs } = options;
  const existing = resolveManagedCliCommand(name, { yeaftDir, platform, env });
  if (existing) return { name, status: 'available', path: existing };

  const asset = selectAsset(name, platform, arch);
  if (!asset) return { name, status: 'unsupported', platform, arch };

  const binDir = managedCliBinDir(yeaftDir);
  mkdirSync(binDir, { recursive: true, mode: 0o755 });
  const installedPath = join(binDir, executableName(name, platform));
  const lockDir = join(binDir, `.install-${name}.lock`);
  const acquired = await acquireLock(lockDir, installedPath, platform);
  if (!acquired) {
    const path = resolveManagedCliCommand(name, { yeaftDir, platform, env });
    return path
      ? { name, status: 'available', path }
      : { name, status: 'busy' };
  }

  try {
    const rechecked = resolveManagedCliCommand(name, { yeaftDir, platform, env });
    if (rechecked) return { name, status: 'available', path: rechecked };
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
      if (verification.error || verification.status !== 0) {
        throw new Error(`installed ${name} binary failed its version check`);
      }
      renameSync(temporary, installedPath);
    } finally {
      rmSync(temporary, { force: true });
    }
    return { name, status: 'installed', path: installedPath, version: asset.version };
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

export function ensureManagedCliTools(options = {}) {
  const yeaftDir = resolve(options.yeaftDir || DEFAULT_ROOT);
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  const env = options.env || process.env;

  prependManagedCliBinToPath(yeaftDir, env, platform);
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

    const results = await Promise.all(Object.keys(TOOL_SPECS).map(async name => {
      let result;
      try {
        if (skipInstall) {
          result = { name, status: 'skipped' };
        } else {
          const existing = resolveManagedCliCommand(name, { yeaftDir, platform, env });
          if (existing) {
            result = { name, status: 'available', path: existing };
          } else {
            const failure = failures[name];
            if (!options.force && Number.isFinite(failure?.at) && now - failure.at < FAILURE_COOLDOWN_MS) {
              result = { name, status: 'cooldown', reason: failure.reason };
            } else if (typeof fetchFn !== 'function') {
              result = { name, status: 'failed', reason: 'fetch is unavailable' };
            } else {
              try {
                result = await installOne(name, { yeaftDir, platform, arch, env, fetchFn, timeoutMs });
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
      if (result.status === 'failed' || result.status === 'busy') {
        failures[result.name] = { at: now, reason: result.reason || result.status };
      } else {
        delete failures[result.name];
      }
    }
    try {
      writeState(yeaftDir, { version: 1, updatedAt: now, failures });
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

export function summarizeManagedCliResults(results) {
  return (results || []).map(result => {
    const detail = result.path || result.reason || `${result.platform || ''}-${result.arch || ''}`;
    return `${result.name}:${result.status}${detail ? `(${detail})` : ''}`;
  }).join(', ');
}

export const managedCliToolSpecs = TOOL_SPECS;
