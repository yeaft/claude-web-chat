const PROBE_TIMEOUT_MS = 5_000;
const peers = new Map();

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

function closePeer(record, notify = true) {
  if (!record) return;
  if (peers.get(record.browserSessionId) === record) peers.delete(record.browserSessionId);
  record.stream?.getTracks().forEach(track => track.stop());
  record.peer?.close();
  if (notify) bridgeSend(record, { type: 'peer_closed' });
  try { record.socket?.close(1000, 'Browser Session closed'); } catch {}
}

async function startRuntime({ browserSessionId, bridgeUrl, streamId }) {
  closePeer(peers.get(browserSessionId), false);
  const { stream, track } = await captureTab(streamId);
  const socket = new WebSocket(bridgeUrl);
  const record = {
    browserSessionId,
    stream,
    track,
    socket,
    peer: null,
    connectionGeneration: 0,
    pendingCandidates: [],
  };
  peers.set(browserSessionId, record);
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
    handleBridgeMessage(record, message).catch(error => bridgeSend(record, {
      type: 'peer_error',
      peerId: message.peerId || null,
      connectionGeneration: message.connectionGeneration || null,
      code: error?.name || 'peer_failed',
      safeError: String(error?.message || error).slice(0, 500),
    }));
  };
  socket.onclose = () => closePeer(record, false);
  return { ok: true };
}

async function createPeer(record, message) {
  record.peer?.close();
  const peer = new RTCPeerConnection({
    iceServers: Array.isArray(message.iceServers) ? message.iceServers : [],
    iceTransportPolicy: message.iceTransportPolicy === 'relay' ? 'relay' : 'all',
  });
  const peerId = message.peerId;
  const connectionGeneration = message.connectionGeneration;
  record.peer = peer;
  record.peerId = peerId;
  record.connectionGeneration = connectionGeneration;
  record.pendingCandidates = [];
  record.offerSent = false;
  record.localCandidates = [];
  const isCurrent = () => record.peer === peer
    && record.peerId === peerId
    && record.connectionGeneration === connectionGeneration;
  peer.onicecandidate = event => {
    if (!isCurrent()) return;
    const candidateMessage = {
      type: 'peer_ice_candidate',
      peerId,
      connectionGeneration,
      candidate: event.candidate ? event.candidate.toJSON() : null,
    };
    if (!record.offerSent) record.localCandidates.push(candidateMessage);
    else bridgeSend(record, candidateMessage);
  };
  peer.onconnectionstatechange = () => {
    if (!isCurrent()) return;
    bridgeSend(record, {
      type: 'peer_state',
      peerId,
      connectionGeneration,
      state: peer.connectionState,
    });
  };
  const sender = peer.addTrack(record.track, record.stream);
  preferVp8(peer, sender);
  const parameters = sender.getParameters();
  if (parameters.encodings?.length) {
    parameters.encodings[0].maxBitrate = Number(message.maxBitrate) || 4_000_000;
    parameters.encodings[0].maxFramerate = Number(message.maxFps) || 30;
    await sender.setParameters(parameters);
  }
  await peer.setLocalDescription(await peer.createOffer());
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
    description: peer.localDescription,
  });
  record.offerSent = true;
  for (const candidate of record.localCandidates.splice(0)) bridgeSend(record, candidate);
}

async function handleBridgeMessage(record, message) {
  if (message.type === 'peer_prepare') return createPeer(record, message);
  if (!record.peer || message.peerId !== record.peerId
      || message.connectionGeneration !== record.connectionGeneration) return;
  const peer = record.peer;
  if (message.type === 'peer_answer') {
    await peer.setRemoteDescription(message.description);
    if (record.peer !== peer) return;
    for (const candidate of record.pendingCandidates.splice(0)) {
      await peer.addIceCandidate(candidate);
      if (record.peer !== peer) return;
    }
  } else if (message.type === 'peer_ice_candidate') {
    if (!message.candidate) return;
    if (!peer.remoteDescription) record.pendingCandidates.push(message.candidate);
    else await peer.addIceCandidate(message.candidate);
  } else if (message.type === 'peer_close') {
    record.peer.close();
    record.peer = null;
  } else if (message.type === 'session_close') {
    closePeer(record);
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
