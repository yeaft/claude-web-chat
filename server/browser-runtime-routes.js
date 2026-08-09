import { createHmac, randomUUID } from 'node:crypto';
import { CONFIG } from './config.js';
import { agents, webClients } from './context.js';

const MAX_ROUTES = 2048;
const MAX_PEERS = 4096;
const MAX_CREATE_REQUESTS = 4096;
const CREATE_REQUEST_TTL_MS = 10 * 60_000;

export const browserRoutes = new Map();
export const browserPeers = new Map();
const browserRequests = new Map();

function key(agentId, browserSessionId) {
  return `${String(agentId || '')}\0${String(browserSessionId || '')}`;
}

function createKey(agentId, connectionId, requestId) {
  return `${String(agentId || '')}\0${String(connectionId || '')}\0${String(requestId || '')}`;
}

function scopeUsername({ ownerUserId, agentId, browserSessionId, peerId, connectionGeneration, endpointRole, expiresAt }) {
  const scope = Buffer.from(JSON.stringify({
    ownerUserId,
    agentId,
    browserSessionId,
    peerId,
    connectionGeneration,
    endpointRole,
    credentialId: randomUUID(),
  })).toString('base64url');
  return `${Math.floor(expiresAt / 1000)}:${scope}`;
}

export function mintBrowserIceServers(scope, config = CONFIG.browserRuntime) {
  const stunServers = config.stunUrls.length > 0 ? [{ urls: [...config.stunUrls] }] : [];
  if (config.turnUrls.length === 0) return stunServers;
  const expiresAt = Date.now() + config.credentialTtlSeconds * 1000;
  const username = scopeUsername({ ...scope, expiresAt });
  const credential = createHmac('sha1', config.turnSecret).update(username).digest('base64');
  return [
    ...stunServers,
    { urls: [...config.turnUrls], username, credential, expiresAt },
  ];
}

export function browserServerIdentity(client) {
  return Object.freeze({
    ownerUserId: client.userId,
    clientId: client.id,
    webConnectionId: client.connectionId,
    webConnectionGeneration: client.connectionGeneration,
  });
}

export function pruneBrowserRuntimeRoutes(now = Date.now()) {
  for (const [requestKey, request] of browserRequests) {
    if (request.expiresAt <= now || !webClients.has(request.clientId)) browserRequests.delete(requestKey);
  }
  for (const [peerId, peer] of browserPeers) {
    const client = webClients.get(peer.clientId);
    if ((peer.expiresAt != null && peer.expiresAt <= now)
        || !client || client.connectionId !== peer.webConnectionId) {
      browserPeers.delete(peerId);
    }
  }
}

export function registerBrowserCreateRequest({ agentId, client, requestId, digest }) {
  pruneBrowserRuntimeRoutes();
  const requestKey = createKey(agentId, client.connectionId, requestId);
  const existing = browserRequests.get(requestKey);
  if (existing) {
    if (existing.digest !== digest) return { conflict: true, request: existing };
    return { duplicate: true, request: existing };
  }
  if (browserRequests.size >= MAX_CREATE_REQUESTS) return { capacity: true, request: null };
  const request = {
    agentId,
    requestId,
    serverRequestId: randomUUID(),
    clientId: client.id,
    ownerUserId: client.userId,
    webConnectionId: client.connectionId,
    webConnectionGeneration: client.connectionGeneration,
    digest,
    state: 'pending',
    response: null,
    expiresAt: Date.now() + CREATE_REQUEST_TTL_MS,
  };
  browserRequests.set(requestKey, request);
  return { request };
}

export function completeBrowserRequest(agentId, msg, { consume = false } = {}) {
  for (const [requestKey, request] of browserRequests) {
    if (request.agentId !== agentId || request.serverRequestId !== msg.requestId || request.state !== 'pending') continue;
    request.state = msg.type.endsWith('_error') ? 'failed' : 'completed';
    request.response = { ...msg, requestId: request.requestId };
    request.expiresAt = Date.now() + CREATE_REQUEST_TTL_MS;
    if (consume) browserRequests.delete(requestKey);
    return request;
  }
  return null;
}

export function registerBrowserRequest({ agentId, client, requestId, kind, browserSessionId = null }) {
  pruneBrowserRuntimeRoutes();
  const requestKey = createKey(agentId, client.connectionId, requestId);
  if (browserRequests.has(requestKey) || browserRequests.size >= MAX_CREATE_REQUESTS) return null;
  const request = {
    agentId,
    requestId,
    serverRequestId: randomUUID(),
    kind,
    browserSessionId,
    clientId: client.id,
    ownerUserId: client.userId,
    webConnectionId: client.connectionId,
    webConnectionGeneration: client.connectionGeneration,
    digest: '',
    state: 'pending',
    response: null,
    expiresAt: Date.now() + CREATE_REQUEST_TTL_MS,
  };
  browserRequests.set(requestKey, request);
  return request;
}

export function installBrowserRoute({ agentId, ownerUserId, msg }) {
  if (!msg.browserSessionId) return null;
  const routeKey = key(agentId, msg.browserSessionId);
  const existing = browserRoutes.get(routeKey);
  if (existing && existing.ownerUserId !== ownerUserId) return null;
  if (!existing && browserRoutes.size >= MAX_ROUTES) return null;
  const route = {
    ownerUserId,
    agentId,
    browserSessionId: msg.browserSessionId,
    revision: Number(msg.revision) || 1,
    state: msg.state || 'ready',
    updatedAt: Date.now(),
  };
  browserRoutes.set(routeKey, route);
  return route;
}

export function getBrowserRoute(agentId, browserSessionId) {
  return browserRoutes.get(key(agentId, browserSessionId)) || null;
}

export function deleteBrowserRoute(agentId, browserSessionId) {
  const routeKey = key(agentId, browserSessionId);
  const deleted = browserRoutes.delete(routeKey);
  for (const [peerId, peer] of browserPeers) {
    if (peer.agentId === agentId && peer.browserSessionId === browserSessionId) browserPeers.delete(peerId);
  }
  return deleted;
}

export function reserveBrowserPeer({ agentId, browserSessionId, client, requestId, connectionGeneration, role = 'viewer' }) {
  pruneBrowserRuntimeRoutes();
  const route = getBrowserRoute(agentId, browserSessionId);
  if (!route || route.ownerUserId !== client.userId || route.state !== 'ready') return { error: 'browser_session_not_found' };
  if (!Number.isSafeInteger(connectionGeneration) || connectionGeneration <= 0) return { error: 'browser_generation_invalid' };
  const duplicate = [...browserPeers.values()].find(peer => (
    peer.agentId === agentId
      && peer.browserSessionId === browserSessionId
      && peer.clientId === client.id
      && peer.webConnectionId === client.connectionId
      && peer.requestId === requestId
      && peer.connectionGeneration === connectionGeneration
  ));
  if (duplicate) return { peer: duplicate, duplicate: true };
  if (browserPeers.size >= MAX_PEERS) return { error: 'browser_peer_capacity' };
  const peerId = randomUUID();
  const expiresAt = Date.now() + CONFIG.browserRuntime.routeTtlMs;
  const peer = {
    peerId,
    requestId,
    ownerUserId: client.userId,
    agentId,
    browserSessionId,
    clientId: client.id,
    webConnectionId: client.connectionId,
    webConnectionGeneration: client.connectionGeneration,
    connectionGeneration,
    role: role === 'interactive' ? 'interactive' : 'viewer',
    state: 'preparing',
    pendingOffer: null,
    pendingCandidates: [],
    agentCandidateCount: 0,
    webCandidateCount: 0,
    iceTransportPolicy: CONFIG.browserRuntime.iceTransportPolicy,
    expiresAt,
  };
  browserPeers.set(peerId, peer);
  return { peer };
}

export function getBrowserPeer(peerId) {
  pruneBrowserRuntimeRoutes();
  return browserPeers.get(String(peerId || '')) || null;
}

export function browserPeerMatchesClient(peer, client, message = {}) {
  return !!peer && !!client
    && peer.ownerUserId === client.userId
    && peer.clientId === client.id
    && peer.webConnectionId === client.connectionId
    && peer.webConnectionGeneration === client.connectionGeneration
    && peer.agentId === message.agentId
    && peer.browserSessionId === message.browserSessionId
    && peer.connectionGeneration === Number(message.connectionGeneration);
}

export function deleteBrowserPeer(peerId) {
  return browserPeers.delete(String(peerId || ''));
}

export function clearBrowserRuntimeForClient(client) {
  if (!client) return [];
  const peers = [];
  for (const [peerId, peer] of browserPeers) {
    if (peer.clientId === client.id && peer.webConnectionId === client.connectionId) {
      browserPeers.delete(peerId);
      peers.push(peer);
    }
  }
  for (const [requestKey, request] of browserRequests) {
    if (request.clientId === client.id && request.webConnectionId === client.connectionId) {
      browserRequests.delete(requestKey);
    }
  }
  return peers;
}

export function clearBrowserRuntimeForAgent(agentId) {
  for (const [routeKey, route] of browserRoutes) {
    if (route.agentId === agentId) browserRoutes.delete(routeKey);
  }
  for (const [peerId, peer] of browserPeers) {
    if (peer.agentId === agentId) browserPeers.delete(peerId);
  }
  for (const [requestKey, request] of browserRequests) {
    if (request.agentId === agentId) browserRequests.delete(requestKey);
  }
}

export function browserClientForPeer(peer) {
  const client = webClients.get(peer?.clientId);
  if (!client || client.connectionId !== peer.webConnectionId
      || client.connectionGeneration !== peer.webConnectionGeneration) return null;
  return client;
}

export function browserAgentForPeer(peer) {
  return agents.get(peer?.agentId) || null;
}

export function __testResetBrowserRuntimeRoutes() {
  browserRoutes.clear();
  browserPeers.clear();
  browserRequests.clear();
}
