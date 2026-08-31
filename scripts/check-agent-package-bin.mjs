#!/usr/bin/env node
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, posix, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * Validate the executable entries that npm will publish for the Agent package.
 * npm 11 rejects bin targets with a leading "./" instead of normalizing them.
 *
 * @param {string} agentDir
 * @param {{ platform?: string }} [options]
 * @returns {Promise<string[]>}
 */
export async function validateAgentPackageBins(agentDir, { platform = process.platform } = {}) {
  const packagePath = resolve(agentDir, 'package.json');
  const manifest = JSON.parse(readFileSync(packagePath, 'utf8'));
  const bins = manifest.bin;
  const errors = [];

  if (!bins || typeof bins !== 'object' || Array.isArray(bins) || Object.keys(bins).length === 0) {
    return ['agent/package.json must declare at least one bin entry'];
  }

  for (const [name, target] of Object.entries(bins)) {
    const label = `bin[${JSON.stringify(name)}]`;
    if (typeof target !== 'string' || target.length === 0) {
      errors.push(`${label} must be a non-empty string`);
      continue;
    }
    if (target.startsWith('./') || target.includes('\\') || isAbsolute(target) || win32.isAbsolute(target)
      || posix.normalize(target) !== target || target.startsWith('../')) {
      errors.push(`${label} target ${JSON.stringify(target)} must be a normalized package-relative POSIX path without "./"`);
      continue;
    }

    const targetPath = resolve(agentDir, target);
    let stat;
    try {
      stat = statSync(targetPath);
    } catch {
      errors.push(`${label} target ${JSON.stringify(target)} does not exist`);
      continue;
    }
    if (!stat.isFile()) {
      errors.push(`${label} target ${JSON.stringify(target)} is not a file`);
      continue;
    }
    if (platform !== 'win32' && (stat.mode & 0o111) === 0) {
      errors.push(`${label} target ${JSON.stringify(target)} is not executable`);
    }
    const firstLine = readFileSync(targetPath, 'utf8').split(/\r?\n/, 1)[0];
    if (firstLine !== '#!/usr/bin/env node') {
      errors.push(`${label} target ${JSON.stringify(target)} must start with #!/usr/bin/env node`);
    }
  }

  return errors;
}

async function main() {
  const errors = await validateAgentPackageBins(resolve(repoRoot, 'agent'));
  if (errors.length > 0) {
    console.error(`Agent package bin validation failed:\n- ${errors.join('\n- ')}`);
    process.exitCode = 1;
    return;
  }
  console.log('Agent package bin entries are publishable.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
