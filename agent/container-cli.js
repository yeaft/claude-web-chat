#!/usr/bin/env node
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  createContainerAgent,
  inspectContainerAgent,
  logsContainerAgent,
  readSecretInput,
  removeContainerAgent,
  startContainerAgent,
  stopContainerAgent,
  writeAgentSecretFile,
} from './container-manager.js';

function help() {
  console.log(`
Usage:
  yeaft-agent container create --server <ws-url> --name <name> (--secret <value> | --secret-file <path>) [--image <image>]
  yeaft-agent container start|stop|status|remove|logs --name <name>

The container is an ordinary yeaft-agent. This command only manages its Docker lifecycle.
Use --keep-volumes with remove to preserve its Yeaft data and workspace volumes.
`);
}

export function parseContainerArgs(args) {
  const options = {};
  const positionals = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--keep-volumes' || arg === '--follow') {
      options[arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = true;
      continue;
    }
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
    options[arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
  }
  return { action: positionals[0], options };
}

export async function runContainerCli(args) {
  if (args.length === 0 || args[0] === 'help' || args[0] === '--help' || args[0] === '-h') return help();
  const { action, options } = parseContainerArgs(args);
  const name = options.name;
  let result;
  if (action === 'create') {
    const secret = await readSecretInput(options);
    const secretFile = options.secretFile
      ? resolve(options.secretFile)
      : join(homedir(), '.yeaft', 'container-agents', name, 'agent-secret');
    await writeAgentSecretFile(secretFile, secret);
    result = await createContainerAgent({
      name,
      serverUrl: options.server,
      secretFile,
      image: options.image,
    });
  } else if (action === 'start') {
    result = await startContainerAgent(name);
  } else if (action === 'stop') {
    result = await stopContainerAgent(name);
  } else if (action === 'status') {
    result = await inspectContainerAgent(name);
  } else if (action === 'remove') {
    result = await removeContainerAgent(name, { removeVolumes: !options.keepVolumes });
  } else if (action === 'logs') {
    result = await logsContainerAgent(name, { follow: options.follow });
    if (!options.follow && result.stdout) console.log(result.stdout);
    return;
  } else {
    throw new Error(`Unknown container action: ${action}`);
  }
  console.log(JSON.stringify({ name, ...result }, null, 2));
}

if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {
  runContainerCli(process.argv.slice(2)).catch(error => {
    console.error(`Container Agent failed: ${error.code || error.message}`);
    process.exitCode = 1;
  });
}
