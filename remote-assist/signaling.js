import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const SESSION_TTL_MS = 45 * 60 * 1000;
const MAX_BODY_BYTES = 256 * 1024;
const MAX_ACTIVE_SESSIONS = 500;
const MAX_ACTIVE_DEVICES = 500;
const MAX_CREATES_PER_MINUTE = 20;
const DEVICE_TTL_MS = 3 * 60 * 1000;
const MAX_DEVICE_CONNECTS_PER_WINDOW = 8;
const DEVICE_CONNECT_WINDOW_MS = 15 * 60 * 1000;
const scrypt = promisify(scryptCallback);
const sessions = new Map();
const createRequests = new Map();
const devices = new Map();
const deviceConnectRequests = new Map();

function sendJson(response, status, data) {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.end(JSON.stringify(data));
}

function clientAddress(request) {
  if (process.env.TRUST_PROXY === '1' && typeof request.headers['x-forwarded-for'] === 'string') {
    const address = request.headers['x-forwarded-for'].split(',')[0].trim();
    if (address) return address;
  }
  return request.socket.remoteAddress || 'unknown';
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    let bytes = 0;
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request body is too large.'), { status: 413 }));
        request.destroy();
        return;
      }
      body += chunk;
    });
    request.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch { reject(Object.assign(new Error('Expected a JSON request body.'), { status: 400 })); }
    });
    request.on('error', reject);
  });
}

function descriptionIsValid(description, type) {
  return description && description.type === type && typeof description.sdp === 'string' && description.sdp.length > 0 && description.sdp.length <= 200_000;
}

function secretMatches(session, suppliedSecret) {
  if (typeof suppliedSecret !== 'string' || suppliedSecret.length > 100) return false;
  const digest = createHash('sha256').update(suppliedSecret).digest();
  return timingSafeEqual(session.secretDigest, digest);
}

function sweepExpiredSessions() {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (session.expiresAt <= now) sessions.delete(id);
  }
  for (const [address, timestamps] of createRequests) {
    const recent = timestamps.filter((timestamp) => now - timestamp < 60_000);
    if (recent.length) createRequests.set(address, recent);
    else createRequests.delete(address);
  }
  for (const [id, device] of devices) if (device.expiresAt <= now) devices.delete(id);
  for (const [key, timestamps] of deviceConnectRequests) {
    const recent = timestamps.filter((timestamp) => now - timestamp < DEVICE_CONNECT_WINDOW_MS);
    if (recent.length) deviceConnectRequests.set(key, recent);
    else deviceConnectRequests.delete(key);
  }
}

const cleanupTimer = setInterval(sweepExpiredSessions, 60_000);
cleanupTimer.unref?.();

export function createSignalingMiddleware() {
  return async (request, response, next) => {
    const requestUrl = new URL(request.url || '/', 'http://localhost');
    if (!requestUrl.pathname.startsWith('/api/')) return next();

    try {
      sweepExpiredSessions();
      if (requestUrl.pathname === '/api/sessions' && request.method === 'POST') {
        const address = clientAddress(request);
        const recentCreates = (createRequests.get(address) || []).filter((timestamp) => Date.now() - timestamp < 60_000);
        if (recentCreates.length >= MAX_CREATES_PER_MINUTE) return sendJson(response, 429, { error: 'Too many sessions from this network. Try again in a minute.' });
        if (sessions.size >= MAX_ACTIVE_SESSIONS) return sendJson(response, 503, { error: 'The signaling server is at capacity.' });
        const payload = await readJson(request);
        if (!descriptionIsValid(payload.offer, 'offer')) return sendJson(response, 400, { error: 'A valid WebRTC offer is required.' });
        let id;
        do { id = randomBytes(5).toString('hex'); } while (sessions.has(id));
        const secret = randomBytes(18).toString('base64url');
        const expiresAt = Date.now() + SESSION_TTL_MS;
        createRequests.set(address, [...recentCreates, Date.now()]);
        sessions.set(id, {
          secretDigest: createHash('sha256').update(secret).digest(),
          offer: payload.offer,
          answer: null,
          expiresAt,
        });
        return sendJson(response, 201, { code: `${id}.${secret}`, expiresAt });
      }

      const deviceMatch = requestUrl.pathname.match(/^\/api\/devices\/([a-f0-9]{16})\/(register|connect|answer)$/);
      if (deviceMatch) {
        const [, id, action] = deviceMatch;
        const now = Date.now();
        let device = devices.get(id);

        if (action === 'register' && request.method === 'POST') {
          const payload = await readJson(request);
          if (typeof payload.ownerKey !== 'string' || payload.ownerKey.length < 32 || payload.ownerKey.length > 100) return sendJson(response, 400, { error: 'Invalid device credentials.' });
          if (typeof payload.password !== 'string' || payload.password.length < 12 || payload.password.length > 128) return sendJson(response, 400, { error: 'Device password must contain 12 to 128 characters.' });
          if (!descriptionIsValid(payload.offer, 'offer')) return sendJson(response, 400, { error: 'A valid WebRTC offer is required.' });
          if (device && device.expiresAt <= now) { devices.delete(id); device = null; }
          if (!device && devices.size >= MAX_ACTIVE_DEVICES) return sendJson(response, 503, { error: 'The signaling server is at device capacity.' });
          if (device && !secretMatches({ secretDigest: device.ownerDigest }, payload.ownerKey)) return sendJson(response, 409, { error: 'This device ID is already registered.' });
          const salt = randomBytes(16);
          const passwordDigest = await scrypt(payload.password, salt, 64);
          const ownerDigest = createHash('sha256').update(payload.ownerKey).digest();
          devices.set(id, {
            ownerDigest,
            passwordSalt: salt,
            passwordDigest,
            offer: payload.offer,
            answer: null,
            guestSecretDigest: null,
            expiresAt: now + DEVICE_TTL_MS,
          });
          return sendJson(response, 201, { registered: true, expiresAt: now + DEVICE_TTL_MS });
        }

        if (action === 'connect' && request.method === 'POST') {
          const address = clientAddress(request);
          const key = `${address}:${id}`;
          const attempts = (deviceConnectRequests.get(key) || []).filter((timestamp) => now - timestamp < DEVICE_CONNECT_WINDOW_MS);
          if (attempts.length >= MAX_DEVICE_CONNECTS_PER_WINDOW) return sendJson(response, 429, { error: 'Too many password attempts. Try again later.' });
          deviceConnectRequests.set(key, [...attempts, now]);
          const payload = await readJson(request);
          if (typeof payload.password !== 'string' || payload.password.length > 128 || !device || device.expiresAt <= now) return sendJson(response, 403, { error: 'Device ID or password is incorrect, or the device is offline.' });
          const digest = await scrypt(payload.password, device.passwordSalt, 64);
          if (!timingSafeEqual(device.passwordDigest, digest)) return sendJson(response, 403, { error: 'Device ID or password is incorrect, or the device is offline.' });
          if (device.guestSecretDigest) return sendJson(response, 409, { error: 'This device is already handling a connection request.' });
          const secret = randomBytes(32).toString('base64url');
          device.guestSecretDigest = createHash('sha256').update(secret).digest();
          device.answer = null;
          return sendJson(response, 200, { offer: device.offer, secret, expiresAt: device.expiresAt });
        }

        if (action === 'connect' && request.method === 'DELETE') {
          if (!device || !secretMatches({ secretDigest: device.guestSecretDigest }, request.headers['x-device-session-key'])) return sendJson(response, 403, { error: 'Invalid device connection.' });
          device.guestSecretDigest = null;
          device.answer = null;
          return sendJson(response, 200, { closed: true });
        }

        if (action === 'answer' && request.method === 'POST') {
          const payload = await readJson(request);
          if (!device || device.expiresAt <= now || !device.guestSecretDigest || !secretMatches({ secretDigest: device.guestSecretDigest }, payload.secret)) return sendJson(response, 403, { error: 'Invalid device connection.' });
          if (device.answer) return sendJson(response, 409, { error: 'A connection answer has already been submitted.' });
          if (!descriptionIsValid(payload.answer, 'answer')) return sendJson(response, 400, { error: 'A valid WebRTC answer is required.' });
          device.answer = payload.answer;
          return sendJson(response, 201, { accepted: true });
        }

        if (action === 'answer' && request.method === 'GET') {
          if (!device || device.expiresAt <= now) return sendJson(response, 404, { error: 'Device is offline.' });
          if (!secretMatches({ secretDigest: device.ownerDigest }, request.headers['x-device-key'])) return sendJson(response, 403, { error: 'Invalid device credentials.' });
          device.expiresAt = now + DEVICE_TTL_MS;
          const answer = device.answer;
          if (answer) { device.answer = null; device.guestSecretDigest = null; }
          return sendJson(response, 200, { answer, expiresAt: device.expiresAt });
        }

        if (action === 'register' && request.method === 'DELETE') {
          if (!device || !secretMatches({ secretDigest: device.ownerDigest }, request.headers['x-device-key'])) return sendJson(response, 403, { error: 'Invalid device credentials.' });
          devices.delete(id);
          return sendJson(response, 200, { closed: true });
        }
      }

      const match = requestUrl.pathname.match(/^\/api\/sessions\/([a-f0-9]{10})(?:\/(offer|answer))?$/);
      if (!match) return sendJson(response, 404, { error: 'Session endpoint not found.' });
      const [, id, resource] = match;
      const session = sessions.get(id);
      if (!session) return sendJson(response, 404, { error: 'Session expired or does not exist.' });

      if (request.method === 'GET' && resource === 'offer') {
        if (!secretMatches(session, request.headers['x-session-key'])) return sendJson(response, 403, { error: 'Invalid session code.' });
        return sendJson(response, 200, { offer: session.offer, expiresAt: session.expiresAt });
      }

      if (request.method === 'POST' && resource === 'answer') {
        const payload = await readJson(request);
        if (!secretMatches(session, payload.secret)) return sendJson(response, 403, { error: 'Invalid session code.' });
        if (session.answer) return sendJson(response, 409, { error: 'Another participant has already answered this session.' });
        if (!descriptionIsValid(payload.answer, 'answer')) return sendJson(response, 400, { error: 'A valid WebRTC answer is required.' });
        session.answer = payload.answer;
        return sendJson(response, 201, { accepted: true });
      }

      if (request.method === 'GET' && resource === 'answer') {
        if (!secretMatches(session, request.headers['x-session-key'])) return sendJson(response, 403, { error: 'Invalid session code.' });
        return sendJson(response, 200, { answer: session.answer, expiresAt: session.expiresAt });
      }

      if (request.method === 'DELETE' && !resource) {
        if (!secretMatches(session, request.headers['x-session-key'])) return sendJson(response, 403, { error: 'Invalid session code.' });
        sessions.delete(id);
        return sendJson(response, 200, { closed: true });
      }

      return sendJson(response, 405, { error: 'Method not allowed.' });
    } catch (error) {
      if (response.headersSent || response.destroyed) return;
      return sendJson(response, error.status || 500, { error: error.status ? error.message : 'Signaling request failed.' });
    }
  };
}
