import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');

describe('Server production image runtime closure', () => {
  it('includes the Docker client and shared lifecycle module used by the Server', () => {
    const dockerfile = readFileSync(resolve(root, 'Dockerfile'), 'utf8');
    const service = readFileSync(resolve(root, 'server/container-agent-service.js'), 'utf8');

    expect(service).toContain("from '../agent/container-manager.js'");
    expect(dockerfile).toContain('RUN apk add --no-cache docker-cli');
    expect(dockerfile).toContain('COPY agent/container-manager.js ./agent/container-manager.js');
  });

  it('keeps Docker socket access opt-in with an explicit Sandbox compose override', () => {
    const baseCompose = readFileSync(resolve(root, 'docker-compose.yml'), 'utf8');
    const sandboxCompose = readFileSync(resolve(root, 'docker-compose.sandbox.yml'), 'utf8');

    const webchatService = baseCompose.slice(
      baseCompose.indexOf('  webchat:'),
      baseCompose.indexOf('  watchtower:'),
    );
    expect(webchatService).not.toContain('/var/run/docker.sock:/var/run/docker.sock');
    expect(webchatService).toContain('- server/.env');
    expect(sandboxCompose).toContain('SANDBOX_ENABLED: "true"');
    expect(sandboxCompose).toContain('/var/run/docker.sock:/var/run/docker.sock');
    expect(sandboxCompose).toContain('${SANDBOX_STATE_DIR:-/var/lib/yeaft/container-agents}:${SANDBOX_STATE_DIR:-/var/lib/yeaft/container-agents}');
  });
});
