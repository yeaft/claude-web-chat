import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';

export const MAX_REMOTE_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_REDIRECTS = 5;

function parseIpv4(address) {
  const parts = address.split('.').map(Number);
  return parts.length === 4 && parts.every(part => Number.isInteger(part) && part >= 0 && part <= 255) ? parts : null;
}

function parseIpv6(address) {
  const normalized = address.toLowerCase().split('%')[0];
  if (!normalized || normalized.includes(':::')) return null;
  const halves = normalized.split('::');
  if (halves.length > 2) return null;
  const parseHalf = (value) => {
    if (!value) return [];
    const groups = [];
    for (const part of value.split(':')) {
      if (part.includes('.')) {
        const bytes = parseIpv4(part);
        if (!bytes) return null;
        groups.push((bytes[0] << 8) | bytes[1], (bytes[2] << 8) | bytes[3]);
      } else if (!/^[0-9a-f]{1,4}$/.test(part)) {
        return null;
      } else {
        groups.push(Number.parseInt(part, 16));
      }
    }
    return groups;
  };
  const left = parseHalf(halves[0]);
  const right = parseHalf(halves[1] || '');
  if (!left || !right) return null;
  if (halves.length === 1) return left.length === 8 ? left : null;
  const zeros = 8 - left.length - right.length;
  if (zeros < 1) return null;
  return [...left, ...Array(zeros).fill(0), ...right];
}

function ipv4FromGroups(groups, index) {
  const high = groups[index];
  const low = groups[index + 1];
  return `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`;
}

export function isPublicNetworkAddress(address) {
  const version = isIP(address);
  if (version === 4) {
    const bytes = parseIpv4(address);
    if (!bytes) return false;
    const [a, b, c] = bytes;
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
    if (a === 192 && b === 88 && c === 99) return false;
    if (a === 192 && b === 168) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    if (a === 198 && b === 51 && c === 100) return false;
    if (a === 203 && b === 0 && c === 113) return false;
    return true;
  }
  if (version !== 6) return false;
  const normalized = address.toLowerCase().split('%')[0];
  if (normalized === '::' || normalized === '::1') return false;
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return false;
  if (/^fe[89ab]/.test(normalized)) return false;
  if (normalized.startsWith('ff')) return false;
  const groups = parseIpv6(normalized);
  if (!groups) return false;
  const isMappedIpv4 = groups.slice(0, 5).every(group => group === 0) && groups[5] === 0xffff;
  if (isMappedIpv4) return isPublicNetworkAddress(ipv4FromGroups(groups, 6));
  const isCompatibleIpv4 = groups.slice(0, 6).every(group => group === 0);
  const isNat64 = (groups[0] === 0x0064 && groups[1] === 0xff9b && groups.slice(2, 6).every(group => group === 0))
    || (groups[0] === 0x0064 && groups[1] === 0xff9b && groups[2] === 0x0001);
  const is6to4 = groups[0] === 0x2002;
  const isTeredo = groups[0] === 0x2001 && groups[1] === 0;
  const isIsatap = groups[5] === 0x5efe;
  if (isCompatibleIpv4 || isNat64 || is6to4 || isTeredo || isIsatap) return false;
  return !(groups[0] === 0x2001 && groups[1] === 0x0db8);
}

async function resolvePublicTarget(url, lookup = dnsLookup) {
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Generated image URL must use http or https');
  if (url.username || url.password) throw new Error('Generated image URL must not contain credentials');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const literalVersion = isIP(hostname);
  const records = literalVersion
    ? [{ address: hostname, family: literalVersion }]
    : await lookup(hostname, { all: true, verbatim: true });
  if (!Array.isArray(records) || records.length === 0) throw new Error('Generated image host did not resolve');
  if (records.some(record => !isPublicNetworkAddress(record.address))) {
    throw new Error('Generated image URL resolves to a private or reserved network');
  }
  return records[0];
}

function detectMime(buffer) {
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  const head6 = buffer.subarray(0, 6).toString('ascii');
  if (head6 === 'GIF87a' || head6 === 'GIF89a') return 'image/gif';
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

function requestOnce(url, target, { signal, requestImpl } = {}) {
  return new Promise((resolve, reject) => {
    const request = requestImpl || (url.protocol === 'https:' ? httpsRequest : httpRequest);
    let settled = false;
    const finishReject = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    const req = request(url, {
      signal,
      lookup: (_hostname, _options, callback) => callback(null, target.address, target.family),
      headers: { accept: 'image/png,image/jpeg,image/gif,image/webp' },
    }, response => {
      if (settled) {
        response.destroy();
        return;
      }
      settled = true;
      resolve(response);
    });
    req.on('error', finishReject);
    req.end();
  });
}

async function readBounded(response, maxBytes) {
  const declared = Number(response.headers['content-length']);
  if (Number.isFinite(declared) && declared > maxBytes) {
    response.destroy();
    throw new Error('Generated image exceeds 20 MiB');
  }
  const chunks = [];
  let total = 0;
  try {
    for await (const chunk of response) {
      total += chunk.length;
      if (total > maxBytes) {
        response.destroy();
        throw new Error('Generated image exceeds 20 MiB');
      }
      chunks.push(chunk);
    }
  } catch (err) {
    response.destroy();
    throw err;
  }
  if (total === 0) throw new Error('Generated image is empty');
  return Buffer.concat(chunks, total);
}

export async function downloadRemoteImage(value, {
  signal,
  lookup = dnsLookup,
  requestImpl,
  maxBytes = MAX_REMOTE_IMAGE_BYTES,
  maxRedirects = MAX_REDIRECTS,
} = {}) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Image API returned an invalid image URL'); }
  for (let redirects = 0; ; redirects++) {
    const target = await resolvePublicTarget(url, lookup);
    const response = await requestOnce(url, target, { signal, requestImpl });
    const status = Number(response.statusCode || 0);
    if (status >= 300 && status < 400 && response.headers.location) {
      response.destroy();
      if (redirects >= maxRedirects) throw new Error('Generated image download exceeded redirect limit');
      const nextUrl = new URL(response.headers.location, url);
      if (url.protocol === 'https:' && nextUrl.protocol !== 'https:') {
        throw new Error('Generated image redirect must not downgrade HTTPS');
      }
      url = nextUrl;
      continue;
    }
    if (status < 200 || status >= 300) {
      response.destroy();
      throw new Error(`Image download returned ${status}`);
    }
    const mimeType = String(response.headers['content-type'] || '').split(';')[0].toLowerCase();
    if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mimeType)) {
      response.destroy();
      throw new Error(`Unsupported generated image type: ${mimeType}`);
    }
    const buffer = await readBounded(response, maxBytes);
    if (detectMime(buffer) !== mimeType) throw new Error('Generated image MIME does not match file bytes');
    return { buffer, mimeType, url: url.href };
  }
}
