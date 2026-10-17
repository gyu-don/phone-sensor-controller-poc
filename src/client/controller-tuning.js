import { TUNING_FIELDS, normalizeTuning, formatTuning } from '../shared/tuning.js';
const STORAGE_KEY = 'sensor-controller-tuning-v3';
export function loadTuning(storage) {
  try { return normalizeTuning(JSON.parse(storage.getItem(STORAGE_KEY))); } catch { return normalizeTuning(); }
}
export function saveTuning(storage, values) {
  try { storage.setItem(STORAGE_KEY, JSON.stringify(normalizeTuning(values))); return true; } catch { return false; }
}

export function mountTuning({ onChange, onOpenChange }) {
  let storage;
  try { storage = window.localStorage; } catch { /* Persistence is optional. */ }
  let values = loadTuning(storage);
  const controls = new Map();
  const $ = id => document.getElementById(id);
  function changed() {
    values = normalizeTuning(values);
    $('tuning-saved').textContent = saveTuning(storage, values) ? 'このスマホに保存しました' : '今回の操作に反映中（保存は利用できません）';
    onChange(values);
  }
  for (const field of TUNING_FIELDS) {
    const row = document.createElement('div'); row.className = 'tuning-field';
    const label = document.createElement('label'); label.htmlFor = `tune-${field.key}`;
    const title = document.createElement('span'); title.textContent = field.label;
    const output = document.createElement('output'); output.id = `tune-value-${field.key}`; output.setAttribute('for', `tune-${field.key}`);
    label.append(title, output);
    const input = document.createElement('input'); input.type = 'range'; input.id = `tune-${field.key}`;
    for (const key of ['min', 'max', 'step']) input[key] = field[key];
    input.setAttribute('aria-describedby', `tune-help-${field.key}`);
    const help = document.createElement('p'); help.id = `tune-help-${field.key}`; help.textContent = field.help;
    input.addEventListener('input', () => { values[field.key] = +input.value; output.value = formatTuning(field, +input.value); changed(); });
    row.append(label, input, help); $(`tuning-${field.group}`).append(row);
    controls.set(field.key, { input, output, field });
  }
  for (const key of ['invertX', 'invertY', 'planeCorrection']) {
    $(`tune-${key}`).addEventListener('change', () => { values[key] = $(`tune-${key}`).checked; changed(); });
  }
  function sync() {
    for (const [key, { input, output, field }] of controls) { input.value = values[key]; output.value = formatTuning(field, values[key]); }
    for (const key of ['invertX', 'invertY', 'planeCorrection']) $(`tune-${key}`).checked = values[key];
  }
  $('tuning-reset').addEventListener('click', () => { values = normalizeTuning(); sync(); changed(); });
  $('tuning').addEventListener('toggle', () => { document.body.classList.toggle('tuning-open', $('tuning').open); onOpenChange($('tuning').open); });
  $('tuning-apply').addEventListener('click', () => { $('tuning').open = false; });
  sync(); onChange(values);
  return { getValues: () => ({ ...values }) };
}
