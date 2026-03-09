import WebSocket from 'ws';
import http from 'http';
import https from 'https';
import ctx from './context.js';

export function handleProxyHttpRequest(msg) {
  const { requestId, port, method, path, headers, body, scheme, host, basePath } = msg;
  const effectiveHost = host || 'localhost';
  const effectiveScheme = scheme || 'http';
  const httpModule = effectiveScheme === 'https' ? https : http;

  const options = {
    hostname: effectiveHost,
    port,
    path,
    method,
    headers: { ...headers },
    timeout: 60000
  };

  // For HTTPS: skip certificate verification for local services
  if (effectiveScheme === 'https') {
    options.rejectUnauthorized = false;
  }

  // Clean hop-by-hop headers
  delete options.headers['host'];
  options.headers['host'] = `${effectiveHost}:${port}`;
  delete options.headers['connection'];
  delete options.headers['upgrade'];
  delete options.headers['accept-encoding']; // Let agent handle raw data

  const req = httpModule.request(options, (res) => {
    const contentType = res.headers['content-type'] || '';
    const isStreaming = (
      contentType.includes('text/event-stream') ||
      (contentType.includes('text/plain') && res.headers['transfer-encoding'] === 'chunked')
    );

    if (isStreaming) {
      ctx.sendToServer({
        type: 'proxy_response_chunk',
        requestId,
        statusCode: res.statusCode,
        headers: res.headers
      });

      res.on('data', (chunk) => {
        ctx.sendToServer({
          type: 'proxy_response_chunk',
          requestId,
          chunk: chunk.toString('base64')
        });
      });

      res.on('end', () => {
        ctx.sendToServer({ type: 'proxy_response_end', requestId });
      });
    } else {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        let responseBody = Buffer.concat(chunks);
        const responseHeaders = { ...res.headers };

        // Rewrite absolute paths in HTML responses
        if (basePath && contentType.includes('text/html')) {
          let html = responseBody.toString('utf-8');
          html = html
            .replace(/((?:src|href|action)\s*=\s*["'])\//gi, `$1${basePath}/`)
            .replace(/(url\s*\(\s*["']?)\//gi, `$1${basePath}/`);
          responseBody = Buffer.from(html, 'utf-8');
          // Update content-length since rewritten paths are longer
          delete responseHeaders['content-length'];
        }

        ctx.sendToServer({
          type: 'proxy_response',
          requestId,
          statusCode: res.statusCode,
          headers: responseHeaders,
          body: responseBody.toString('base64')
        });
      });
    }

    res.on('error', (err) => {
      ctx.sendToServer({
        type: 'proxy_response',
        requestId,
        statusCode: 502,
        headers: { 'content-type': 'text/plain' },
        body: Buffer.from(`Proxy stream error: ${err.message}`).toString('base64')
      });
    });
  });

  req.on('error', (err) => {
    ctx.sendToServer({
      type: 'proxy_response',
      requestId,
      statusCode: 502,
      headers: { 'content-type': 'text/plain' },
      body: Buffer.from(`Proxy error: ${err.message}`).toString('base64')
    });
  });

  req.on('timeout', () => {
    req.destroy();
    ctx.sendToServer({
      type: 'proxy_response',
      requestId,
      statusCode: 504,
      headers: { 'content-type': 'text/plain' },
      body: Buffer.from('Proxy request timeout').toString('base64')
    });
  });

  if (body) req.write(Buffer.from(body, 'base64'));
  req.end();
}

export function handleProxyWsOpen(msg) {
  const { proxyWsId, port, path, headers, scheme, host } = msg;
  const effectiveHost = host || 'localhost';
  const wsScheme = (scheme === 'https') ? 'wss' : 'ws';
  const url = `${wsScheme}://${effectiveHost}:${port}${path || '/'}`;

  const wsHeaders = { ...headers };
  wsHeaders['host'] = `${effectiveHost}:${port}`;

  const wsOptions = { headers: wsHeaders };
  if (wsScheme === 'wss') {
    wsOptions.rejectUnauthorized = false;
  }

  const localWs = new WebSocket(url, wsOptions);

  localWs.on('open', () => {
    ctx.sendToServer({ type: 'proxy_ws_opened', proxyWsId });
  });

  localWs.on('message', (data, isBinary) => {
    ctx.sendToServer({
      type: 'proxy_ws_message',
      proxyWsId,
      data: isBinary ? Buffer.from(data).toString('base64') : data.toString(),
      isBinary
    });
  });

  localWs.on('close', (code) => {
    ctx.proxyWsSockets.delete(proxyWsId);
    ctx.sendToServer({ type: 'proxy_ws_closed', proxyWsId, code });
  });

  localWs.on('error', (err) => {
    ctx.proxyWsSockets.delete(proxyWsId);
    ctx.sendToServer({ type: 'proxy_ws_error', proxyWsId, error: err.message });
  });

  ctx.proxyWsSockets.set(proxyWsId, localWs);
}

export function handleProxyWsMessage(msg) {
  const localWs = ctx.proxyWsSockets.get(msg.proxyWsId);
  if (localWs && localWs.readyState === WebSocket.OPEN) {
    if (msg.isBinary) {
      localWs.send(Buffer.from(msg.data, 'base64'));
    } else {
      localWs.send(msg.data);
    }
  }
}

export function handleProxyWsClose(msg) {
  const localWs = ctx.proxyWsSockets.get(msg.proxyWsId);
  if (localWs) {
    localWs.close(msg.code || 1000);
    ctx.proxyWsSockets.delete(msg.proxyWsId);
  }
}
