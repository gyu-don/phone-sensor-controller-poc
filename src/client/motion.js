import { clamp } from '../shared/protocol.js';
import { normalizeTuning } from '../shared/tuning.js';

const dot = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = v => { const length = Math.hypot(...v); return length > 0.01 ? v.map(n => n / length) : [0, 0, 1]; };

// Forward/back motion includes device Z when the phone is pitched. Reading
// device Y alone loses that component. Separate tabletop motion from contact.
export function projectToPlane(acceleration, gravity) {
  const normal = unit(gravity);
  const right = unit([1 - normal[0] ** 2, -normal[0] * normal[1], -normal[0] * normal[2]]);
  let forward = unit(cross(normal, right));
  if (forward[1] < 0) forward = forward.map(v => -v);
  return [dot(acceleration, right), dot(acceleration, forward), dot(acceleration, normal)];
}

// Continuous 2D velocity: one radial deadzone and one speed limit preserve
// diagonal direction. No axis latches. Quiet-time reset is adjustable because
// constant physical velocity and rest cannot be distinguished by acceleration.
export class MotionTracker {
  constructor() {
    this.config = normalizeTuning();
    this.epoch = 0;
    this.reset();
  }
  reset() {
    this.epoch++;
    this.status = 'calibrating'; this.calibration = []; this.calibrationStart = null;
    this.bias = [0, 0, 0]; this.gravity = null; this.lastTime = null;
    this.filtered = [0, 0, 0]; this.velocity = [0, 0]; this.raw = [0, 0, 0]; this.signal = [0, 0];
    this.noAccelerationSince = null; this.reason = 'calibrating';
    this.x = this.y = 0; this.stroke = this.land = 0; this.moving = false; this.landing = 'none';
    this.stillSince = this.startTime = this.impactTime = null;
    this.lastLanding = -Infinity; this.landingProgress = 0; this.hz = 0; this.source = 'linear-plane';
  }
  setConfig(config) { this.config = normalizeTuning({ ...this.config, ...config }); }
  stop() { this.moving = false; this.velocity = [0, 0]; this.signal = [0, 0]; this.noAccelerationSince = null; }
  pause() { this.status = 'paused'; this.reason = 'paused'; this.stop(); this.lastTime = this.impactTime = null; this.landingProgress = 0; }
  sample(sample, time) {
    const hasLinear = [sample.linear?.x, sample.linear?.y, sample.linear?.z].every(Number.isFinite);
    const g = [sample.gravity?.x, sample.gravity?.y, sample.gravity?.z];
    const hasGravity = g.every(Number.isFinite);
    if (!hasLinear && !hasGravity) return null;
    const gap = this.lastTime === null ? 16 : time - this.lastTime;
    this.lastTime = time;
    if (gap > 250 || gap <= 0) {
      this.stop(); this.stillSince = this.impactTime = null; this.landingProgress = 0; this.filtered = [0, 0, 0];
      this.reason = this.status === 'ready' ? 'gap' : this.status;
      return this.snapshot();
    }
    const dt = clamp(gap / 1000, 0.004, 0.05);
    this.hz = this.hz ? this.hz * 0.94 + (1 / dt) * 0.06 : 1 / dt;
    const rotation = Math.hypot(sample.rotation?.alpha ?? 0, sample.rotation?.beta ?? 0, sample.rotation?.gamma ?? 0);
    let raw;
    this.source = hasLinear ? (this.config.planeCorrection ? 'linear-plane' : 'linear-device') : 'gravity-filter';
    if (hasLinear) {
      raw = [sample.linear.x, sample.linear.y, sample.linear.z];
      // The difference from the same event isolates gravity without confusing
      // forward acceleration with a change in pitch.
      if (hasGravity) {
        const measured = g.map((v, i) => v - raw[i]);
        if (Math.hypot(...measured) > 5) this.gravity = measured;
      }
    } else {
      this.gravity ??= [...g];
      const angular = [sample.rotation?.beta ?? 0, sample.rotation?.gamma ?? 0, sample.rotation?.alpha ?? 0].map(v => v * Math.PI / 180);
      const change = cross(angular, this.gravity);
      const predicted = this.gravity.map((v, i) => v - change[i] * dt);
      this.gravity = predicted.map((v, i) => v + dt / (0.8 + dt) * (g[i] - v));
      raw = g.map((v, i) => v - this.gravity[i]);
    }
    if (raw.some(v => Math.abs(v) > 80)) return this.snapshot();
    this.raw = [...raw];
    let a = this.config.planeCorrection ? projectToPlane(raw, this.gravity ?? [0, 0, 9.81]) : [...raw];
    if (this.status === 'calibrating') {
      if (this.calibrationStart === null) this.calibrationStart = time;
      this.calibration.push(a);
      if (this.calibration.length > 5) {
        const mean = [0, 1, 2].map(i => this.calibration.reduce((sum, v) => sum + v[i], 0) / this.calibration.length);
        const variance = this.calibration.reduce((sum, v) => sum + v.reduce((total, n, i) => total + (n - mean[i]) ** 2, 0), 0) / this.calibration.length;
        if (variance > 0.12 || rotation > 14) { this.calibration = []; this.calibrationStart = time; }
        else if (time - this.calibrationStart >= 1000) { this.bias = mean; this.status = 'ready'; this.calibration = []; }
      }
      return this.snapshot();
    }
    a = a.map((v, i) => v - this.bias[i]);
    const alpha = this.config.smoothingMs ? dt / (this.config.smoothingMs / 1000 + dt) : 1;
    this.filtered = this.filtered.map((v, i) => v + alpha * (a[i] - v));
    if (this.status !== 'ready') { this.reason = this.status; return this.snapshot(); }
    const planar = Math.hypot(this.filtered[0], this.filtered[1]);
    const still = Math.hypot(...a) < this.config.stillThreshold && rotation < 14;
    if (still) this.stillSince ??= time;
    else this.stillSince = null;
    const quietFor = this.stillSince === null ? 0 : time - this.stillSince;
    // Contact is independent of planar movement: a tap at rest can grab.
    // Quiet stops only end strokes; they never toggle the hand.
    if (Math.abs(a[2]) > this.config.landingThreshold && rotation < 45 && time - this.lastLanding > this.config.contactCooldownMs) this.impactTime = time;
    if (this.impactTime !== null && time - this.impactTime > Math.max(700, this.config.landingQuietMs + 350)) this.impactTime = null;
    this.landingProgress = this.impactTime === null ? 0 : clamp(0.15 + quietFor / this.config.landingQuietMs * 0.85, 0.15, 1);
    if (this.impactTime !== null && quietFor >= this.config.landingQuietMs) {
      this.stop(); this.land++; this.landing = 'impact'; this.reason = 'landing'; this.lastLanding = time;
      this.impactTime = null; this.landingProgress = 0; this.filtered = [0, 0, 0];
      return this.snapshot();
    }
    // Shrink the 2D vector radially, never threshold or lock its axes separately.
    const active = planar > this.config.motionThreshold;
    const scale = active ? (planar - this.config.motionThreshold) / planar : 0;
    this.signal = this.filtered.slice(0, 2).map(v => v * scale);
    if (active) this.noAccelerationSince = null;
    else this.noAccelerationSince ??= time;
    const idleFor = this.noAccelerationSince === null ? 0 : time - this.noAccelerationSince;
    if (active && !this.moving) { this.stroke++; this.landing = 'none'; }
    const wasMoving = this.moving;
    if (!active && idleFor >= this.config.stopDelayMs) {
      this.velocity = [0, 0];
    } else {
      // Damping applies while acceleration is below the deadzone. Applying it
      // during braking would systematically force a premature reverse movement.
      const decay = active ? 1 : Math.exp(-this.config.damping * dt);
      this.velocity = this.velocity.map((v, i) => (v + this.signal[i] * dt) * decay);
      const speed = Math.hypot(...this.velocity);
      if (speed > 0.95) this.velocity = this.velocity.map(v => v * 0.95 / speed);
      if (!active && speed < 0.004) this.velocity = [0, 0];
    }
    this.moving = active || Math.hypot(...this.velocity) >= 0.004;
    this.reason = active ? 'moving' : this.moving ? 'coasting' : 'threshold';
    if (!this.moving && wasMoving) this.landing = 'still';
    const gain = 2600 * this.config.sensitivity;
    this.x += this.velocity[0] * dt * gain * this.config.xSensitivity * (this.config.invertX ? -1 : 1);
    this.y += this.velocity[1] * dt * gain * this.config.ySensitivity * (this.config.invertY ? 1 : -1);
    return this.snapshot();
  }
  snapshot() {
    const rounded = n => +n.toFixed(3);
    return { type: 'input', epoch: this.epoch, x: +this.x.toFixed(2), y: +this.y.toFixed(2), stroke: this.stroke, land: this.land, moving: this.moving, landing: this.landing, landingProgress: +this.landingProgress.toFixed(2), status: this.status, ax: rounded(this.filtered[0]), ay: rounded(this.filtered[1]), az: rounded(this.filtered[2]), rawAx: rounded(this.raw[0]), rawAy: rounded(this.raw[1]), rawAz: rounded(this.raw[2]), signalX: rounded(this.signal[0]), signalY: rounded(this.signal[1]), vx: rounded(this.velocity[0]), vy: rounded(this.velocity[1]), reason: this.reason, hz: +this.hz.toFixed(1), source: this.source };
  }
}
