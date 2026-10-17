import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MotionTracker, projectToPlane } from '../src/client/motion.js';
import { validInput } from '../src/shared/protocol.js';

const input = (x = 0, y = 0, z = 0) => ({ linear: { x, y, z }, gravity: { x, y, z: 9.81 + z } });
function rig(map = data => data) {
  const tracker = new MotionTracker(); let time = 0;
  const sample = (data = input(), count = 1) => { let result; for (let i = 0; i < count; i++) result = tracker.sample(map(data), time += 16); return result; };
  sample(input(), 70);
  assert.equal(tracker.status, 'ready');
  return { tracker, sample, gap: () => time += 1000 };
}
test('stationary noise never moves or lands', () => {
  const { tracker, sample } = rig();
  for (let i = 0; i < 400; i++) sample(input(Math.sin(i) * .08, Math.cos(i) * .09, .04));
  assert.equal(tracker.x, 0); assert.equal(tracker.land, 0); assert.equal(tracker.stroke, 0);
});
test('horizontal acceleration and braking move right, stop without a contact, and do not drift', () => {
  const { tracker, sample } = rig();
  sample(input(2), 16); sample(input(-1.8), 13); sample(input(), 90);
  assert.ok(tracker.x > 40, `displacement ${tracker.x}`);
  assert.equal(tracker.moving, false); assert.equal(tracker.land, 0); assert.equal(tracker.landing, 'still');
  const x = tracker.x; sample(input(), 100);
  assert.equal(tracker.x, x); assert.equal(tracker.land, 0);
  assert.ok(validInput({ ...tracker.snapshot(), seq: 1 }));
});
test('a stationary vertical tap confirms contact without horizontal movement', () => {
  const { tracker, sample } = rig();
  sample(input(0, 0, 4), 2);
  assert.ok(tracker.landingProgress > 0); assert.equal(tracker.land, 0);
  sample(input(), 14);
  assert.equal(tracker.land, 1); assert.equal(tracker.landing, 'impact');
  assert.equal(tracker.x, 0); assert.equal(tracker.y, 0);
  sample(input(), 50); assert.equal(tracker.land, 1);
});
test('contact bounce is debounced; a later tap can release', () => {
  const { tracker, sample } = rig();
  sample(input(0, 0, 4), 2); sample(input(), 14);
  sample(input(0, 0, -5), 2); sample(input(), 14);
  assert.equal(tracker.land, 1);
  sample(input(), 45); sample(input(0, 0, 4), 2); sample(input(), 14);
  assert.equal(tracker.land, 2);
});
test('an impact while movement continues expires without a false landing', () => {
  const { tracker, sample } = rig();
  sample(input(1, 0, 4), 2); sample(input(1), 50); sample(input(), 20);
  assert.equal(tracker.land, 0);
});
test('projection restores forward magnitude at pitch and removes normal impacts', () => {
  for (const sign of [-1, 1]) {
    const theta = Math.PI / 4, normal = [0, sign * Math.sin(theta), sign * Math.cos(theta)];
    const forward = [0, 2 * Math.cos(theta), -2 * Math.sin(theta)];
    const p = projectToPlane(forward, normal.map(v => v * 9.81));
    assert.ok(Math.abs(p[1] - 2) < 1e-8); assert.ok(Math.abs(p[2]) < 1e-8);
    const vertical = projectToPlane(normal.map(v => v * 5), normal);
    assert.ok(Math.hypot(vertical[0], vertical[1]) < 1e-8);
  }
});
test('forward/back gesture magnitude stays consistent at 0 and 45 degree pitch', () => {
  const pitch = data => {
    const c = Math.SQRT1_2, s = Math.SQRT1_2;
    const rotate = v => ({ x: v.x, y: v.y * c + v.z * s, z: -v.y * s + v.z * c });
    return { linear: rotate(data.linear), gravity: rotate(data.gravity) };
  };
  const flat = rig(), tilted = rig(pitch);
  for (const r of [flat, tilted]) { r.sample(input(0, 2), 16); r.sample(input(0, -2), 16); r.sample(input(), 30); }
  assert.ok(flat.tracker.y < -50);
  assert.ok(Math.abs(flat.tracker.y - tilted.tracker.y) < .01);
  assert.equal(tilted.tracker.land, 0);
});
test('continuous reversal works without requiring a quiet pause', () => {
  const { tracker, sample } = rig();
  sample(input(0, 2), 14);
  const before = tracker.y;
  sample(input(0, -4), 35);
  assert.ok(tracker.velocity[1] < -.1);
  assert.ok(tracker.y > before, 'deliberate reverse acceleration must not latch the axis off');
});
test('the previously frozen X axis follows new acceleration alongside Y', () => {
  const { tracker, sample } = rig();
  sample(input(2, 2), 16); sample(input(-4, -1), 12);
  const before = { x: tracker.x, y: tracker.y };
  sample(input(2, 2), 25);
  assert.ok(tracker.x - before.x > 5, 'X must not remain frozen after deceleration');
  assert.ok(Math.abs(tracker.y - before.y) > 5);
});
test('gentle diagonal input moves both axes proportionally', () => {
  const { tracker, sample } = rig(); sample(input(.5, .3), 40);
  assert.ok(tracker.x > 5 && tracker.y < -5);
  assert.ok(Math.abs(tracker.y / tracker.x + .3 / .5) < .0001);
});
test('192ms of zero acceleration retains velocity instead of killing coasting', () => {
  const { tracker, sample } = rig(); sample(input(2), 16);
  const before = tracker.x; sample(input(), 12);
  assert.ok(tracker.x > before + 50); assert.equal(tracker.moving, true);
  assert.ok(tracker.velocity[0] > .1);
});
test('gravity-only device calibrates and detects a short stroke', () => {
  const tracker = new MotionTracker(); let t = 0;
  const s = (x, n) => { for (let i = 0; i < n; i++) tracker.sample({ gravity: { x, y: 0, z: 9.81 } }, t += 16); };
  s(0, 80); assert.equal(tracker.status, 'ready');
  s(2, 14); s(0, 350);
  assert.equal(tracker.source, 'gravity-filter'); assert.ok(tracker.stroke >= 1); assert.equal(tracker.moving, false);
});
test('calibration rejects movement and missing values', () => {
  const tracker = new MotionTracker();
  assert.equal(tracker.sample({ linear: { x: null, y: null, z: null } }, 0), null);
  for (let i = 0; i < 100; i++) tracker.sample(input(i % 2 ? 2 : -2), i * 16);
  assert.equal(tracker.status, 'calibrating');
});
test('time gap resets velocity and pending contacts; calibration epoch changes', () => {
  const { tracker, sample, gap } = rig(); sample(input(3), 12);
  sample(input(0, 0, 4)); const x = tracker.x; gap(); sample(input());
  assert.equal(tracker.x, x); assert.equal(tracker.moving, false); assert.equal(tracker.landingProgress, 0);
  sample(input(), 30); assert.equal(tracker.land, 0);
  const epoch = tracker.epoch; tracker.reset(); assert.equal(tracker.epoch, epoch + 1); assert.equal(tracker.x, 0);
});
test('Y gain is independent of X; inversion and overall sensitivity compose', () => {
  const a = rig(), b = rig(); b.tracker.setConfig({ sensitivity: 2, ySensitivity: 2, invertX: true, invertY: true });
  for (const r of [a, b]) { r.sample(input(2, 1), 14); r.sample(input(), 40); }
  assert.ok(Math.abs(b.tracker.x + 2 * a.tracker.x) < .001);
  assert.ok(Math.abs(b.tracker.y + 4 * a.tracker.y) < .001);
});
