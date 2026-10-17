import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TUNING, TUNING_FIELDS, normalizeTuning, validTuning } from '../src/shared/tuning.js';
import { validSettings, MAX_MESSAGE_BYTES } from '../src/shared/protocol.js';
import { loadTuning, saveTuning } from '../src/client/controller-tuning.js';
import { MotionTracker } from '../src/client/motion.js';
function rig(config = {}) {
  const tracker = new MotionTracker(); tracker.setConfig(config); let t = 0;
  const feed = (x = 0, y = 0, z = 0, count = 1) => { for(let i=0;i<count;i++) tracker.sample({linear:{x,y,z},gravity:{x,y,z:9.81+z}}, t+=16); };
  feed(0,0,0,80); return { tracker, feed };
}
test('defaults are isotropic, complete, valid and small enough for relay limits', () => {
  assert.equal(DEFAULT_TUNING.xSensitivity, 1); assert.equal(DEFAULT_TUNING.ySensitivity, 1);
  assert.equal(validTuning(DEFAULT_TUNING), true);
  assert.equal(validSettings({type:'settings',values:DEFAULT_TUNING}), true);
  assert.ok(Buffer.byteLength(JSON.stringify({type:'settings',values:DEFAULT_TUNING})) < MAX_MESSAGE_BYTES);
  for(const f of TUNING_FIELDS) assert.ok(f.help.includes('→'), `${f.key} needs adjustment guidance`);
});
test('persisted settings survive reload and reject malformed values', () => {
  let item = null; const storage = { getItem:()=>item, setItem:(key,value)=>{item=value;} };
  const config = normalizeTuning({sensitivity:1.5,xSensitivity:2,motionThreshold:.06});
  assert.equal(saveTuning(storage,config),true); assert.deepEqual(loadTuning(storage),config);
  item = 'invalid json'; assert.deepEqual(loadTuning(storage),DEFAULT_TUNING);
  assert.equal(saveTuning({setItem(){throw new Error('Blocked');}},config),false);
  assert.deepEqual(loadTuning(undefined),DEFAULT_TUNING);
  assert.deepEqual(normalizeTuning({sensitivity:NaN,invertX:'yes'}),DEFAULT_TUNING);
  assert.equal(validSettings({type:'settings',values:{...DEFAULT_TUNING,damping:NaN}}),false);
  assert.equal(validSettings({type:'settings',values:{...DEFAULT_TUNING,stopDelayMs:99999}}),false);
});
test('motion threshold changes whether gentle input is accepted', () => {
  const low=rig({motionThreshold:.04}), high=rig({motionThreshold:.8});
  for(const r of [low,high]) r.feed(.2,.2,0,30);
  assert.ok(low.tracker.x>5 && low.tracker.y < -5);
  assert.equal(high.tracker.x,0); assert.equal(high.tracker.y,0);
});
test('stop delay and damping control coasting instead of independent axes', () => {
  const short=rig({stopDelayMs:200}), long=rig({stopDelayMs:1500});
  for(const r of [short,long]) { r.feed(2,1,0,16); r.feed(0,0,0,30); }
  assert.equal(short.tracker.moving,false); assert.equal(long.tracker.moving,true);
  const weak=rig({damping:.5}), strong=rig({damping:8});
  for(const r of [weak,strong]) { r.feed(2,1,0,16); r.feed(0,0,0,25); }
  assert.ok(Math.hypot(...weak.tracker.velocity)>Math.hypot(...strong.tracker.velocity)*2);
});
test('smoothing changes response delay while preserving diagonal direction', () => {
  const fast=rig({smoothingMs:0}), slow=rig({smoothingMs:160});
  for(const r of [fast,slow]) r.feed(1,1,0,5);
  assert.ok(fast.tracker.x>slow.tracker.x);
  for(const r of [fast,slow]) assert.ok(Math.abs(r.tracker.x+r.tracker.y)<1e-6);
});
test('landing threshold adjusts gentle contact; tuning pause cannot move or toggle', () => {
  const gentle=rig({landingThreshold:1}), firm=rig({landingThreshold:4});
  for(const r of [gentle,firm]) { r.feed(0,0,2,2); r.feed(0,0,0,20); }
  assert.equal(gentle.tracker.land,1); assert.equal(firm.tracker.land,0);
  const paused=rig(); paused.tracker.pause();
  paused.feed(2,2,4,10); paused.feed(0,0,0,30);
  assert.equal(paused.tracker.x,0); assert.equal(paused.tracker.y,0); assert.equal(paused.tracker.land,0);
  assert.equal(paused.tracker.snapshot().status,'paused');
  paused.feed(.4,.6,0); assert.equal(paused.tracker.snapshot().rawAx,.4);
});
