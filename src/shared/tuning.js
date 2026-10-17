// One schema for controller controls, persistence, and validated relay messages.
export const TUNING_FIELDS = [
  { key: 'sensitivity', group: 'movement', label: '移動の感度', min: 0.4, max: 3, step: 0.1, initial: 1, unit: '×', help: '両方向とも動きが小さい → 上げる。少し動かしただけで飛ぶ → 下げる。' },
  { key: 'xSensitivity', group: 'movement', label: '左右だけの倍率', min: 0.5, max: 3, step: 0.1, initial: 1, unit: '×', help: '上下はちょうどよく、左右だけ小さい → 上げる。左右だけ大きい → 下げる。' },
  { key: 'ySensitivity', group: 'movement', label: '上下だけの倍率', min: 0.5, max: 3, step: 0.1, initial: 1, unit: '×', help: '左右はちょうどよく、奥・手前の移動だけ小さい → 上げる。上下だけ大きい → 下げる。' },
  { key: 'motionThreshold', group: 'movement', label: '小さな動きの無視', min: 0.02, max: 0.8, step: 0.02, initial: 0.12, unit: ' m/s²', help: '動かしても反応しない → 下げる。置いたまま勝手に動き始める → 上げる。まず感度より先にここを調整。' },
  { key: 'landingThreshold', group: 'landing', label: '着地に必要な衝撃', min: 0.8, max: 6, step: 0.2, initial: 2.4, unit: ' m/s²', help: 'そっと置いても着地を拾わない → 下げる。持ち上げる途中などで誤検出する → 上げる。強く置く必要はありません。' },
  { key: 'landingQuietMs', group: 'landing', label: '着地後の静止時間', min: 60, max: 400, step: 10, initial: 150, unit: ' ms', help: 'リングは出るが確定が遅い → 短くする。まだ動いているのに確定する → 長くする。' },
  { key: 'contactCooldownMs', group: 'landing', label: '着地の連続検出を防ぐ時間', min: 300, max: 1500, step: 50, initial: 650, unit: ' ms', help: '1回の着地で手が2回切り替わる → 長くする。素早い次の着地を拾わない → 短くする。' },
  { key: 'stopDelayMs', group: 'advanced', label: '無加速になってから止めるまで', min: 200, max: 2000, step: 50, initial: 800, unit: ' ms', help: '一定の速さで動かす途中で止まる → 長くする。手を止めてもカーソルが流れ続ける → 短くする。等速移動と静止はセンサーだけでは区別できません。' },
  { key: 'damping', group: 'advanced', label: '動きの余韻を抑える強さ', min: 0.5, max: 8, step: 0.1, initial: 2.2, unit: '', help: '手を止めた後に流れすぎる → 上げる。動かし続けているのにすぐ失速する → 下げる。加速度が小さい間の推定速度を徐々に弱めます。' },
  { key: 'smoothingMs', group: 'advanced', label: '入力をなめらかにする時間', min: 0, max: 160, step: 5, initial: 35, unit: ' ms', help: '細かくガタガタ動く → 長くする。動き始めや切り返しが遅い → 短くする。' },
  { key: 'stillThreshold', group: 'advanced', label: '着地時の静止のゆるさ', min: 0.1, max: 1.2, step: 0.05, initial: 0.45, unit: ' m/s²', help: '着地のリングが出ても確定しない → 上げる。動かしている途中で着地確定する → 下げる。' }
];
export const TUNING_BOOLEANS = ['invertX', 'invertY', 'planeCorrection'];
export const DEFAULT_TUNING = Object.freeze({ ...Object.fromEntries(TUNING_FIELDS.map(f => [f.key, f.initial])), invertX: false, invertY: false, planeCorrection: true });

export function normalizeTuning(values = {}) {
  const result = { ...DEFAULT_TUNING };
  for (const f of TUNING_FIELDS) if (Number.isFinite(values?.[f.key])) result[f.key] = Math.max(f.min, Math.min(f.max, values[f.key]));
  for (const key of TUNING_BOOLEANS) if (typeof values?.[key] === 'boolean') result[key] = values[key];
  return result;
}
export function validTuning(values) {
  return !!values && TUNING_FIELDS.every(f => Number.isFinite(values[f.key]) && values[f.key] >= f.min && values[f.key] <= f.max)
    && TUNING_BOOLEANS.every(k => typeof values[k] === 'boolean');
}
export function formatTuning(field, value) {
  const precision = field.step < 0.1 ? 2 : field.step < 1 ? 1 : 0;
  return `${value.toFixed(precision)}${field.unit}`;
}
