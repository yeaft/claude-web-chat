import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDir = dirname(fileURLToPath(import.meta.url));
export const BROWSER_EXTENSION_DIR = join(moduleDir, 'extension');
export const BROWSER_EXTENSION_NAME = 'Yeaft Browser Runtime';
export const BROWSER_EXTENSION_SHA256 = '51cc6519ec9f72f86af7a0a98c3511c32e0e8fde6e8e3406886e7048f0c5972e';

async function walkFiles(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) files.push(...await walkFiles(root, path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

/**
 * Hash the exact extension package before loading it. The digest is diagnostic
 * evidence and a tamper fence, not a substitute for package signing.
 */
export async function hashBrowserExtension(root = BROWSER_EXTENSION_DIR, { expectedDigest = null } = {}) {
  const directory = await stat(root);
  if (!directory.isDirectory()) throw new Error('Browser Runtime extension path is not a directory');
  const hash = createHash('sha256');
  const files = (await walkFiles(root)).sort();
  if (files.length === 0) throw new Error('Browser Runtime extension is empty');
  for (const path of files) {
    const name = relative(root, path).replaceAll('\\', '/');
    const data = await readFile(path);
    hash.update(`${name}\0${data.byteLength}\0`);
    hash.update(data);
  }
  const digest = hash.digest('hex');
  if (expectedDigest && digest !== expectedDigest) {
    const error = new Error('Browser Runtime extension digest mismatch');
    error.code = 'extension_digest_mismatch';
    throw error;
  }
  return { digest, fileCount: files.length, root };
}
