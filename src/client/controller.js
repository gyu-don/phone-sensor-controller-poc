import { MotionTracker } from './motion.js';
import { RoomSocket } from './transport.js';
import { SEND_INTERVAL_MS, TOKEN_RE } from '../shared/protocol.js';
import { mountTuning } from './controller-tuning.js';

const $ = id => document.getElementById(id);
const tracker = new MotionTracker();
const params = new URLSearchParams(location.hash.slice(1));
const room = params.get('room'), token = params.get('token');
let socket, connected = false, enabled = false, displayPresent = false, seq = 0;
let lastValid = 0, lastSent = 0, lastSignature = '', lastStatus = '', wakeLock;
let tuningOpen = false, resumeAfterTuning = false, settingsTimer, lastLocalUi = 0;
const error = text => { $('controller-error').textContent = text; };
function sendSettings() { socket?.send({ type: 'settings', values: { ...tracker.config } }); }
mountTuning({
  onChange(values) {
    tracker.setConfig(values);
    clearTimeout(settingsTimer); settingsTimer = setTimeout(sendSettings, 180);
  },
  onOpenChange(open) {
    tuningOpen = open;
    if (open) {
      resumeAfterTuning = enabled && ['ready', 'calibrating'].includes(tracker.status);
      if (enabled) { tracker.pause(); showSensor('paused'); $('recalibrate').hidden = true; }
    } else if (resumeAfterTuning && enabled && !document.hidden) {
      tracker.reset(); lastValid = Date.now(); lastStatus = ''; showSensor('calibrating'); keepAwake();
      resumeAfterTuning = false;
    }
    updateConnection(); updateLocalSensor();
  }
});

function updateLocalSensor() {
  const m = tracker.snapshot();
  const reasons = { moving: '移動入力あり', coasting: '加速度は小さい・推定速度が残っています', threshold: 'しきい値以下', landing: '着地を検出', calibrating: '静止して校正中', paused: '調整中・ゲーム入力は停止', gap: '入力間隔が空いたため速度をリセット' };
  $('local-reason').textContent = !enabled ? 'センサー未開始' : reasons[m.reason] || m.status;
  $('local-raw').textContent = `${m.rawAx.toFixed(2)} / ${m.rawAy.toFixed(2)} / ${m.rawAz.toFixed(2)}`;
  $('local-filtered').textContent = `${m.ax.toFixed(2)} / ${m.ay.toFixed(2)} m/s²`;
  $('local-velocity').textContent = `${m.vx.toFixed(3)} / ${m.vy.toFixed(3)} m/s`;
  const sources = { 'linear-plane': '重力除去＋傾き補正', 'linear-device': '重力除去（端末の軸）', 'gravity-filter': '重力を推定' };
  $('local-hz').textContent = `${m.hz.toFixed(0)} Hz · ${sources[m.source] || m.source}`;
  const c = $('sensor-vector').getContext('2d'); c.clearRect(0, 0, 140, 130);
  c.strokeStyle = '#65816c'; c.lineWidth = 1;
  c.beginPath(); c.moveTo(12, 65); c.lineTo(128, 65); c.moveTo(70, 10); c.lineTo(70, 120); c.stroke();
  c.font = '9px sans-serif'; c.fillStyle = '#b5c8ae'; c.fillText('X', 127, 60); c.fillText('Y', 74, 12);
  for (const [x, y, color, width] of [[m.rawAx, m.rawAy, '#79afcb', 1.5], [m.ax, m.ay, '#d7df9f', 3.5]]) {
    const dx = Math.max(-54, Math.min(54, x * 22)), dy = Math.max(-54, Math.min(54, -y * 22));
    c.strokeStyle = color; c.fillStyle = color; c.lineWidth = width;
    c.beginPath(); c.moveTo(70, 65); c.lineTo(70 + dx, 65 + dy); c.stroke();
    c.beginPath(); c.arc(70 + dx, 65 + dy, width + 1, 0, Math.PI * 2); c.fill();
  }
}

function showSensor(status) {
  if (status === lastStatus) return;
  lastStatus = status;
  if (status === 'ready') {
    $('controller-title').innerHTML = 'その動きが、<br>コントローラー。';
    $('controller-instruction').innerHTML = '目線は、ゲーム画面へ。<br>平らに動かして、そっと止めてみよう。';
    $('sensor-status').textContent = '入力受付中。スマホの画面を見る必要はありません。';
    $('recalibrate').hidden = false;
  } else if (status === 'calibrating') {
    $('controller-title').innerHTML = 'そのまま、<br>1秒ほど待ってね。';
    $('sensor-status').textContent = '校正中。スマホを平らに置いて、動かさずに待ってください。';
    $('recalibrate').hidden = true;
  } else if (status === 'paused') {
    $('sensor-status').textContent = tuningOpen ? '調整中はゲーム入力を停止しています。閉じると再校正します。' : '入力を一時停止しました。再開時に校正します。';
  }
}

function openConnection() {
  socket?.close();
  $('retry-connection').hidden = true;
  socket = new RoomSocket({ room, token, role: 'controller',
    onMessage(m) {
      // This controller owns tuning. Legacy display config cannot overwrite it.
      if (m.type === 'presence') {
        displayPresent = m.display;
        updateConnection();
      }
    },
    onStatus(status, reason) {
      connected = status === 'connected';
      if (connected) { lastSignature = ''; lastSent = 0; error(''); sendSettings(); }
      if (status === 'stopped') { error(reason); $('retry-connection').hidden = false; }
      updateConnection();
    }
  });
  socket.connect();
}
function updateConnection() {
  $('controller-dot').className = `dot ${connected && displayPresent ? 'connected' : ''}`;
  $('controller-connection').textContent = connected ? (displayPresent ? 'ゲーム画面に接続済み' : 'ゲーム画面の接続を待っています') : '接続を待っています';
  $('enable').disabled = !connected || !displayPresent || !window.isSecureContext || tuningOpen;
  if (connected && !enabled && lastStatus !== 'paused') $('sensor-status').textContent = tuningOpen ? '設定後に調整画面を閉じて、センサーを有効にしてください。' : 'センサーを有効にして開始します。';
}

async function keepAwake() {
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* Optional on some devices. */ }
}
async function enable() {
  error('');
  if (!window.isSecureContext) return error('センサーにはHTTPSが必要です。公開した https:// のURLで開いてください。');
  if (!window.DeviceMotionEvent) return error('このブラウザはモーションセンサーに対応していません。スマホのSafari / Chromeで開いてください。');
  try {
    // Must be called directly from this button's user activation (iOS).
    if (typeof DeviceMotionEvent.requestPermission === 'function') {
      if (await DeviceMotionEvent.requestPermission() !== 'granted') throw new Error('センサーが許可されていません。ブラウザのモーションセンサー設定を確認して、再度お試しください。');
    }
    tracker.reset(); enabled = true; lastValid = Date.now(); lastStatus = '';
    showSensor('calibrating'); $('enable').hidden = true;
    lastSignature = ''; keepAwake();
  } catch (e) { error(e.message || 'センサーを開始できませんでした。'); }
}
$('enable').addEventListener('click', enable);
$('recalibrate').addEventListener('click', () => {
  tracker.reset(); lastValid = Date.now(); lastStatus = ''; showSensor('calibrating'); error(''); keepAwake();
});
$('retry-connection').addEventListener('click', openConnection);
window.addEventListener('devicemotion', e => {
  if (!enabled || document.hidden) return;
  const input = tracker.sample({ linear: e.acceleration, gravity: e.accelerationIncludingGravity, rotation: e.rotationRate }, performance.now());
  if (!input) return;
  lastValid = Date.now();
  showSensor(input.status);
  if (performance.now() - lastLocalUi > 150) { updateLocalSensor(); lastLocalUi = performance.now(); }
});

// One channel, at most 20 input frames/s. No raw 60–100 Hz stream or HTTP polling.
setInterval(() => {
  if (!enabled || !connected) return;
  if (!document.hidden && Date.now() - lastValid > 3500 && tracker.status !== 'paused') {
    tracker.pause(); tracker.status = 'error'; enabled = false;
    error('センサーデータが届きません。スマホのSafari / Chromeで開き、サイトのセンサー権限を確認してください。');
    $('enable').hidden = false; $('enable').textContent = 'センサーを再試行'; $('recalibrate').hidden = true;
    socket.send({ ...tracker.snapshot(), seq: ++seq });
    return;
  }
  const input = tracker.snapshot();
  const signature = JSON.stringify([input.epoch, input.x, input.y, input.stroke, input.land, input.landingProgress, input.moving, input.status]);
  if (signature === lastSignature && Date.now() - lastSent < 1000) return;
  if (socket.send({ ...input, seq: ++seq })) { lastSignature = signature; lastSent = Date.now(); }
}, SEND_INTERVAL_MS);

document.addEventListener('visibilitychange', () => {
  if (document.hidden && enabled) {
    tracker.pause(); enabled = false; showSensor('paused');
    resumeAfterTuning = false;
    socket?.send({ ...tracker.snapshot(), seq: ++seq });
    wakeLock?.release();
    $('enable').hidden = false; $('enable').textContent = '再開して校正する'; $('recalibrate').hidden = true;
  }
});
window.addEventListener('pagehide', () => socket?.close());
window.addEventListener('pageshow', e => { if (e.persisted) openConnection(); });
if (!TOKEN_RE.test(room ?? '') || !TOKEN_RE.test(token ?? '')) {
  $('controller-connection').textContent = '接続URLを確認してください';
  $('sensor-status').textContent = 'ゲーム画面に表示されたQRコードから開いてください。';
  error('ルーム情報がありません。');
} else if (!window.isSecureContext) {
  error('センサーにはHTTPSが必要です。Workersへ公開したURLで接続してください。');
  $('sensor-status').textContent = 'HTTPS接続が必要です';
} else openConnection();
updateLocalSensor();
