import { DurableObject } from 'cloudflare:workers';
import { ROOM_TTL_MS, TOKEN_RE, CLIENT_RE, MAX_MESSAGE_BYTES, validInput, validConfig, validSettings } from '../shared/protocol.js';
import { normalizeTuning } from '../shared/tuning.js';
import { normalizeGameEvent, MAX_GAME_EVENT_BYTES } from '../shared/game-events.js';
import { handleMcpRequest, queueEventNotifications } from './mcp.js';

const json = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
const token = () => crypto.randomUUID().replaceAll('-', '');

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/mcp') return handleMcpRequest(request, env, ctx);
    if (url.pathname === '/api/game-events' && request.method === 'POST') {
      const origin = request.headers.get('Origin');
      if (origin && origin !== url.origin) return json({ error: 'Origin mismatch' }, 403);
      const raw = await request.text();
      if (new TextEncoder().encode(raw).byteLength > MAX_GAME_EVENT_BYTES) return json({ error: 'Event is too large' }, 413);
      let submitted;
      try { submitted = JSON.parse(raw); } catch { return json({ error: 'Invalid JSON' }, 400); }
      let event;
      try { event = normalizeGameEvent(submitted); } catch (error) { return json({ error: error.message }, 400); }
      const stub = env.GAME_EVENTS.get(env.GAME_EVENTS.idFromName('global-game-events'));
      const stored = await stub.fetch('https://events.internal/events/ingest', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event })
      });
      if (!stored.ok) return json({ error: 'Event could not be stored' }, 503);
      const result = await stored.json();
      queueEventNotifications(result, env, ctx);
      return json({ ok: true, event: result.event, duplicate: result.duplicate });
    }
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    // Browsers must pair from the same origin. There is no public CORS relay.
    const origin = request.headers.get('Origin');
    if (origin && origin !== url.origin && origin !== env.CONTROLLER_ORIGIN) return json({ error: 'Origin mismatch' }, 403);
    if (url.pathname === '/api/config' && request.method === 'GET') return json({ controllerOrigin: env.CONTROLLER_ORIGIN || url.origin });
    if (url.pathname === '/api/rooms' && request.method === 'POST') {
      const room = token(), host = token(), controller = token();
      const stub = env.ROOMS.get(env.ROOMS.idFromName(room));
      const res = await stub.fetch('https://room.internal/init', { method: 'POST', body: JSON.stringify({ host, controller, expires: Date.now() + ROOM_TTL_MS }) });
      if (!res.ok) return json({ error: 'Room creation failed' }, 503);
      return json({ room, host, controller }, 201);
    }
    const match = url.pathname.match(/^\/api\/rooms\/([a-f0-9]{32})\/socket$/);
    if (match && request.method === 'GET') return env.ROOMS.get(env.ROOMS.idFromName(match[1])).fetch(request);
    return json({ error: 'Not found' }, 404);
  }
};

export class SensorRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.meta = null;
    ctx.blockConcurrencyWhile(async () => { this.meta = await ctx.storage.get('meta') ?? null; });
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/init' && request.method === 'POST') {
      if (this.meta) return json({ error: 'Already exists' }, 409);
      this.meta = await request.json();
      await this.ctx.storage.put('meta', this.meta);
      await this.ctx.storage.setAlarm(this.meta.expires);
      return json({ ok: true });
    }
    if (!this.meta || this.meta.expires <= Date.now()) return json({ error: 'Room expired' }, 410);
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'WebSocket required' }, 426);
    const role = url.searchParams.get('role'), key = url.searchParams.get('token'), clientId = url.searchParams.get('client');
    if (!['display', 'controller'].includes(role) || !TOKEN_RE.test(key ?? '') || key !== this.meta[role === 'display' ? 'host' : 'controller'] || !CLIENT_RE.test(clientId ?? '')) return json({ error: 'Invalid pairing' }, 403);
    const current = this.peers(role);
    if (role === 'controller' && current.some(s => s.deserializeAttachment().clientId !== clientId)) return json({ error: 'Controller already connected' }, 409);
    for (const socket of current) socket.close(4001, 'Replaced by reconnect');
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, [role]);
    server.serializeAttachment({ role, clientId, window: Date.now(), count: 0, lastSeq: -1, config: role === 'display' ? current[0]?.deserializeAttachment()?.config : undefined, settings: role === 'controller' ? current[0]?.deserializeAttachment()?.settings : undefined });
    server.send(JSON.stringify({ type: 'welcome', role }));
    if (role === 'controller') {
      const config = this.peers('display')[0]?.deserializeAttachment()?.config;
      if (config) server.send(JSON.stringify(config));
    } else {
      const settings = this.peers('controller')[0]?.deserializeAttachment()?.settings;
      if (settings) server.send(JSON.stringify(settings));
    }
    this.presence();
    return new Response(null, { status: 101, webSocket: client });
  }

  peers(role) { return this.ctx.getWebSockets(role).filter(s => s.readyState === 1); }
  send(role, message) {
    const data = JSON.stringify(message);
    for (const s of this.peers(role)) { try { s.send(data); } catch { s.close(1011, 'Send failed'); } }
  }
  presence() {
    this.send('display', { type: 'presence', controller: this.peers('controller').length > 0 });
    this.send('controller', { type: 'presence', display: this.peers('display').length > 0 });
  }

  webSocketMessage(socket, data) {
    if (typeof data !== 'string' || data.length > MAX_MESSAGE_BYTES) return socket.close(1009, 'Message too large');
    const a = socket.deserializeAttachment(), now = Date.now();
    if (!this.meta || now >= this.meta.expires) return socket.close(4004, 'Room expired');
    if (now - a.window >= 1000) { a.window = now; a.count = 0; }
    // Client caps at 20 Hz; allow a little network burst. No per-frame storage.
    if (++a.count > (a.role === 'controller' ? 35 : 12)) return socket.close(4008, 'Rate limit');
    let message;
    try { message = JSON.parse(data); } catch { return socket.close(1007, 'Invalid JSON'); }
    if (!message || typeof message !== 'object' || Array.isArray(message)) return socket.close(1008, 'Message not allowed');
    if (message.type === 'ping') {
      socket.send(JSON.stringify({ type: 'pong', t: message.t }));
    } else if (a.role === 'controller' && validInput(message)) {
      if (message.seq <= a.lastSeq) return;
      a.lastSeq = message.seq;
      this.send('display', message);
    } else if (a.role === 'display' && validConfig(message)) {
      a.config = { type: 'config', sensitivity: message.sensitivity, invertX: message.invertX, invertY: message.invertY };
      if (message.ySensitivity !== undefined) a.config.ySensitivity = message.ySensitivity;
      this.send('controller', a.config);
    } else if (a.role === 'controller' && validSettings(message)) {
      a.settings = { type: 'settings', values: normalizeTuning(message.values) };
      this.send('display', a.settings);
    } else return socket.close(1008, 'Message not allowed');
    socket.serializeAttachment(a);
  }

  webSocketClose(socket, code, reason) {
    // 1005/1006 are receive-only sentinels and cannot be sent in a close frame.
    try { socket.close([1005, 1006, 1015].includes(code) ? 1000 : code, reason); } catch { /* Runtime may already have closed it. */ }
    this.presence();
  }
  webSocketError(socket) { socket.close(1011, 'Connection error'); this.presence(); }
  async alarm() {
    for (const s of this.ctx.getWebSockets()) s.close(4004, 'Room expired');
    this.meta = null;
    await this.ctx.storage.deleteAll();
  }
}

export class GameEventStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
  }

  async scheduleCleanup(subscriptions = null) {
    const active = (subscriptions ?? await this.ctx.storage.get('subscriptions') ?? []).filter(item => item.expiresAt > Date.now());
    if (active.length) await this.ctx.storage.setAlarm(Math.min(...active.map(item => item.expiresAt)));
    else await this.ctx.storage.deleteAlarm();
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method !== 'POST') return json({ error: 'POST required' }, 405);
    let body;
    try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

    if (url.pathname === '/callbacks/is-verified') {
      const callbacks = await this.ctx.storage.get('verifiedCallbacks') ?? {};
      const now = Date.now();
      for (const [fingerprint, expiresAt] of Object.entries(callbacks)) if (expiresAt <= now) delete callbacks[fingerprint];
      await this.ctx.storage.put('verifiedCallbacks', callbacks);
      return json({ verified: callbacks[body.fingerprint] > now });
    }

    if (url.pathname === '/callbacks/mark-verified') {
      const callbacks = await this.ctx.storage.get('verifiedCallbacks') ?? {};
      callbacks[body.fingerprint] = body.expiresAt;
      await this.ctx.storage.put('verifiedCallbacks', callbacks);
      return json({ ok: true });
    }

    if (url.pathname === '/events/ingest') {
      const event = body?.event;
      if (!event || typeof event.eventId !== 'string') return json({ error: 'Invalid event' }, 400);
      const now = Date.now();
      let rate = await this.ctx.storage.get('ingestRate') ?? { start: now, count: 0 };
      if (now - rate.start >= 60_000) rate = { start: now, count: 0 };
      if (rate.count >= 60) return json({ error: 'Event submission limit reached; retry later.' }, 429);
      rate.count++;
      await this.ctx.storage.put('ingestRate', rate);
      const events = await this.ctx.storage.get('events') ?? [];
      const duplicate = events.find(saved => saved.eventId === event.eventId);
      if (duplicate) return json({ event: duplicate, duplicate: true, subscriptions: [] });
      const sequence = (await this.ctx.storage.get('sequence') ?? 0) + 1;
      const storedEvent = { ...event, cursor: String(sequence) };
      events.push(storedEvent);
      if (events.length > 100) events.splice(0, events.length - 100);
      await this.ctx.storage.put({ events, sequence });
      const subscriptions = (await this.ctx.storage.get('subscriptions') ?? [])
        .filter(subscription => subscription.expiresAt > now && subscription.name === storedEvent.name)
        .filter(subscription => subscription.arguments.achievement_id === undefined || subscription.arguments.achievement_id === storedEvent.data.achievement_id)
        .filter(subscription => subscription.arguments.is_first_clear === undefined || subscription.arguments.is_first_clear === storedEvent.data.is_first_clear);
      return json({ event: storedEvent, duplicate: false, subscriptions });
    }

    if (url.pathname === '/events/recent') {
      const events = await this.ctx.storage.get('events') ?? [];
      const limit = Math.max(1, Math.min(50, Number.isInteger(body.limit) ? body.limit : 10));
      const after = body.afterCursor === null ? null : Number(body.afterCursor);
      const selected = after === null ? events.slice(-limit) : events.filter(event => Number(event.cursor) > after).slice(0, limit);
      const oldest = events.length ? Number(events[0].cursor) : 0;
      const latest = await this.ctx.storage.get('sequence') ?? 0;
      return json({ events: selected, latest_cursor: latest ? String(latest) : null, truncated: after !== null && after < oldest - 1 });
    }

    if (url.pathname === '/subscriptions/upsert') {
      const subscriptions = (await this.ctx.storage.get('subscriptions') ?? []).filter(item => item.expiresAt > Date.now());
      const sequence = await this.ctx.storage.get('sequence') ?? 0;
      const existingIndex = subscriptions.findIndex(subscription => subscription.id === body.subscription?.id);
      const previous = existingIndex < 0 ? null : subscriptions[existingIndex];
      const cursor = body.cursor === null || body.cursor === undefined ? previous?.cursor ?? (sequence ? String(sequence) : null) : body.cursor;
      const subscription = { ...body.subscription, cursor };
      if (existingIndex < 0 && subscriptions.length >= 200) return json({ error: 'Subscription limit reached' }, 429);
      if (existingIndex < 0) subscriptions.push(subscription);
      else subscriptions[existingIndex] = subscription;
      await this.ctx.storage.put('subscriptions', subscriptions);
      await this.scheduleCleanup(subscriptions);
      const events = await this.ctx.storage.get('events') ?? [];
      const oldest = events.length ? Number(events[0].cursor) : 0;
      const truncated = cursor !== null && events.length > 0 && Number(cursor) < oldest - 1;
      const replay = cursor === null ? [] : events.filter(event => Number(event.cursor) > Number(cursor))
        .filter(event => event.name === subscription.name)
        .filter(event => subscription.arguments.achievement_id === undefined || subscription.arguments.achievement_id === event.data.achievement_id)
        .filter(event => subscription.arguments.is_first_clear === undefined || subscription.arguments.is_first_clear === event.data.is_first_clear);
      return json({ subscription, replay, truncated });
    }

    if (url.pathname === '/subscriptions/advance') {
      const subscriptions = await this.ctx.storage.get('subscriptions') ?? [];
      const subscription = subscriptions.find(item => item.id === body.id);
      if (subscription && Number(body.cursor) > Number(subscription.cursor ?? 0)) {
        subscription.cursor = String(body.cursor);
        await this.ctx.storage.put('subscriptions', subscriptions);
      }
      return json({ ok: true });
    }

    if (url.pathname === '/subscriptions/delete') {
      const subscriptions = await this.ctx.storage.get('subscriptions') ?? [];
      const remaining = subscriptions.filter(item => item.id !== body.id);
      await this.ctx.storage.put('subscriptions', remaining);
      await this.scheduleCleanup(remaining);
      return json({ ok: true });
    }

    return json({ error: 'Not found' }, 404);
  }

  async alarm() {
    const now = Date.now();
    const subscriptions = (await this.ctx.storage.get('subscriptions') ?? []).filter(item => item.expiresAt > now);
    await this.ctx.storage.put('subscriptions', subscriptions);
    const callbacks = await this.ctx.storage.get('verifiedCallbacks') ?? {};
    for (const [fingerprint, expiresAt] of Object.entries(callbacks)) if (expiresAt <= now) delete callbacks[fingerprint];
    await this.ctx.storage.put('verifiedCallbacks', callbacks);
    await this.scheduleCleanup(subscriptions);
  }
}
