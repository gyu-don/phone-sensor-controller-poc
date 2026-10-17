import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { normalizeTuning } from '../src/shared/tuning.js';
const origin = process.env.TEST_ORIGIN || 'http://localhost:8787';
const wsOrigin = origin.replace(/^http/, 'ws');
const sockets = [];
const pause = ms => new Promise(r => setTimeout(r, ms));

function connect(room, token, role, client = crypto.randomUUID().replaceAll('-', '')) {
  const ws = new WebSocket(`${wsOrigin}/api/rooms/${room}/socket?${new URLSearchParams({ token, role, client })}`);
  const inbox = [];
  ws.addEventListener('message', e => inbox.push(JSON.parse(e.data)));
  const opened = new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  async function receive(predicate) {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const index = inbox.findIndex(predicate);
      if (index >= 0) return inbox.splice(index, 1)[0];
      await pause(15);
    }
    throw new Error(`Timed out waiting for message; received types: ${inbox.map(m => m.type)}`);
  }
  sockets.push(ws);
  return { ws, inbox, opened, receive, send: m => ws.send(JSON.stringify(m)) };
}
function upgradeStatus(path) {
  return new Promise((resolve, reject) => {
    const req = (origin.startsWith('https:') ? https : http).request(`${origin}${path}`, { headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==' } });
    req.on('response', res => { res.resume(); resolve(res.statusCode); });
    req.on('upgrade', (res, socket) => { socket.destroy(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
}
try {
  for (const path of ['/', '/controller', '/display.js', '/controller.js']) {
    const response = await fetch(`${origin}${path}`);
    assert.equal(response.status, 200, path);
    if (path === '/controller') assert.match(await response.text(), /PHONE CONTROLLER/);
  }
  assert.equal((await fetch(`${origin}/api/rooms`, { method: 'POST', headers: { Origin: 'https://other.example' } })).status, 403);
  const response = await fetch(`${origin}/api/rooms`, { method: 'POST' });
  assert.equal(response.status, 201);
  const room = await response.json();
  let display = connect(room.room, room.host, 'display'); await display.opened;
  assert.equal((await display.receive(m => m.type === 'welcome')).role, 'display');
  const config = { type: 'config', sensitivity: 1.4, ySensitivity: 1.7, invertX: true, invertY: false };
  display.send(config);
  const client = 'integration-phone';
  const controller = connect(room.room, room.controller, 'controller', client); await controller.opened;
  assert.equal((await controller.receive(m => m.type === 'welcome')).role, 'controller');
  assert.equal((await display.receive(m => m.type === 'presence' && m.controller)).controller, true);
  assert.deepEqual(await controller.receive(m => m.type === 'config'), config);
  const settings = { type: 'settings', values: normalizeTuning({ sensitivity: 1.5, xSensitivity: 1.2, ySensitivity: 1.7, motionThreshold: .06, stopDelayMs: 1200 }) };
  controller.send(settings);
  assert.deepEqual(await display.receive(m => m.type === 'settings'), settings, 'controller owns all tuning');
  const newDisplay = connect(room.room, room.host, 'display'); await newDisplay.opened;
  assert.deepEqual(await newDisplay.receive(m => m.type === 'settings'), settings, 'phone settings replay after display reload');
  display = newDisplay;
  const input = { type: 'input', seq: 1, epoch: 1, x: 50, y: 10, stroke: 1, land: 0, moving: true, landing: 'none', landingProgress: 0.3, status: 'ready', ax: 1.5, ay: 0.2, az: 0, hz: 60 };
  controller.send(input);
  assert.deepEqual(await display.receive(m => m.type === 'input'), input);
  const duplicate = `/api/rooms/${room.room}/socket?${new URLSearchParams({ role: 'controller', token: room.controller, client: 'another-phone' })}`;
  assert.equal(await upgradeStatus(duplicate), 409, 'only one phone');
  assert.equal(await upgradeStatus(duplicate.replace(room.controller, room.host)), 403, 'role-specific token');
  const reconnect = connect(room.room, room.controller, 'controller', client); await reconnect.opened;
  assert.deepEqual(await reconnect.receive(m => m.type === 'config'), config, 'config survives controller reconnect');
  reconnect.send({ ...input, seq: 2, x: 90 });
  assert.equal((await display.receive(m => m.type === 'input')).x, 90);
  reconnect.send({ type: 'ping', t: 123 });
  assert.equal((await reconnect.receive(m => m.type === 'pong')).t, 123);
  const closed = new Promise(r => reconnect.ws.addEventListener('close', r, { once: true }));
  reconnect.send({ type: 'reset' });
  assert.equal((await closed).code, 1008, 'controller cannot reset or send game state');
  assert.equal((await fetch(`${origin}/api/unknown`)).status, 404);
  console.log('PASS: static routes, room creation, origin validation, role tokens, input relay, one phone, reconnect, controller tuning, settings replay, legacy config, heartbeat, message restrictions.');
} finally {
  for (const ws of sockets) ws.close();
}
