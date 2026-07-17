import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

function descriptorMatchesPath(descriptor, filePath, type) {
  const descriptorStat = fstatSync(descriptor);
  const pathStat = lstatSync(filePath);
  if (pathStat.isSymbolicLink()
    || descriptorStat.dev !== pathStat.dev
    || descriptorStat.ino !== pathStat.ino
    || (type === 'directory' && !descriptorStat.isDirectory())
    || (type === 'file' && !descriptorStat.isFile())) {
    throw new Error('Workspace file identity changed');
  }
  return descriptorStat;
}

function openWorkspaceRoot(workspaceRoot) {
  const root = resolve(workspaceRoot);
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(root) !== root) {
    throw new Error('Workspace root must be a canonical directory');
  }
  const descriptor = openSync(
    root,
    constants.O_RDONLY | (constants.O_DIRECTORY || 0) | (constants.O_NOFOLLOW || 0),
  );
  try {
    descriptorMatchesPath(descriptor, root, 'directory');
    return { root, descriptor };
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

function relativeComponents(relativePath) {
  if (typeof relativePath !== 'string' || !relativePath || isAbsolute(relativePath)) {
    throw new Error('Workspace file path must be relative');
  }
  const components = relativePath.split(/[\\/]+/);
  if (components.some(component => !component || component === '.' || component === '..')) {
    throw new Error('Workspace file path is invalid');
  }
  return components;
}

function withWorkspaceNode(workspaceRoot, relativePath, type, callback) {
  if (process.platform !== 'linux') return null;
  let rootState;
  const directoryStates = [];
  let targetDescriptor;
  try {
    rootState = openWorkspaceRoot(workspaceRoot);
    let parentDescriptor = rootState.descriptor;
    let actualParentPath = rootState.root;
    const components = relativeComponents(relativePath);
    for (const component of components.slice(0, -1)) {
      const descriptorPath = `/proc/self/fd/${parentDescriptor}/${component}`;
      const actualPath = resolve(actualParentPath, component);
      const descriptor = openSync(
        descriptorPath,
        constants.O_RDONLY | (constants.O_DIRECTORY || 0) | (constants.O_NOFOLLOW || 0),
      );
      directoryStates.push({ descriptor, path: actualPath });
      descriptorMatchesPath(descriptor, actualPath, 'directory');
      parentDescriptor = descriptor;
      actualParentPath = actualPath;
    }
    const nodeName = components.at(-1);
    const descriptorPath = `/proc/self/fd/${parentDescriptor}/${nodeName}`;
    const actualPath = resolve(actualParentPath, nodeName);
    const flags = constants.O_RDONLY | (type === 'directory' ? (constants.O_DIRECTORY || 0) : 0)
      | (constants.O_NOFOLLOW || 0);
    targetDescriptor = openSync(descriptorPath, flags);
    const stat = descriptorMatchesPath(targetDescriptor, actualPath, type);
    const result = callback(targetDescriptor, stat);
    descriptorMatchesPath(targetDescriptor, actualPath, type);
    for (const state of directoryStates) {
      descriptorMatchesPath(state.descriptor, state.path, 'directory');
    }
    descriptorMatchesPath(rootState.descriptor, rootState.root, 'directory');
    return result;
  } catch {
    return null;
  } finally {
    if (targetDescriptor !== undefined) closeSync(targetDescriptor);
    for (const state of directoryStates.reverse()) closeSync(state.descriptor);
    if (rootState?.descriptor !== undefined) closeSync(rootState.descriptor);
  }
}

function withWorkspaceFile(workspaceRoot, relativePath, callback) {
  return withWorkspaceNode(workspaceRoot, relativePath, 'file', callback);
}

export function listWorkspaceDirectory(workspaceRoot, relativePath) {
  return withWorkspaceNode(workspaceRoot, relativePath, 'directory', descriptor => (
    readdirSync(`/proc/self/fd/${descriptor}`, { withFileTypes: true }).map(entry => ({
      name: entry.name,
      isFile: entry.isFile(),
      isDirectory: entry.isDirectory(),
      isSymbolicLink: entry.isSymbolicLink(),
    }))
  ));
}

export function statWorkspaceFile(workspaceRoot, relativePath) {
  return withWorkspaceFile(workspaceRoot, relativePath, (_descriptor, stat) => ({
    path: resolve(workspaceRoot, relativePath),
    mtimeMs: stat.mtimeMs,
    size: stat.size,
  }));
}

export function readWorkspaceFile(workspaceRoot, relativePath, options = {}) {
  return withWorkspaceFile(workspaceRoot, relativePath, (descriptor, stat) => {
    const requestedLimit = Number(options.maxBytes);
    const bounded = Number.isFinite(requestedLimit) && requestedLimit >= 0;
    const capacity = bounded ? requestedLimit + 1 : stat.size;
    const buffer = Buffer.allocUnsafe(Math.max(0, capacity));
    let offset = 0;
    while (offset < buffer.length) {
      const bytesRead = readSync(descriptor, buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return {
      path: resolve(workspaceRoot, relativePath),
      mtimeMs: stat.mtimeMs,
      buffer: buffer.subarray(0, offset),
      truncated: bounded && offset > requestedLimit,
    };
  });
}
