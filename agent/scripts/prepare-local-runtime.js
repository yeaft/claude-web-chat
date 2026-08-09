import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const scriptPath = fileURLToPath(import.meta.url);
const defaultAgentDir = join(dirname(scriptPath), '..');

/**
 * Build the Server and Web payload embedded in the published Agent package.
 * Server imports that cross into agent/ must be copied explicitly so the
 * packaged local runtime has the same module boundary as the source tree.
 */
export function prepareLocalRuntime({
  agentDir = defaultAgentDir,
  rootDir = join(agentDir, '..'),
  runtimeDir = join(agentDir, 'local-runtime'),
} = {}) {
  rmSync(runtimeDir, { recursive: true, force: true });
  mkdirSync(runtimeDir, { recursive: true });
  const excludedServerPaths = new Set([
    join(rootDir, 'server', 'node_modules'),
    join(rootDir, 'server', 'data'),
    join(rootDir, 'server', '.env'),
    join(rootDir, 'server', 'user.json'),
    join(rootDir, 'server', 'users.json'),
  ]);
  cpSync(join(rootDir, 'server'), join(runtimeDir, 'server'), {
    recursive: true,
    filter: source => !excludedServerPaths.has(source),
  });
  cpSync(join(rootDir, 'web', 'dist'), join(runtimeDir, 'web'), { recursive: true });

  const runtimeAgentDir = join(runtimeDir, 'agent');
  mkdirSync(runtimeAgentDir, { recursive: true });
  cpSync(join(agentDir, 'container-manager.js'), join(runtimeAgentDir, 'container-manager.js'));

  const { version } = JSON.parse(readFileSync(join(agentDir, 'package.json'), 'utf8'));
  writeFileSync(join(runtimeDir, 'version.json'), `${JSON.stringify({ version })}\n`);
  return runtimeDir;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(scriptPath)) {
  prepareLocalRuntime();
}
