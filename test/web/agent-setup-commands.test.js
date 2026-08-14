import { describe, expect, it } from 'vitest';
import {
  getAgentContainerCommand,
  getAgentName,
  getAgentServiceCommand,
} from '../../web/utils/agentSetup.js';

describe('agent setup commands', () => {
  const profile = { username: 'alice', displayName: 'Alice' };

  it('renders a container install command with the secret passed as an argument', () => {
    const command = getAgentContainerCommand({
      profile,
      agentSecret: 'secret-abc',
      serverWsUrl: 'wss://example.test',
    });
    expect(command).toBe(
      `yeaft-agent container install --server wss://example.test --secret secret-abc --name ${getAgentName(profile)}`,
    );
    expect(command).not.toContain('--secret-file');
  });

  it('derives the same agent name as the service command', () => {
    const service = getAgentServiceCommand({ profile, agentSecret: 'secret-abc', serverWsUrl: 'wss://example.test' });
    const container = getAgentContainerCommand({ profile, agentSecret: 'secret-abc', serverWsUrl: 'wss://example.test' });
    expect(service.split('--name ')[1]).toBe(container.split('--name ')[1]);
  });

  it('returns an empty command until a secret exists', () => {
    expect(getAgentContainerCommand({ profile, agentSecret: '', serverWsUrl: 'wss://example.test' })).toBe('');
  });
});
