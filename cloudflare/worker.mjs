import { DurableObject } from 'cloudflare:workers';

const SESSION_TTL = 45 * 60 * 1000;
const DEVICE_TTL = 3 * 60 * 1000;
const CONNECT_WINDOW = 15 * 60 * 1000;
const MAX_CONNECTS = 8;
const MAX_BODY = 256 * 1024;
const encoder = new TextEncoder();

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function fail(status, error) { return json({ error }, status); }

function randomHex(bytes) {
  const value = crypto.getRandomValues(new Uint8Array(bytes));
  return [...value].map((part) => part.toString(16).padStart(2, '0')).join('');
}

function randomSecret(bytes) {
  const value = crypto.getRandomValues(new Uint8Array(bytes));
  let binary = '';
  for (const part of value) binary += String.fromCharCode(part);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function fromHex(value) {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index++) bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

function toHex(value) { return [...new Uint8Array(value)].map((part) => part.toString(16).padStart(2, '0')).join(''); }

function equalBytes(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference |= left[index] ^ right[index];
  return difference === 0;
}

async function digest(value) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', typeof value === 'string' ? encoder.encode(value) : value));
}

async function passwordDigest(password, saltHex) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: fromHex(saltHex), iterations: 150_000 }, key, 256);
  return toHex(bits);
}

async function readJson(request) {
  if (Number(request.headers.get('Content-Length') || 0) > MAX_BODY) throw Object.assign(new Error('Request body is too large.'), { status: 413 });
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > MAX_BODY) throw Object.assign(new Error('Request body is too large.'), { status: 413 });
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw Object.assign(new Error('Expected a JSON request body.'), { status: 400 }); }
}

function validDescription(value, type) {
  return value && value.type === type && typeof value.sdp === 'string' && value.sdp.length > 0 && value.sdp.length <= 200_000;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      if (!['GET', 'POST', 'DELETE'].includes(request.method)) return fail(405, 'Method not allowed.');
      if (url.pathname === '/api/sessions' && request.method === 'POST') {
        try {
          const payload = await readJson(request);
          if (!validDescription(payload.offer, 'offer')) return fail(400, 'A valid WebRTC offer is required.');
          const address = request.headers.get('CF-Connecting-IP') || 'development';
          const limiterName = `create:${toHex(await digest(address))}`;
          const limiter = env.SIGNAL_ROOMS.get(env.SIGNAL_ROOMS.idFromName(limiterName));
          const limitResponse = await limiter.fetch('https://signal.internal/limit/create', { method: 'POST' });
          if (!limitResponse.ok) return limitResponse;
          let id;
          do { id = randomHex(5); }
          while (!/^[a-f0-9]{10}$/.test(id));
          const secret = randomSecret(18);
          const stub = env.SIGNAL_ROOMS.get(env.SIGNAL_ROOMS.idFromName(id));
          const result = await stub.fetch('https://signal.internal/session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ offer: payload.offer, secret, expiresAt: Date.now() + SESSION_TTL }),
          });
          if (!result.ok) return result;
          return json({ code: `${id}.${secret}`, expiresAt: Date.now() + SESSION_TTL }, 201);
        } catch (error) {
          return fail(error.status || 500, error.status ? error.message : 'Signaling request failed.');
        }
      }

      const id = url.pathname.match(/^\/api\/(?:sessions|devices)\/([a-f0-9]{10}|[a-f0-9]{16})(?:\/|$)/)?.[1];
      if (!id) return fail(404, 'Session endpoint not found.');
      return env.SIGNAL_ROOMS.get(env.SIGNAL_ROOMS.idFromName(id)).fetch(request);
    }

    if (url.pathname === '/') return Response.redirect(new URL('/remote-assist/', url), 302);
    const asset = await env.ASSETS.fetch(request);
    const headers = new Headers(asset.headers);
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Referrer-Policy', 'no-referrer');
    headers.set('X-Frame-Options', 'DENY');
    return new Response(asset.body, { status: asset.status, statusText: asset.statusText, headers });
  },
};

export class SignalRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
  }

  async liveRecord(key) {
    const record = await this.ctx.storage.get(key);
    if (record && record.expiresAt <= Date.now()) {
      await this.ctx.storage.delete(key);
      if (key === 'device') await this.ctx.storage.delete('connectAttempts');
      return null;
    }
    return record || null;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/session' && request.method === 'POST') {
      try {
        const payload = await readJson(request);
        if (!validDescription(payload.offer, 'offer') || typeof payload.secret !== 'string') return fail(400, 'A valid WebRTC offer is required.');
        await this.ctx.storage.put('session', {
          secretDigest: toHex(await digest(payload.secret)),
          offer: payload.offer,
          answer: null,
          expiresAt: payload.expiresAt,
        });
        await this.ctx.storage.setAlarm(payload.expiresAt);
        return json({ created: true }, 201);
      } catch (error) { return fail(error.status || 500, error.status ? error.message : 'Signaling request failed.'); }
    }

    if (url.pathname === '/limit/create' && request.method === 'POST') {
      const now = Date.now();
      const attempts = (await this.ctx.storage.get('createAttempts') || []).filter((time) => now - time < 60_000);
      if (attempts.length >= 20) return fail(429, 'Too many sessions from this network. Try again in a minute.');
      attempts.push(now);
      await this.ctx.storage.put('createAttempts', attempts);
      await this.ctx.storage.setAlarm(now + 60_000);
      return json({ allowed: true });
    }

    const deviceMatch = url.pathname.match(/^\/api\/devices\/([a-f0-9]{16})\/(register|connect|answer)$/);
    if (deviceMatch) return this.handleDevice(request, deviceMatch[2]);

    const sessionMatch = url.pathname.match(/^\/api\/sessions\/([a-f0-9]{10})(?:\/(offer|answer))?$/);
    if (!sessionMatch) return fail(404, 'Session endpoint not found.');
    return this.handleSession(request, sessionMatch[2]);
  }

  async handleSession(request, resource) {
    let session = await this.liveRecord('session');
    if (!session) return fail(404, 'Session expired or does not exist.');
    const url = new URL(request.url);
    const suppliedKey = request.headers.get('X-Session-Key') || '';

    if (request.method === 'GET' && resource === 'offer') {
      if (!equalBytes(await digest(suppliedKey), fromHex(session.secretDigest))) return fail(403, 'Invalid session code.');
      return json({ offer: session.offer, expiresAt: session.expiresAt });
    }
    if (request.method === 'POST' && resource === 'answer') {
      try {
        const payload = await readJson(request);
        if (!equalBytes(await digest(payload.secret || ''), fromHex(session.secretDigest))) return fail(403, 'Invalid session code.');
        if (session.answer) return fail(409, 'Another participant has already answered this session.');
        if (!validDescription(payload.answer, 'answer')) return fail(400, 'A valid WebRTC answer is required.');
        session.answer = payload.answer;
        await this.ctx.storage.put('session', session);
        return json({ accepted: true }, 201);
      } catch (error) { return fail(error.status || 500, error.status ? error.message : 'Signaling request failed.'); }
    }
    if (request.method === 'GET' && resource === 'answer') {
      if (!equalBytes(await digest(suppliedKey), fromHex(session.secretDigest))) return fail(403, 'Invalid session code.');
      return json({ answer: session.answer, expiresAt: session.expiresAt });
    }
    if (request.method === 'DELETE' && !resource) {
      if (!equalBytes(await digest(suppliedKey), fromHex(session.secretDigest))) return fail(403, 'Invalid session code.');
      await this.ctx.storage.delete('session');
      await this.ctx.storage.deleteAlarm();
      return json({ closed: true });
    }
    return fail(405, 'Method not allowed.');
  }

  async handleDevice(request, action) {
    const now = Date.now();
    let device = await this.liveRecord('device');

    if (action === 'register' && request.method === 'POST') {
      try {
        const payload = await readJson(request);
        if (typeof payload.ownerKey !== 'string' || payload.ownerKey.length < 32 || payload.ownerKey.length > 100) return fail(400, 'Invalid device credentials.');
        if (typeof payload.password !== 'string' || payload.password.length < 12 || payload.password.length > 128) return fail(400, 'Device password must contain 12 to 128 characters.');
        if (!validDescription(payload.offer, 'offer')) return fail(400, 'A valid WebRTC offer is required.');
        if (device && !equalBytes(await digest(payload.ownerKey), fromHex(device.ownerDigest))) return fail(409, 'This device ID is already registered.');
        const salt = randomHex(16);
        const expiresAt = now + DEVICE_TTL;
        device = {
          ownerDigest: toHex(await digest(payload.ownerKey)),
          passwordSalt: salt,
          passwordDigest: await passwordDigest(payload.password, salt),
          offer: payload.offer,
          answer: null,
          guestSecretDigest: null,
          expiresAt,
        };
        await this.ctx.storage.put('device', device);
        await this.ctx.storage.put('connectAttempts', []);
        await this.ctx.storage.setAlarm(expiresAt);
        return json({ registered: true, expiresAt }, 201);
      } catch (error) { return fail(error.status || 500, error.status ? error.message : 'Signaling request failed.'); }
    }

    if (action === 'connect' && request.method === 'POST') {
      try {
        const payload = await readJson(request);
        if (typeof payload.password !== 'string' || payload.password.length > 128 || !device) return fail(403, 'Device ID or password is incorrect, or the device is offline.');
        let attempts = await this.ctx.storage.get('connectAttempts') || [];
        attempts = attempts.filter((time) => now - time < CONNECT_WINDOW);
        if (attempts.length >= MAX_CONNECTS) return fail(429, 'Too many password attempts. Try again later.');
        attempts.push(now);
        await this.ctx.storage.put('connectAttempts', attempts);
        const supplied = await passwordDigest(payload.password, device.passwordSalt);
        if (!equalBytes(encoder.encode(supplied), encoder.encode(device.passwordDigest))) return fail(403, 'Device ID or password is incorrect, or the device is offline.');
        if (device.guestSecretDigest) return fail(409, 'This device is already handling a connection request.');
        const secret = randomSecret(32);
        device.guestSecretDigest = toHex(await digest(secret));
        device.answer = null;
        await this.ctx.storage.put('device', device);
        return json({ offer: device.offer, secret, expiresAt: device.expiresAt });
      } catch (error) { return fail(error.status || 500, error.status ? error.message : 'Signaling request failed.'); }
    }

    if (action === 'connect' && request.method === 'DELETE') {
      if (!device?.guestSecretDigest || !equalBytes(await digest(request.headers.get('X-Device-Session-Key') || ''), fromHex(device.guestSecretDigest))) return fail(403, 'Invalid device connection.');
      device.guestSecretDigest = null;
      device.answer = null;
      await this.ctx.storage.put('device', device);
      return json({ closed: true });
    }

    if (action === 'answer' && request.method === 'POST') {
      try {
        const payload = await readJson(request);
        if (!device || !device.guestSecretDigest || !equalBytes(await digest(payload.secret || ''), fromHex(device.guestSecretDigest))) return fail(403, 'Invalid device connection.');
        if (device.answer) return fail(409, 'A connection answer has already been submitted.');
        if (!validDescription(payload.answer, 'answer')) return fail(400, 'A valid WebRTC answer is required.');
        device.answer = payload.answer;
        await this.ctx.storage.put('device', device);
        return json({ accepted: true }, 201);
      } catch (error) { return fail(error.status || 500, error.status ? error.message : 'Signaling request failed.'); }
    }

    if (action === 'answer' && request.method === 'GET') {
      if (!device) return fail(404, 'Device is offline.');
      if (!equalBytes(await digest(request.headers.get('X-Device-Key') || ''), fromHex(device.ownerDigest))) return fail(403, 'Invalid device credentials.');
      device.expiresAt = now + DEVICE_TTL;
      const answer = device.answer;
      if (answer) { device.answer = null; device.guestSecretDigest = null; }
      await this.ctx.storage.put('device', device);
      await this.ctx.storage.setAlarm(device.expiresAt);
      return json({ answer, expiresAt: device.expiresAt });
    }

    if (action === 'register' && request.method === 'DELETE') {
      if (!device || !equalBytes(await digest(request.headers.get('X-Device-Key') || ''), fromHex(device.ownerDigest))) return fail(403, 'Invalid device credentials.');
      await this.ctx.storage.delete('device');
      await this.ctx.storage.delete('connectAttempts');
      await this.ctx.storage.deleteAlarm();
      return json({ closed: true });
    }
    return fail(405, 'Method not allowed.');
  }

  async alarm() { await this.ctx.storage.deleteAll(); }
}
