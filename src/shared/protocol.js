import { validTuning } from './tuning.js';

export const SEND_INTERVAL_MS = 50;
export const ROOM_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_MESSAGE_BYTES = 1024;
export const TOKEN_RE = /^[a-f0-9]{32}$/;
export const CLIENT_RE = /^[a-zA-Z0-9_-]{8,64}$/;
export const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

// Coordinates are cumulative, so skipped / dropped frames never lose displacement.
export function validInput(m) {
  return m?.type === 'input' && ['seq', 'epoch', 'stroke', 'land'].every(k => Number.isSafeInteger(m[k]) && m[k] >= 0)
    && ['x', 'y', 'ax', 'ay', 'az', 'hz'].every(k => Number.isFinite(m[k]) && Math.abs(m[k]) <= 1e7)
    && typeof m.moving === 'boolean' && ['ready', 'calibrating', 'paused', 'error'].includes(m.status)
    && (m.landingProgress === undefined || (Number.isFinite(m.landingProgress) && m.landingProgress >= 0 && m.landingProgress <= 1))
    && ['rawAx', 'rawAy', 'rawAz', 'vx', 'vy', 'signalX', 'signalY'].every(k => m[k] === undefined || (Number.isFinite(m[k]) && Math.abs(m[k]) <= 1e7))
    && ['impact', 'still', 'none'].includes(m.landing);
}

export const validSettings = m => m?.type === 'settings' && validTuning(m.values);

export function validConfig(m) {
  return m?.type === 'config' && Number.isFinite(m.sensitivity) && m.sensitivity >= 0.4 && m.sensitivity <= 3
    && (m.ySensitivity === undefined || (Number.isFinite(m.ySensitivity) && m.ySensitivity >= 0.5 && m.ySensitivity <= 3))
    && typeof m.invertX === 'boolean' && typeof m.invertY === 'boolean';
}
