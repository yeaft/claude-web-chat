const PROBE_TIMEOUT_MS = 5_000;
const sessions = new Map();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function inboundVideoStats(peer) {
  const stats = await peer.getStats();
  for (const report of stats.values()) {
    if (report.type === 'inbound-rtp' && (report.kind === 'video' || report.mediaType === 'video')) {
      const codec = stats.get(report.codecId);
      return {
        bytesReceived: Number(report.bytesReceived) || 0,
        framesDecoded: Number(report.framesDecoded) || 0,
        framesReceived: Number(report.framesReceived) || 0,
        frameWidth: Number(report.frameWidth) || 0,
        frameHeight: Number(report.frameHeight) || 0,
        codec: typeof codec?.mimeType === 'string' ? codec.mimeType : null,
      };
    }
  }
  return null;
}

async function captureTab(streamId) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
      },
    },
  });
  const track = stream.getVideoTracks()[0];
  if (!track) {
    stream.getTracks().forEach(item => item.stop());
    throw new Error('tab capture returned no video track');
  }
  return { stream, track };
}

function preferVp8(peer, sender) {
  const vp8 = RTCRtpSender.getCapabilities('video')?.codecs
    ?.filter(codec => codec.mimeType?.toLowerCase() === 'video/vp8') || [];
  if (vp8.length === 0) throw new Error('VP8 encoder capability unavailable');
  const transceiver = peer.getTransceivers().find(item => item.sender === sender);
  transceiver?.setCodecPreferences(vp8);
}

async function runMediaProbe(streamId) {
  let stream = null;
  let offerer = null;
  let answerer = null;
  try {
    ({ stream } = await captureTab(streamId));
    const track = stream.getVideoTracks()[0];
    offerer = new RTCPeerConnection();
    answerer = new RTCPeerConnection();
    offerer.onicecandidate = event => event.candidate && answerer.addIceCandidate(event.candidate);
    answerer.onicecandidate = event => event.candidate && offerer.addIceCandidate(event.candidate);
    const video = document.querySelector('#probe-video');
    answerer.ontrack = event => { video.srcObject = event.streams[0] || new MediaStream([event.track]); };
    const sender = offerer.addTrack(track, stream);
    preferVp8(offerer, sender);
    await offerer.setLocalDescription(await offerer.createOffer());
    await answerer.setRemoteDescription(offerer.localDescription);
    await answerer.setLocalDescription(await answerer.createAnswer());
    await offerer.setRemoteDescription(answerer.localDescription);
    await video.play().catch(() => {});
    const deadline = Date.now() + PROBE_TIMEOUT_MS;
    let media = null;
    while (Date.now() < deadline) {
      media = await inboundVideoStats(answerer);
      if (media?.framesDecoded > 0) break;
      await sleep(100);
    }
    if (!media || media.framesDecoded < 1) throw new Error('WebRTC decoded no tab-capture frame');
    if (media.codec?.toLowerCase() !== 'video/vp8') throw new Error(`unexpected negotiated codec: ${media.codec || 'unknown'}`);
    const settings = track.getSettings?.() || {};
    return {
      ok: true,
      captureMode: 'tab',
      codecBaseline: media.codec,
      width: Number(settings.width) || media.frameWidth || 0,
      height: Number(settings.height) || media.frameHeight || 0,
      frameRate: Number(settings.frameRate) || 0,
      framesDecoded: media.framesDecoded,
      bytesReceived: media.bytesReceived,
    };
  } finally {
    stream?.getTracks().forEach(track => track.stop());
    offerer?.close();
    answerer?.close();
    const video = document.querySelector('#probe-video');
    if (video) video.srcObject = null;
  }
}

function bridgeSend(record, message) {
  if (record.socket?.readyState === WebSocket.OPEN) {
    record.socket.send(JSON.stringify({ ...message, browserSessionId: record.browserSessionId }));
  }
}

function peerRecord(record, message) {
  const peer = record?.peers.get(message?.peerId);
  return peer?.connectionGeneration === message?.connectionGeneration ? peer : null;
}

function closePeer(record, peer, notify = false) {
  if (!record || !peer || record.peers.get(peer.peerId) !== peer) return false;
  record.peers.delete(peer.peerId);
  peer.connection.close();
  if (notify) bridgeSend(record, {
    type: 'peer_closed',
    peerId: peer.peerId,
    connectionGeneration: peer.connectionGeneration,
  });
  return true;
}

function closeSession(record, notify = true) {
  if (!record || record.closed) return;
  record.closed = true;
  if (sessions.get(record.browserSessionId) === record) sessions.delete(record.browserSessionId);
  for (const peer of [...record.peers.values()]) closePeer(record, peer, notify);
  record.stream?.getTracks().forEach(track => track.stop());
  try { record.socket?.close(1000, 'Browser Session closed'); } catch {}
}

async function startRuntime({ browserSessionId, bridgeUrl, streamId }) {
  closeSession(sessions.get(browserSessionId), false);
  const { stream, track } = await captureTab(streamId);
  const socket = new WebSocket(bridgeUrl);
  const record = {
    browserSessionId,
    stream,
    track,
    socket,
    peers: new Map(),
    closed: false,
  };
  sessions.set(browserSessionId, record);
  track.addEventListener('ended', () => bridgeSend(record, { type: 'capture_ended' }), { once: true });
  socket.onopen = () => bridgeSend(record, {
    type: 'runtime_ready',
    captureMode: 'tab',
    settings: track.getSettings?.() || {},
  });
  socket.onmessage = event => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.browserSessionId !== browserSessionId) return;
    handleBridgeMessage(record, message).catch(error => {
      const peer = peerRecord(record, message);
      if (peer) closePeer(record, peer);
      bridgeSend(record, {
        type: 'peer_error',
        peerId: message.peerId || null,
        connectionGeneration: message.connectionGeneration || null,
        code: error?.name || 'peer_failed',
        safeError: String(error?.message || error).slice(0, 500),
      });
    });
  };
  socket.onclose = () => closeSession(record, false);
  return { ok: true };
}

async function createPeer(record, message) {
  const peerId = message.peerId;
  const connectionGeneration = message.connectionGeneration;
  const existing = record.peers.get(peerId);
  if (existing?.connectionGeneration === connectionGeneration) return;
  if (existing) closePeer(record, existing);
  const connection = new RTCPeerConnection({
    iceServers: Array.isArray(message.iceServers) ? message.iceServers : [],
    iceTransportPolicy: message.iceTransportPolicy === 'relay' ? 'relay' : 'all',
  });
  const peer = {
    peerId,
    connectionGeneration,
    connection,
    pendingCandidates: [],
    offerSent: false,
    localCandidates: [],
  };
  record.peers.set(peerId, peer);
  const isCurrent = () => peerRecord(record, peer) === peer;
  connection.onicecandidate = event => {
    if (!isCurrent()) return;
    const candidateMessage = {
      type: 'peer_ice_candidate',
      peerId,
      connectionGeneration,
      candidate: event.candidate ? event.candidate.toJSON() : null,
    };
    if (!peer.offerSent) peer.localCandidates.push(candidateMessage);
    else bridgeSend(record, candidateMessage);
  };
  connection.onconnectionstatechange = () => {
    if (!isCurrent()) return;
    bridgeSend(record, {
      type: 'peer_state',
      peerId,
      connectionGeneration,
      state: connection.connectionState,
    });
  };
  const sender = connection.addTrack(record.track, record.stream);
  preferVp8(connection, sender);
  const parameters = sender.getParameters();
  if (parameters.encodings?.length) {
    parameters.encodings[0].maxBitrate = Number(message.maxBitrate) || 4_000_000;
    parameters.encodings[0].maxFramerate = Number(message.maxFps) || 30;
    await sender.setParameters(parameters);
  }
  await connection.setLocalDescription(await connection.createOffer());
  if (!isCurrent()) return;
  bridgeSend(record, {
    type: 'peer_prepared',
    peerId,
    connectionGeneration,
  });
  bridgeSend(record, {
    type: 'peer_offer',
    peerId,
    connectionGeneration,
    description: connection.localDescription,
  });
  peer.offerSent = true;
  for (const candidate of peer.localCandidates.splice(0)) bridgeSend(record, candidate);
}

async function handleBridgeMessage(record, message) {
  if (record.closed) return;
  if (message.type === 'session_close') {
    closeSession(record);
    return;
  }
  if (message.type === 'peer_prepare') return createPeer(record, message);
  const peer = peerRecord(record, message);
  if (!peer) return;
  const connection = peer.connection;
  if (message.type === 'peer_answer') {
    await connection.setRemoteDescription(message.description);
    if (peerRecord(record, message) !== peer) return;
    for (const candidate of peer.pendingCandidates.splice(0)) {
      await connection.addIceCandidate(candidate);
      if (peerRecord(record, message) !== peer) return;
    }
  } else if (message.type === 'peer_ice_candidate') {
    if (!message.candidate) return;
    if (!connection.remoteDescription) peer.pendingCandidates.push(message.candidate);
    else await connection.addIceCandidate(message.candidate);
  } else if (message.type === 'peer_close') {
    closePeer(record, peer);
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== 'browser_runtime_offscreen') return undefined;
  const operation = message.type === 'browser_runtime_probe_media'
    ? () => runMediaProbe(message.streamId)
    : message.type === 'browser_runtime_start'
      ? () => startRuntime(message)
      : null;
  if (!operation) return undefined;
  operation().then(sendResponse, error => sendResponse({
    ok: false,
    code: message.type === 'browser_runtime_probe_media' ? 'media_probe_failed' : 'browser_runtime_start_failed',
    safeError: String(error?.message || error).slice(0, 500),
  }));
  return true;
});
