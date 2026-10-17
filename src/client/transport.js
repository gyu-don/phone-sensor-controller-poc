export class RoomSocket {
  constructor({ room, token, role, onMessage, onStatus }) {
    Object.assign(this, { room, token, role, onMessage, onStatus });
    this.clientId = sessionStorage.getItem(`sensor-client-${role}`) || crypto.randomUUID().replaceAll('-', '');
    sessionStorage.setItem(`sensor-client-${role}`, this.clientId);
    this.attempt = 0; this.closed = false; this.lastReceived = 0; this.sent = 0;
  }
  connect() {
    if (this.closed) return;
    clearTimeout(this.retry);
    this.onStatus('connecting');
    const url = new URL(`/api/rooms/${this.room}/socket`, location.href);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    url.search = new URLSearchParams({ role: this.role, token: this.token, client: this.clientId });
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => { this.attempt = 0; this.lastReceived = Date.now(); this.onStatus('connected'); };
    ws.onmessage = event => {
      this.lastReceived = Date.now();
      try { const m = JSON.parse(event.data); if (m.type !== 'pong') this.onMessage(m); } catch { /* Ignore invalid server data. */ }
    };
    ws.onclose = event => {
      if (this.closed) return;
      if ([4001, 4004, 4008, 1008].includes(event.code)) { this.closed = true; this.onStatus('stopped', event.reason); return; }
      this.onStatus('disconnected');
      // HTTP 403/409/410 during upgrade cannot expose a close code to browsers.
      // Stop bounded retries and offer an explicit retry action.
      if (++this.attempt > 6) { this.closed = true; this.onStatus('stopped', '接続できません。別のスマホの接続やルームの有効期限を確認してください。'); return; }
      this.retry = setTimeout(() => this.connect(), Math.min(1000 * 2 ** (this.attempt - 1), 15000));
    };
    ws.onerror = () => {};
    clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => {
      if (this.ws?.readyState !== WebSocket.OPEN) return;
      if (Date.now() - this.lastReceived > 45000) this.ws.close();
      else this.send({ type: 'ping', t: Date.now() });
    }, 20000);
  }
  send(message) {
    if (this.ws?.readyState !== WebSocket.OPEN || this.ws.bufferedAmount > 8192) return false;
    this.ws.send(JSON.stringify(message)); this.sent++; return true;
  }
  close() { this.closed = true; clearTimeout(this.retry); clearInterval(this.heartbeat); this.ws?.close(1000, 'Page closed'); }
}
