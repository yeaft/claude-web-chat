import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildCreateArgs,
  checkContainerAgentRuntime,
  containerNameForAgent,
  runDocker,
  writeAgentSecretFile,
} from '../../agent/container-manager.js';

function spawnResult({ code = 0, stdout = '', stderr = '' } = {}) {
  return (_command, _args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => {
      if (stdout) child.stdout.emit('data', Buffer.from(stdout));
      if (stderr) child.stderr.emit('data', Buffer.from(stderr));
      child.emit('close', code);
    });
    return child;
  };
}

describe('container Agent manager', () => {
  it('builds a fixed Docker Agent container without putting the secret in argv or Env', () => {
    const args = buildCreateArgs({
      name: 'remote-worker',
      serverUrl: 'wss://example.test',
      secretFile: '/tmp/agent-secret',
      image: 'example/agent:1',
    });
    expect(args).toContain('SERVER_URL=wss://example.test');
    expect(args).toContain('AGENT_SECRET_FILE=/run/yeaft-host-secret');
    expect(args.some(arg => arg.includes('dst=/run/yeaft-host-secret,readonly'))).toBe(true);
    expect(args.join(' ')).not.toContain('top-secret');
    expect(args).toContain('example/agent:1');
    expect(containerNameForAgent('remote-worker')).toBe('yeaft-agent-remote-worker');
  });

  it('writes a private secret file for the read-only container bind', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'yeaft-container-agent-'));
    const path = await writeAgentSecretFile(join(dir, 'secret'), 'top-secret');
    expect(await readFile(path, 'utf8')).toBe('top-secret\n');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it('executes Docker without a shell and returns bounded process output', async () => {
    const result = await runDocker(['inspect', 'name'], { spawnImpl: spawnResult({ stdout: 'ok\n' }) });
    expect(result).toEqual({ code: 0, stdout: 'ok', stderr: '' });
  });

  it('checks both the Docker client and daemon before advertising availability', async () => {
    const calls = [];
    const result = await checkContainerAgentRuntime({
      spawnImpl: (command, args) => {
        calls.push([command, args]);
        return spawnResult({ stdout: '28.5.1\n' })(command, args);
      },
    });

    expect(calls).toEqual([['docker', ['version', '--format', '{{.Server.Version}}']]]);
    expect(result).toEqual({ serverVersion: '28.5.1' });
  });
});
