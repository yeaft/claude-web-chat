import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { downloadRemoteImage, isPublicNetworkAddress } from '../../../agent/yeaft/remote-image-download.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

function requestSequence(responses, seen = []) {
  return (url, options, callback) => {
    const request = new PassThrough();
    request.end = () => {
      seen.push({ url: url.href, options });
      const spec = responses.shift();
      const response = new PassThrough();
      response.statusCode = spec.statusCode ?? 200;
      response.headers = spec.headers || {};
      callback(response);
      for (const chunk of spec.chunks || []) response.write(chunk);
      response.end();
    };
    return request;
  };
}

const publicLookup = vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]);

describe('remote image download', () => {
  it('rejects local, private, reserved, and mapped addresses', () => {
    for (const value of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '192.168.1.1', '::1', 'fc00::1', '::ffff:127.0.0.1']) {
      expect(isPublicNetworkAddress(value), value).toBe(false);
    }
    expect(isPublicNetworkAddress('93.184.216.34')).toBe(true);
    expect(isPublicNetworkAddress('2606:4700:4700::1111')).toBe(true);
  });

  it('pins the validated DNS result into the socket lookup', async () => {
    const seen = [];
    const result = await downloadRemoteImage('https://images.example/pixel.png', {
      lookup: publicLookup,
      requestImpl: requestSequence([{ headers: { 'content-type': 'image/png' }, chunks: [PNG] }], seen),
    });
    expect(result.buffer).toEqual(PNG);
    const callback = vi.fn();
    seen[0].options.lookup('images.example', {}, callback);
    expect(callback).toHaveBeenCalledWith(null, '93.184.216.34', 4);
  });

  it('blocks a public redirect to a private target before a second request', async () => {
    const requestImpl = vi.fn(requestSequence([{ statusCode: 302, headers: { location: 'https://127.0.0.1/metadata' } }]));
    await expect(downloadRemoteImage('https://images.example/start', { lookup: publicLookup, requestImpl }))
      .rejects.toThrow(/private or reserved/);
    expect(requestImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects mixed public/private DNS answers', async () => {
    const lookup = vi.fn(async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.1', family: 4 },
    ]);
    await expect(downloadRemoteImage('https://images.example/file.png', { lookup, requestImpl: vi.fn() }))
      .rejects.toThrow(/private or reserved/);
  });

  it('rejects an oversized Content-Length before reading the body', async () => {
    const response = { headers: { 'content-type': 'image/png', 'content-length': String(PNG.length) }, chunks: [PNG] };
    await expect(downloadRemoteImage('https://images.example/file.png', {
      lookup: publicLookup, requestImpl: requestSequence([response]), maxBytes: PNG.length - 1,
    })).rejects.toThrow(/exceeds/);
  });

  it('aborts a chunked body at maxBytes plus one', async () => {
    const response = { headers: { 'content-type': 'image/png' }, chunks: [PNG.subarray(0, PNG.length - 1), PNG.subarray(PNG.length - 1)] };
    await expect(downloadRemoteImage('https://images.example/file.png', {
      lookup: publicLookup, requestImpl: requestSequence([response]), maxBytes: PNG.length - 1,
    })).rejects.toThrow(/exceeds/);
  });

  it('rejects HTTPS downgrade redirects and MIME spoofing', async () => {
    await expect(downloadRemoteImage('https://images.example/start', {
      lookup: publicLookup,
      requestImpl: requestSequence([{ statusCode: 302, headers: { location: 'http://public.example/image.png' } }]),
    })).rejects.toThrow(/must not downgrade/);
    await expect(downloadRemoteImage('https://images.example/fake.png', {
      lookup: publicLookup,
      requestImpl: requestSequence([{ headers: { 'content-type': 'image/png' }, chunks: [Buffer.from('<html>')] }]),
    })).rejects.toThrow(/MIME does not match/);
  });

  it('rejects invalid schemes and private DNS before network I/O', async () => {
    await expect(downloadRemoteImage('file:///etc/passwd', { requestImpl: vi.fn() })).rejects.toThrow(/http or https/);
    const requestImpl = vi.fn();
    await expect(downloadRemoteImage('https://private.example/file.png', {
      lookup: vi.fn(async () => [{ address: '192.168.0.2', family: 4 }]), requestImpl,
    })).rejects.toThrow(/private or reserved/);
    expect(requestImpl).not.toHaveBeenCalled();
  });
});
