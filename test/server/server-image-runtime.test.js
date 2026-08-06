import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');

describe('Server production image runtime closure', () => {
  it('copies the Docker Agent lifecycle module imported by the Server', () => {
    const dockerfile = readFileSync(resolve(root, 'Dockerfile'), 'utf8');
    const service = readFileSync(resolve(root, 'server/container-agent-service.js'), 'utf8');

    expect(service).toContain("from '../agent/container-manager.js'");
    expect(dockerfile).toContain('COPY agent/container-manager.js ./agent/container-manager.js');
  });
});
