import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MotionTracker } from '../src/client/motion.js';
import { Game } from '../src/client/game.js';

test('sampled sensor trace: contact grabs, horizontal stroke and quiet hold, next contact places', () => {
  const tracker = new MotionTracker(), game = new Game();
  let time = 0, frames = 0;
  function feed(x, y, z, count) {
    for (let i = 0; i < count; i++) {
      const input = tracker.sample({ linear: { x, y, z }, gravity: { x, y, z: z + 9.81 } }, time += 16);
      if (++frames % 3 === 0) game.apply(input); // ~20 Hz from a 60 Hz sensor.
    }
  }
  feed(0, 0, 0, 80); feed(0, 0, 4, 2); feed(0, 0, 0, 45);
  assert.equal(game.held, 0); assert.equal(game.closed, true);
  feed(4, -.6, 0, 18); feed(-4, .6, 0, 18); feed(0, 0, 0, 20);
  assert.equal(game.closed, true); assert.equal(game.active, 0);
  assert.ok(game.pieces[0].x > 700); assert.ok(game.pieces[0].y > 240);
  feed(0, 0, 4, 2); feed(0, 0, 0, 30);
  assert.equal(game.closed, false); assert.equal(game.pieces[0].placed, true);
  assert.equal(game.contactId, 2); assert.equal(game.feedback.kind, 'success');
});
