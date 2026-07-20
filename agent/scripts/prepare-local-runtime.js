import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const agentDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const rootDir = join(agentDir, '..');
const runtimeDir = join(agentDir, 'local-runtime');

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

const { version } = JSON.parse(readFileSync(join(agentDir, 'package.json'), 'utf8'));
writeFileSync(join(runtimeDir, 'version.json'), `${JSON.stringify({ version })}\n`);
