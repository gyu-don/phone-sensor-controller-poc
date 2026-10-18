import qrcode from 'qrcode-generator';
import { Game, WIDTH, HEIGHT } from './game.js';
import { RoomSocket } from './transport.js';
import { validInput, validSettings } from '../shared/protocol.js';

const $ = id => document.getElementById(id);
const DEFAULT_GAME_EVENT = {
  eventId: 'evt_boss_clear_001',
  name: 'achievement.unlocked',
  timestamp: '2026-10-18T02:00:00Z',
  data: {
    achievement_id: 'first_boss',
    achievement_name: '初めてのボス撃破',
    attempts: 12,
    is_first_clear: true,
    description: '12回の挑戦を経て最初のボスを倒した'
  },
  cursor: null
};
const canvas = $('stage'), ctx = canvas.getContext('2d');
const game = new Game();
let roomInfo, socket, controllerPresent = false, networkReady = false, sensorStatus = '';
let packets = 0, lastInput = null, lastInputAt = 0, reconnectBaseline = true, controllerUrl = '';
const log = [];
const cleanCanvas = document.createElement('canvas');
cleanCanvas.width = WIDTH; cleanCanvas.height = HEIGHT;
const cleanCtx = cleanCanvas.getContext('2d');
let cleanVersion = -1, lastEvent = '';
let phoneConfig = null;
let feedbackAt = -Infinity, feedbackTimer;

function updateConnection() {
  const ready = networkReady && controllerPresent;
  $('connection-dot').className = `dot ${ready ? 'connected' : ''}`;
  $('connection-text').textContent = !networkReady ? 'サーバーに接続中' : !controllerPresent ? 'スマホの接続を待っています' : sensorStatus === 'ready' ? '接続済み · 入力受付中' : sensorStatus === 'calibrating' ? '接続済み · スマホを校正中' : sensorStatus === 'paused' ? '接続済み · 入力を一時停止' : sensorStatus === 'error' ? '接続済み · センサーを確認' : '接続済み · センサーを有効に';
}
function showSettings(m) {
  if (!validSettings(m)) return;
  phoneConfig = m.values;
  $('settings-summary').textContent = `全体 ${phoneConfig.sensitivity.toFixed(1)}× / 左右 ${phoneConfig.xSensitivity.toFixed(1)}× / 上下 ${phoneConfig.ySensitivity.toFixed(1)}× / 小さな動きの無視 ${phoneConfig.motionThreshold.toFixed(2)} m/s²`;
}

function onInput(m) {
  if (!validInput(m)) return;
  packets++; lastInputAt = Date.now(); sensorStatus = m.status;
  const previous = lastInput;
  if (reconnectBaseline) { game.baseline(); reconnectBaseline = false; }
  const contact = game.contactId;
  game.apply(m); lastInput = m;
  if (game.contactId !== contact) {
    feedbackAt = performance.now();
    $('landing-feedback').textContent = game.feedback.text;
    $('landing-feedback').className = `landing-feedback visible ${game.feedback.kind}`;
    clearTimeout(feedbackTimer);
    feedbackTimer = setTimeout(() => { $('landing-feedback').classList.remove('visible'); }, 1500);
  }
  $('landing-state').textContent = (m.landingProgress ?? 0) > 0 ? '◎ 着地を確認中…' : '着地で操作';
  updateConnection();
  const dx = previous && m.epoch === previous.epoch ? m.x - previous.x : 0;
  const dy = previous && m.epoch === previous.epoch ? m.y - previous.y : 0;
  $('sensor-summary').textContent = `${m.status} · ${m.hz.toFixed(0)} Hz · 受信中`;
  $('telemetry-hz').textContent = `${m.hz.toFixed(0)} Hz → ≤20 Hz`;
  $('telemetry-rx').textContent = `${packets} packets`;
  $('telemetry-motion').textContent = m.status === 'ready' ? m.moving ? '移動中' : '静止' : m.status;
  $('telemetry-land').textContent = `${m.land} / ${m.landing === 'impact' ? '着地確定' : m.landing === 'still' ? '静止（着地待ち）' : '—'}`;
  $('telemetry-accel').textContent = `${m.ax.toFixed(2)} / ${m.ay.toFixed(2)} / ${m.az.toFixed(2)} m/s²`;
  $('telemetry-delta').textContent = `${dx.toFixed(1)} / ${dy.toFixed(1)} px`;
  $('telemetry-raw').textContent = m.rawAx === undefined ? '旧コントローラー（再読み込みしてください）' : `${m.rawAx.toFixed(2)} / ${m.rawAy.toFixed(2)} / ${m.rawAz.toFixed(2)}`;
  $('telemetry-velocity').textContent = m.vx === undefined ? '—' : `${m.vx.toFixed(3)} / ${m.vy.toFixed(3)} m/s`;
  log.push({ at: new Date().toISOString(), ...m, mode: game.mode, progress: +game.progress.toFixed(1) });
  if (log.length > 2400) log.shift(); // Bounded local diagnostics only, ~last two minutes.
  updateGameUi();
}
function updateGameUi() {
  $('stage-count').textContent = game.mode === 'shapes' ? `${game.active} / 3` : `${Math.floor(game.progress)} %`;
  $('hand-status').textContent = game.mode === 'clean' ? '▱ クリーナー' : game.closed ? `✊ にぎっている${game.held === null ? ' · 空の手' : ` · ${game.pieces[game.held].label}`}` : '✋ ひらいている';
  $('hand-status').classList.toggle('closed', game.closed && game.mode === 'shapes');
  if (game.event.text !== lastEvent) {
    lastEvent = game.event.text;
    $('game-message').textContent = lastEvent;
    $('game-message').className = game.event.kind;
  }
  $('stage-watermark').textContent = game.done ? 'WELL DONE. TRY ANOTHER EXPERIMENT.' : 'MOVE WITH YOUR PHONE';
}
function reset(mode = game.mode) {
  game.reset(mode); game.baseline(lastInput); cleanVersion = -1; lastEvent = '';
  feedbackAt = -Infinity; clearTimeout(feedbackTimer); $('landing-feedback').className = 'landing-feedback';
  $('stage-label').textContent = mode === 'shapes' ? 'SHAPE MATCH' : 'WIPE THE COLOR';
  canvas.setAttribute('aria-label', mode === 'shapes' ? '図形を同じ形の穴へ動かすステージ' : 'スマホで単色のステージを拭くステージ');
  $('step1').innerHTML = mode === 'shapes' ? '図形の上で、着地<small>手をにぎって、つかむ</small>' : 'スマホを平らに持つ<small>上端をステージの奥へ向ける</small>';
  $('step2').innerHTML = mode === 'shapes' ? 'つかんだ図形を穴へ<small>止まっただけなら離さない</small>' : '机を拭くように動かす<small>左右、前後に短く動かす</small>';
  $('step3').innerHTML = mode === 'shapes' ? 'もう一度、着地<small>手をひらいて離す。合えば吸着</small>' : '止めて、また動かす<small>95%拭けたらクリア</small>';
  document.querySelectorAll('[data-mode]').forEach(b => { const active = b.dataset.mode === mode; b.classList.toggle('active', active); b.setAttribute('aria-pressed', active); });
  updateGameUi();
}
$('reset').addEventListener('click', () => reset());
document.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => reset(b.dataset.mode)));
$('export-log').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), config: phoneConfig, note: 'Coordinates are estimated canvas pixels, not measured distance.', frames: log }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = `sensor-poc-${Date.now()}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});

document.querySelectorAll('[data-page]').forEach(tab => tab.addEventListener('click', () => {
  document.querySelectorAll('[data-page]').forEach(item => {
    const active = item === tab;
    item.classList.toggle('active', active);
    item.setAttribute('aria-selected', String(active));
  });
  document.querySelectorAll('[role="tabpanel"]').forEach(panel => { panel.hidden = panel.id !== tab.dataset.page; });
}));

$('event-json').value = JSON.stringify(DEFAULT_GAME_EVENT, null, 2);
$('mcp-url').textContent = new URL('/mcp', location.href).href;
$('reset-event').addEventListener('click', () => {
  $('event-json').value = JSON.stringify(DEFAULT_GAME_EVENT, null, 2);
  $('event-status').textContent = 'デフォルトのテストイベントに戻しました。';
  $('event-status').className = 'event-status';
});
$('copy-mcp-url').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('mcp-url').textContent);
    $('event-status').textContent = 'MCPサーバーURLをコピーしました。';
    $('event-status').className = 'event-status';
  } catch {
    $('event-status').textContent = 'このページのURLはコピーできませんでした。テキストを選択してコピーしてください。';
    $('event-status').className = 'event-status error';
  }
});
$('send-event').addEventListener('click', async () => {
  const button = $('send-event'), status = $('event-status');
  let event;
  try { event = JSON.parse($('event-json').value); }
  catch { status.textContent = 'JSONの形式を確認してください。'; status.className = 'event-status error'; return; }
  button.disabled = true;
  status.textContent = 'イベントを送信しています…';
  status.className = 'event-status';
  try {
    const response = await fetch('/api/game-events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    if (result.duplicate) {
      status.textContent = `同じeventIdのイベントは送信済みです（${event.eventId}）。新しいIDに変えると別イベントとして届きます。`;
      status.className = 'event-status error';
    } else {
      status.textContent = `送信しました · cursor ${result.event.cursor} · ${result.event.name} · 購読中のWork/Dotsへ配信します。`;
      status.className = 'event-status success';
    }
  } catch (error) {
    status.textContent = `送信できませんでした: ${error.message}`;
    status.className = 'event-status error';
  } finally {
    button.disabled = false;
  }
});
$('copy-url').addEventListener('click', async () => {
  const value = controllerUrl;
  try { await navigator.clipboard.writeText(value); $('copy-url').textContent = 'コピーしました ✓'; setTimeout(() => { $('copy-url').innerHTML = '接続URLをコピー <span>↗</span>'; }, 1800); }
  catch { $('pair-error').textContent = `接続URL: ${value}`; }
});
function showQr() {
  const qr = qrcode(0, 'M'); qr.addData(controllerUrl); qr.make();
  $('qr').innerHTML = qr.createSvgTag({ cellSize: 4, margin: 3, scalable: true });
}
$('retry-room').addEventListener('click', () => { sessionStorage.removeItem('sensor-room'); location.reload(); });

async function connectRoom() {
  try {
    try { roomInfo = JSON.parse(sessionStorage.getItem('sensor-room')); } catch { roomInfo = null; }
    if (!roomInfo || Date.now() - roomInfo.created > 23 * 3600_000) {
      const res = await fetch('/api/rooms', { method: 'POST' });
      if (!res.ok) throw new Error('ルームを作成できませんでした。');
      roomInfo = { ...await res.json(), created: Date.now() };
      sessionStorage.setItem('sensor-room', JSON.stringify(roomInfo));
    }
    const settingsResponse = await fetch('/api/config');
    if (!settingsResponse.ok) throw new Error('接続設定を読み込めませんでした。');
    const settings = await settingsResponse.json();
    const fragment = new URLSearchParams({ room: roomInfo.room, token: roomInfo.controller });
    controllerUrl = `${settings.controllerOrigin}/controller#${fragment}`;
    showQr();
    $('room-label').textContent = roomInfo.room.slice(0, 6).toUpperCase();
    $('copy-url').disabled = false;
    socket = new RoomSocket({ room: roomInfo.room, token: roomInfo.host, role: 'display',
      onMessage(m) {
        if (m.type === 'input') onInput(m);
        if (m.type === 'settings') showSettings(m);
        if (m.type === 'presence') { controllerPresent = m.controller; if (!m.controller) { reconnectBaseline = true; sensorStatus = ''; } updateConnection(); }
      },
      onStatus(status, reason) {
        networkReady = status === 'connected'; reconnectBaseline = true;
        if (networkReady) { $('pair-error').textContent = ''; }
        if (status === 'stopped') { $('pair-error').textContent = reason; $('retry-room').hidden = false; }
        updateConnection();
      }
    });
    socket.connect();
  } catch (e) {
    $('pair-error').textContent = `${e.message} Workersの起動・接続を確認してください。`;
    $('connection-text').textContent = '接続できませんでした'; $('qr').textContent = 'ルーム作成エラー'; $('retry-room').hidden = false;
  }
}

function path(shape, x, y, size) {
  ctx.beginPath();
  if (shape === 'circle') ctx.arc(x, y, size, 0, Math.PI * 2);
  if (shape === 'square') ctx.roundRect(x - size * .9, y - size * .9, size * 1.8, size * 1.8, 5);
  if (shape === 'triangle') { ctx.moveTo(x, y - size * 1.12); ctx.lineTo(x + size * 1.05, y + size * .8); ctx.lineTo(x - size * 1.05, y + size * .8); ctx.closePath(); }
}
function render(time) {
  ctx.clearRect(0, 0, WIDTH, HEIGHT);
  ctx.fillStyle = game.mode === 'shapes' ? '#dce3d2' : '#f7f5ed'; ctx.fillRect(0, 0, WIDTH, HEIGHT);
  if (game.mode === 'shapes') {
    const nearest = game.closed ? -1 : game.nearest();
    game.pieces.forEach((p, i) => {
      if (p.placed) return;
      path(p.shape, ...p.target, 49); ctx.fillStyle = '#c5cebb'; ctx.fill();
      ctx.strokeStyle = '#9eae94'; ctx.lineWidth = 1.7; ctx.setLineDash([5, 6]); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = '#85977e'; ctx.font = '13px monospace'; ctx.textAlign = 'center'; ctx.fillText(`0${i + 1}`, p.target[0], p.target[1] + 80);
    });
    game.pieces.forEach((p, i) => {
      if ((i === nearest || i === game.held) && !game.done) {
        const pulse = 1 + Math.sin(time / 650) * .04;
        path(p.shape, p.x, p.y, 61 * pulse); ctx.strokeStyle = '#f8faf1'; ctx.lineWidth = 2; ctx.stroke();
        ctx.fillStyle = '#4f674a'; ctx.font = '13px sans-serif'; ctx.textAlign = 'center'; ctx.fillText(i === game.held ? 'つかんでいます' : '着地でつかむ', p.x, p.y - 85);
      }
      path(p.shape, p.x, p.y, 48); ctx.fillStyle = p.color;
      ctx.shadowColor = '#394a2920'; ctx.shadowBlur = 9; ctx.shadowOffsetY = 6; ctx.fill(); ctx.shadowColor = 'transparent'; ctx.shadowOffsetY = 0;
      ctx.fillStyle = '#344431'; ctx.font = '14px monospace'; ctx.textAlign = 'center'; ctx.fillText(p.placed ? '✓' : `0${i + 1}`, p.x, p.y + 5);
    });
    const hand = game.cursor;
    ctx.beginPath(); ctx.arc(hand.x, hand.y, 31, 0, Math.PI * 2);
    ctx.fillStyle = game.closed ? '#284c3ee6' : '#fffdf4e6'; ctx.fill();
    ctx.strokeStyle = game.closed ? '#f1e4b0' : '#597c5a'; ctx.lineWidth = 2; ctx.stroke();
    ctx.font = '35px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(game.closed ? '✊' : '✋', hand.x, hand.y + 1); ctx.textBaseline = 'alphabetic';
  } else {
    if (cleanVersion !== game.cleanCount) {
      cleanCtx.fillStyle = '#91aab2'; cleanCtx.fillRect(0, 0, WIDTH, HEIGHT);
      cleanCtx.fillStyle = '#f7f5ed';
      game.cleaned.forEach((v, i) => { if (v) cleanCtx.fillRect(i % game.gridWidth * 10, Math.floor(i / game.gridWidth) * 10, 10, 10); });
      cleanVersion = game.cleanCount;
    }
    ctx.drawImage(cleanCanvas, 0, 0);
    const { x, y } = game.cursor;
    ctx.beginPath(); ctx.arc(x, y, 66, 0, Math.PI * 2); ctx.strokeStyle = '#ffffff99'; ctx.lineWidth = 2; ctx.stroke();
    ctx.save(); ctx.translate(x, y); ctx.rotate(-.15); ctx.fillStyle = '#f1eee0'; ctx.shadowColor = '#354e4125'; ctx.shadowBlur = 9; ctx.shadowOffsetY = 7; ctx.beginPath(); ctx.roundRect(-37, -20, 74, 40, 7); ctx.fill(); ctx.shadowColor = 'transparent'; ctx.fillStyle = '#607c68'; ctx.fillRect(-30, 15, 60, 5); ctx.restore();
  }
  const progress = lastInput?.status === 'ready' ? (lastInput.landingProgress ?? 0) : 0;
  if (progress > 0) {
    ctx.beginPath(); ctx.arc(game.cursor.x, game.cursor.y, 44, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * progress);
    ctx.strokeStyle = '#d88b3f'; ctx.lineWidth = 6; ctx.stroke();
  }
  const elapsed = time - feedbackAt;
  if (elapsed >= 0 && elapsed < 1100) {
    const phase = elapsed / 1100;
    ctx.save(); ctx.globalAlpha = 1 - phase;
    ctx.strokeStyle = game.feedback.kind === 'success' ? '#dfac4c' : '#2f7255';
    ctx.lineWidth = 7 * (1 - phase) + 1;
    ctx.beginPath(); ctx.arc(game.cursor.x, game.cursor.y, 38 + phase * 115, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
    // A brief border flash remains visible even when the hand is at an edge.
    ctx.strokeStyle = `rgba(65,115,77,${(1 - phase) * 0.7})`; ctx.lineWidth = 9; ctx.strokeRect(4, 4, WIDTH - 8, HEIGHT - 8);
  }
  if (game.done) { ctx.fillStyle = '#304731'; ctx.textAlign = 'center'; ctx.font = '17px sans-serif'; ctx.fillText(game.mode === 'shapes' ? 'いい感じ。全部、おさまりました。' : 'すっきり。よくできました。', WIDTH / 2, 52); }
  requestAnimationFrame(render);
}
setInterval(() => {
  if (controllerPresent && lastInputAt && Date.now() - lastInputAt > 3500) {
    reconnectBaseline = true;
    $('sensor-summary').textContent = '入力が途切れています';
    $('connection-text').textContent = 'スマホの入力を待っています';
    $('telemetry-motion').textContent = '入力停止';
  }
}, 1000);
window.addEventListener('pagehide', () => socket?.close());
window.addEventListener('pageshow', e => { if (e.persisted) connectRoom(); });
connectRoom(); reset('shapes'); requestAnimationFrame(render);
