import { readBrowserExecutableVersion } from '../../agent/browser-runtime/browser-install.js';

const executablePath = process.argv[2];
const startedAt = Date.now();
const version = await readBrowserExecutableVersion(executablePath, {
  gracefulTerminationDeadline: startedAt + 100,
  terminationDeadline: startedAt + 750,
});
process.stdout.write(`${version}\n`);
