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

  it('enables Browser setup routes by default while preserving an explicit global off switch', () => {
    const config = readFileSync(resolve(root, 'server/config.js'), 'utf8');
    const example = readFileSync(resolve(root, 'server/.env.example'), 'utf8');

    expect(config).toContain("enabled: process.env.BROWSER_RUNTIME_ENABLED !== 'false'");
    expect(example).toContain('set false to disable them globally');
  });

  it('ships a separate authenticated TURN relay deployment for remote Browser viewers', () => {
    const compose = readFileSync(resolve(root, 'deploy/browser-turn/docker-compose.yaml'), 'utf8');
    const dockerfile = readFileSync(resolve(root, 'deploy/browser-turn/Dockerfile'), 'utf8');
    const startup = readFileSync(resolve(root, 'deploy/browser-turn/start-turn.sh'), 'utf8');
    const healthcheck = readFileSync(resolve(root, 'deploy/browser-turn/healthcheck.sh'), 'utf8');
    const guide = readFileSync(resolve(root, 'deploy/browser-turn/README.md'), 'utf8');
    const packageJson = readFileSync(resolve(root, 'package.json'), 'utf8');

    expect(dockerfile).toContain('FROM coturn/coturn:4.17.2-r0@sha256:aa68aab64a3b929d57fc2924c98ea447bf996cf8dade2508e7b71eaf23f1f14e');
    expect(dockerfile).toContain('USER 10001:10001');
    expect(compose).toContain('network_mode: host');
    expect(compose).toContain('user: "10001:10001"');
    expect(compose).toContain('BROWSER_TURN_SECRET_FILE');
    expect(compose).toContain('no-new-privileges:true');
    expect(compose).toContain('cap_drop:');
    expect(compose).toContain('      - ALL');
    expect(compose).not.toContain('cap_add:');
    expect(compose).toContain('/run/yeaft-turn:rw,nosuid,nodev,size=16m,uid=10001,gid=10001,mode=0700');
    expect(startup).not.toContain('setpriv');
    expect(startup).toContain('exec /usr/local/bin/yeaft-turnserver');
    expect(healthcheck).toContain('^Uid:|^Gid:|^CapInh:|^CapPrm:|^CapEff:|^CapBnd:|^CapAmb:|^NoNewPrivs:');
    expect(healthcheck).toContain('turnutils_stunclient');
    expect(startup).toContain('use-auth-secret');
    expect(startup).toContain('static-auth-secret=$secret');
    expect(startup).toContain('external-ip=$external_ip/$relay_ip');
    expect(guide).toContain('BROWSER_ICE_TRANSPORT_POLICY=relay');
    expect(guide).toContain('BROWSER_TURN_SECRET_GID');
    expect(guide).toContain('49160-49200/udp');
    expect(packageJson).toContain('"smoke:browser-turn": "node scripts/smoke-browser-turn.mjs"');
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
