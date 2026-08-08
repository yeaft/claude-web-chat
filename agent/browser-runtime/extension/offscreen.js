const PROBE_TIMEOUT_MS = 5_000;

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

async function runMediaProbe(streamId) {
  let stream = null;
  let offerer = null;
  let answerer = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId,
        },
      },
    });
    const track = stream.getVideoTracks()[0];
    if (!track) throw new Error('tab capture returned no video track');

    offerer = new RTCPeerConnection();
    answerer = new RTCPeerConnection();
    offerer.onicecandidate = event => event.candidate && answerer.addIceCandidate(event.candidate);
    answerer.onicecandidate = event => event.candidate && offerer.addIceCandidate(event.candidate);

    const video = document.querySelector('#probe-video');
    answerer.ontrack = event => {
      video.srcObject = event.streams[0] || new MediaStream([event.track]);
    };
    const sender = offerer.addTrack(track, stream);
    const vp8 = RTCRtpSender.getCapabilities('video')?.codecs
      ?.filter(codec => codec.mimeType?.toLowerCase() === 'video/vp8') || [];
    if (vp8.length === 0) throw new Error('VP8 encoder capability unavailable');
    const transceiver = offerer.getTransceivers().find(item => item.sender === sender);
    transceiver?.setCodecPreferences(vp8);
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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== 'browser_runtime_offscreen'
      || message?.type !== 'browser_runtime_probe_media') return undefined;
  runMediaProbe(message.streamId).then(sendResponse, error => sendResponse({
    ok: false,
    code: 'media_probe_failed',
    safeError: String(error?.message || error).slice(0, 500),
  }));
  return true;
});
