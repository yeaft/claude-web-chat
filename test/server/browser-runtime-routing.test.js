import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  agents,
  webClients,
  sendToAgent,
  sendToWebClient,
  broadcastAgentList,
} = vi.hoisted(() => ({
  agents: new Map(),
  webClients: new Map(),
  sendToAgent: vi.fn(async () => {}),
  sendToWebClient: vi.fn(async () => {}),
  broadcastAgentList: vi.fn(async () => {}),
}));

vi.mock('../../server/context.js', () => ({ agents, webClients }));
vi.mock('../../server/ws-utils.js', () => ({ sendToAgent, sendToWebClient, broadcastAgentList }));

const { CONFIG } = await import('../../server/config.js');
const { handleClientBrowser } = await import('../../server/handlers/client-browser.js');
const { handleAgentBrowser } = await import('../../server/handlers/agent-browser.js');
const { handleAgentSync } = await import('../../server/handlers/agent-sync.js');
const {
  __testResetBrowserRuntimeRoutes,
  browserPeers,
  getBrowserRoute,
} = await import('../../server/browser-runtime-routes.js');

const originalBrowserConfig = { ...CONFIG.browserRuntime };

function client(id, userId = 'user-a') {
  return {
    id,
    userId,
    role: 'pro',
    authenticated: true,
    browserRuntimeProtocol: 1,
    browserRuntimeSetupProtocol: 1,
    connectionId: `connection-${id}`,
    connectionGeneration: `generation-${id}`,
  };
}

function agent(ownerId = 'user-a') {
  return {
    ownerId,
    capabilities: ['browser_runtime', 'browser_webrtc', 'browser_capture_tab'],
  };
}

async function createBrowserSession({ clientRecord, agentId = 'agent-a', requestId = 'client-create' } = {}) {
  const currentClient = clientRecord || client('client-a');
  webClients.set(currentClient.id, currentClient);
  agents.set(agentId, agent(currentClient.userId));
  await handleClientBrowser(currentClient, {
    type: 'browser_session_create',
    agentId,
    requestId,
    serverIdentity: { ownerUserId: 'forged' },
    options: { initialUrl: 'about:blank' },
  }, async () => true);
  const outbound = sendToAgent.mock.calls.at(-1)[1];
  expect(outbound.requestId).not.toBe(requestId);
  await handleAgentBrowser(agentId, agents.get(agentId), {
    type: 'browser_session_created',
    requestId: outbound.requestId,
    browserSessionId: 'browser-session-a',
    revision: 2,
    state: 'ready',
    activeUrl: 'about:blank',
    pageRevision: 1,
    serverIdentity: { ownerUserId: 'must-not-leak' },
    credential: 'must-not-leak',
    arbitraryAgentField: 'must-not-leak',
  });
  return { currentClient, agentId, outbound };
}

beforeEach(() => {
  agents.clear();
  webClients.clear();
  sendToAgent.mockClear();
  sendToWebClient.mockClear();
  broadcastAgentList.mockClear();
  __testResetBrowserRuntimeRoutes();
  Object.assign(CONFIG.browserRuntime, {
    enabled: true,
    iceTransportPolicy: 'all',
    stunUrls: ['stun:stun.example.test:3478'],
    turnUrls: ['turns:turn.example.test:443?transport=tcp'],
    turnSecret: 'test-turn-secret',
    credentialTtlSeconds: 600,
    routeTtlMs: 15 * 60_000,
  });
});

afterEach(() => {
  Object.assign(CONFIG.browserRuntime, originalBrowserConfig);
});

describe('Browser Runtime Server ownership and signaling', () => {
  it('allows setup-capable Agents to report/install without ready capability and targets the exact socket', async () => {
    const requester = client('client-a');
    const sibling = client('client-b', 'user-a');
    webClients.set(requester.id, requester);
    webClients.set(sibling.id, sibling);
    const setupAgent = {
      ownerId: 'user-a',
      capabilities: ['plaintext-ok', 'browser_runtime_setup'],
      encryptOutbound: false,
    };
    agents.set('agent-a', setupAgent);

    await handleClientBrowser(requester, {
      type: 'browser_runtime_status', agentId: 'agent-a', requestId: 'status-a',
    }, async () => true);
    const statusRequest = sendToAgent.mock.calls.at(-1)[1];
    expect(statusRequest).toMatchObject({
      type: 'browser_runtime_status',
      requestId: expect.any(String),
      serverIdentity: expect.objectContaining({ clientId: 'client-a' }),
    });
    expect(statusRequest.requestId).not.toBe('status-a');
    await handleAgentBrowser('agent-a', setupAgent, {
      type: 'browser_runtime_status_result',
      requestId: statusRequest.requestId,
      supported: true,
      state: 'not_installed',
      installed: false,
      enabled: false,
      ready: false,
      buildId: '151.0.7922.71',
      platform: 'linux',
      downloadBytes: 193_285_407,
      credential: 'must-not-leak',
    });
    expect(sendToWebClient).toHaveBeenCalledWith(requester, expect.objectContaining({
      type: 'browser_runtime_status_result',
      requestId: 'status-a',
      agentId: 'agent-a',
      downloadBytes: 193_285_407,
    }));
    expect(sendToWebClient.mock.calls.at(-1)[1]).not.toHaveProperty('credential');
    expect(sendToWebClient.mock.calls.at(-1)[0]).not.toBe(sibling);

    sendToAgent.mockClear();
    sendToWebClient.mockClear();
    await handleClientBrowser(requester, {
      type: 'browser_runtime_install',
      agentId: 'agent-a',
      requestId: 'install-a',
      confirmedBuildId: '151.0.7922.71',
      confirmedDownloadBytes: 193_285_407,
    }, async () => true);
    const installRequest = sendToAgent.mock.calls.at(-1)[1];
    expect(installRequest).toMatchObject({
      type: 'browser_runtime_install',
      confirmedBuildId: '151.0.7922.71',
      confirmedDownloadBytes: 193_285_407,
    });
    await handleAgentBrowser('agent-a', setupAgent, {
      type: 'browser_runtime_install_progress',
      requestId: installRequest.requestId,
      downloadedBytes: 1024,
      totalBytes: 193_285_407,
    });
    expect(sendToWebClient).toHaveBeenCalledWith(requester, expect.objectContaining({
      type: 'browser_runtime_install_progress',
      requestId: 'install-a',
      downloadedBytes: 1024,
    }));
    expect(sendToWebClient.mock.calls.at(-1)[0]).not.toBe(sibling);

    await handleAgentSync('agent-a', setupAgent, {
      type: 'agent_capabilities_updated',
      capabilities: ['plaintext-ok', 'browser_runtime_setup', 'browser_runtime', 'browser_webrtc', 'browser_capture_tab'],
    });
    expect(setupAgent.capabilities).toContain('browser_runtime');
    expect(setupAgent.encryptOutbound).toBe(false);
    expect(broadcastAgentList).toHaveBeenCalledOnce();
  });

  it('uses opaque Server correlation and returns create only to the exact requesting socket', async () => {
    const clientA = client('client-a');
    const clientB = client('client-b');
    webClients.set(clientB.id, clientB);
    const { outbound } = await createBrowserSession({ clientRecord: clientA });

    expect(outbound).toMatchObject({
      type: 'browser_session_create',
      requestId: expect.any(String),
      serverIdentity: {
        ownerUserId: 'user-a',
        clientId: 'client-a',
        webConnectionId: 'connection-client-a',
        webConnectionGeneration: 'generation-client-a',
      },
    });
    expect(outbound.serverIdentity.ownerUserId).not.toBe('forged');
    expect(sendToWebClient).toHaveBeenCalledTimes(1);
    expect(sendToWebClient).toHaveBeenCalledWith(clientA, expect.objectContaining({
      type: 'browser_session_created',
      requestId: 'client-create',
      browserSessionId: 'browser-session-a',
      agentId: 'agent-a',
    }));
    expect(sendToWebClient.mock.calls[0][0]).not.toBe(clientB);
    expect(sendToWebClient.mock.calls[0][1]).not.toHaveProperty('serverIdentity');
    expect(sendToWebClient.mock.calls[0][1]).not.toHaveProperty('credential');
    expect(sendToWebClient.mock.calls[0][1]).not.toHaveProperty('arbitraryAgentField');
    expect(getBrowserRoute('agent-a', 'browser-session-a')).toMatchObject({ ownerUserId: 'user-a' });

    sendToWebClient.mockClear();
    await handleClientBrowser(clientA, {
      type: 'browser_session_create', agentId: 'agent-a', requestId: 'client-create',
      options: { initialUrl: 'about:blank' },
    }, async () => true);
    expect(sendToWebClient).toHaveBeenCalledWith(clientA, expect.objectContaining({
      type: 'browser_session_created', requestId: 'client-create',
    }));
    expect(sendToWebClient.mock.calls[0][1]).not.toHaveProperty('arbitraryAgentField');
    expect(sendToWebClient.mock.calls[0][1]).not.toHaveProperty('credential');
  });

  it('rejects cross-owner attach and same-owner sibling-tab answer', async () => {
    const clientA = client('client-a');
    await createBrowserSession({ clientRecord: clientA });
    sendToAgent.mockClear();
    sendToWebClient.mockClear();

    const intruder = client('client-x', 'user-x');
    webClients.set(intruder.id, intruder);
    await handleClientBrowser(intruder, {
      type: 'browser_peer_attach', agentId: 'agent-a', browserSessionId: 'browser-session-a',
      requestId: 'attach-x', connectionGeneration: 1,
    }, async () => true);
    expect(sendToAgent).not.toHaveBeenCalled();
    expect(sendToWebClient).toHaveBeenCalledWith(intruder, expect.objectContaining({
      code: 'browser_session_not_found',
    }));

    sendToWebClient.mockClear();
    await handleClientBrowser(clientA, {
      type: 'browser_peer_attach', agentId: 'agent-a', browserSessionId: 'browser-session-a',
      requestId: 'attach-a', connectionGeneration: 1,
    }, async () => true);
    const prepare = sendToAgent.mock.calls.at(-1)[1];
    expect(prepare).toMatchObject({
      type: 'browser_peer_prepare',
      peerId: expect.any(String),
      connectionGeneration: 1,
      serverIdentity: expect.objectContaining({ clientId: 'client-a' }),
    });
    expect(prepare.agentIceServers.at(-1).username).toBeTruthy();
    const peer = browserPeers.get(prepare.peerId);
    expect(peer.webIceServers.at(-1).username).not.toBe(prepare.agentIceServers.at(-1).username);

    const firstPeerCount = browserPeers.size;
    sendToAgent.mockClear();
    await handleClientBrowser(clientA, {
      type: 'browser_peer_attach', agentId: 'agent-a', browserSessionId: 'browser-session-a',
      requestId: 'attach-a', connectionGeneration: 1,
    }, async () => true);
    expect(browserPeers.size).toBe(firstPeerCount);
    expect(sendToAgent).not.toHaveBeenCalled();

    const sibling = client('client-b', 'user-a');
    webClients.set(sibling.id, sibling);
    sendToAgent.mockClear();
    await handleClientBrowser(sibling, {
      type: 'browser_peer_answer', agentId: 'agent-a', browserSessionId: 'browser-session-a',
      peerId: prepare.peerId, connectionGeneration: 1,
      description: { type: 'answer', sdp: 'v=0' },
    }, async () => true);
    expect(sendToAgent).not.toHaveBeenCalled();
    expect(sendToWebClient).toHaveBeenCalledWith(sibling, expect.objectContaining({
      code: 'browser_peer_stale',
    }));
  });

  it('holds offer and ICE until prepared, then targets only the peer socket', async () => {
    const clientA = client('client-a');
    const clientB = client('client-b');
    webClients.set(clientB.id, clientB);
    await createBrowserSession({ clientRecord: clientA });
    sendToAgent.mockClear();
    sendToWebClient.mockClear();
    await handleClientBrowser(clientA, {
      type: 'browser_peer_attach', agentId: 'agent-a', browserSessionId: 'browser-session-a',
      requestId: 'attach-a', connectionGeneration: 7,
    }, async () => true);
    const prepare = sendToAgent.mock.calls.at(-1)[1];

    await handleAgentBrowser('agent-a', agents.get('agent-a'), {
      type: 'browser_peer_offer', browserSessionId: 'browser-session-a', peerId: prepare.peerId,
      connectionGeneration: 7, description: { type: 'offer', sdp: 'v=0\no=agent-offer' },
    });
    await handleAgentBrowser('agent-a', agents.get('agent-a'), {
      type: 'browser_peer_ice_candidate', browserSessionId: 'browser-session-a', peerId: prepare.peerId,
      connectionGeneration: 7, candidate: { candidate: 'candidate:1 1 UDP 1 127.0.0.1 1234 typ host' },
    });
    expect(sendToWebClient).not.toHaveBeenCalled();

    await handleAgentBrowser('agent-a', agents.get('agent-a'), {
      type: 'browser_peer_prepared', browserSessionId: 'browser-session-a', peerId: prepare.peerId,
      connectionGeneration: 7,
    });
    expect(sendToWebClient.mock.calls.map(([, message]) => message.type)).toEqual([
      'browser_peer_prepared', 'browser_peer_offer', 'browser_peer_ice_candidate',
    ]);
    expect(sendToWebClient.mock.calls.every(([target]) => target === clientA)).toBe(true);
    expect(sendToWebClient.mock.calls.every(([target]) => target !== clientB)).toBe(true);

    sendToAgent.mockClear();
    await handleClientBrowser(clientA, {
      type: 'browser_peer_answer', agentId: 'agent-a', browserSessionId: 'browser-session-a',
      peerId: prepare.peerId, connectionGeneration: 7,
      description: { type: 'answer', sdp: 'v=0\no=web-answer' },
    }, async () => true);
    expect(sendToAgent).toHaveBeenCalledWith(agents.get('agent-a'), expect.objectContaining({
      type: 'browser_peer_answer', peerId: prepare.peerId, connectionGeneration: 7,
      serverIdentity: expect.objectContaining({ clientId: 'client-a' }),
    }));

    sendToWebClient.mockClear();
    await handleAgentBrowser('agent-a', agents.get('agent-a'), {
      type: 'browser_peer_error', browserSessionId: 'browser-session-a', peerId: prepare.peerId,
      connectionGeneration: 7, code: 'peer_failed', safeError: 'peer failed',
    });
    expect(sendToWebClient).toHaveBeenCalledWith(clientA, expect.objectContaining({
      type: 'browser_peer_error', requestId: 'attach-a', peerId: prepare.peerId,
      connectionGeneration: 7, code: 'peer_failed', safeError: 'peer failed',
    }));
    expect(browserPeers.has(prepare.peerId)).toBe(false);

    await handleClientBrowser(clientA, {
      type: 'browser_peer_attach', agentId: 'agent-a', browserSessionId: 'browser-session-a',
      requestId: 'attach-b', connectionGeneration: 8,
    }, async () => true);
    expect(sendToAgent.mock.calls.at(-1)[1]).toMatchObject({
      type: 'browser_peer_prepare', requestId: 'attach-b', connectionGeneration: 8,
    });

    sendToWebClient.mockClear();
    await handleAgentBrowser('agent-a', agents.get('agent-a'), {
      type: 'browser_session_snapshot', browserSessionId: 'browser-session-a',
      revision: 3, state: 'closed', terminalReason: 'capture_ended',
      credential: 'must-not-leak',
    });
    expect(sendToWebClient).toHaveBeenCalledWith(clientA, expect.objectContaining({
      type: 'browser_session_snapshot', state: 'closed', terminalReason: 'capture_ended',
    }));
    expect(sendToWebClient.mock.calls[0][1]).not.toHaveProperty('credential');
    expect(getBrowserRoute('agent-a', 'browser-session-a')).toBeNull();
  });

  it('rejects local and privileged navigation schemes before they reach the Agent', async () => {
    const clientA = client('client-a');
    webClients.set(clientA.id, clientA);
    agents.set('agent-a', agent('user-a'));
    await handleClientBrowser(clientA, {
      type: 'browser_session_create', agentId: 'agent-a', requestId: 'file-create',
      options: { initialUrl: 'file:///etc/passwd' },
    }, async () => true);
    expect(sendToAgent).not.toHaveBeenCalled();
    expect(sendToWebClient).toHaveBeenCalledWith(clientA, expect.objectContaining({
      code: 'browser_url_invalid',
    }));
  });

  it('rejects omitted viewer and setup protocols without downgrading either path', async () => {
    const legacy = { ...client('legacy'), browserRuntimeProtocol: 0, browserRuntimeSetupProtocol: 0 };
    agents.set('agent-a', {
      ...agent(),
      capabilities: ['browser_runtime_setup', 'browser_runtime', 'browser_webrtc', 'browser_capture_tab'],
    });
    webClients.set(legacy.id, legacy);
    expect(await handleClientBrowser(legacy, {
      type: 'browser_session_create', agentId: 'agent-a', requestId: 'legacy-create',
    }, async () => true)).toBe(true);
    expect(sendToAgent).not.toHaveBeenCalled();
    expect(sendToWebClient).toHaveBeenCalledWith(legacy, expect.objectContaining({
      code: 'browser_protocol_required',
    }));

    sendToWebClient.mockClear();
    expect(await handleClientBrowser(legacy, {
      type: 'browser_runtime_status', agentId: 'agent-a', requestId: 'legacy-status',
    }, async () => true)).toBe(true);
    expect(sendToAgent).not.toHaveBeenCalled();
    expect(sendToWebClient).toHaveBeenCalledWith(legacy, expect.objectContaining({
      type: 'browser_runtime_error',
      code: 'browser_setup_protocol_required',
    }));
  });
});
