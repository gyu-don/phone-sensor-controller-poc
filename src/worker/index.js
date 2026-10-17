import { DurableObject } from 'cloudflare:workers';
import { ROOM_TTL_MS, TOKEN_RE, CLIENT_RE, MAX_MESSAGE_BYTES, validInput, validConfig, validSettings } from '../shared/protocol.js';
import { normalizeTuning } from '../shared/tuning.js';

const json = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
const token = () => crypto.randomUUID().replaceAll('-', '');

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
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
