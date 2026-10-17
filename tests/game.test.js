import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../src/client/game.js';
import { validInput, validConfig } from '../src/shared/protocol.js';
const frame = (values = {}) => ({ type: 'input', seq: 1, epoch: 1, x: 0, y: 0, stroke: 0, land: 0, moving: false, landing: 'none', status: 'ready', ax: 0, ay: 0, az: 0, hz: 60, ...values });
const contact = (land, values = {}) => frame({ land, landing: 'impact', ...values });
test('first contact grabs, ordinary stopping keeps grip, second contact releases and snaps', () => {
  const game = new Game(); game.apply(frame());
  game.apply(contact(1));
  assert.equal(game.closed, true); assert.equal(game.held, 0); assert.equal(game.active, 0);
  game.apply(frame({ x: 390, y: 60, land: 1, stroke: 1, moving: true }));
  game.apply(frame({ x: 390, y: 60, land: 1, stroke: 1, landing: 'still' }));
  assert.equal(game.closed, true); assert.equal(game.active, 0);
  game.apply(contact(2, { x: 390, y: 60, stroke: 1 }));
  assert.equal(game.closed, false); assert.equal(game.held, null); assert.equal(game.active, 1);
  assert.equal(game.feedback.kind, 'success'); assert.equal(game.contactId, 2);
});
test('open-hand movement only moves the hand', () => {
  const game = new Game(); game.apply(frame());
  game.apply(frame({ x: 140, y: 40, stroke: 1, moving: true }));
  assert.equal(game.pieces[0].x, 190); assert.equal(game.cursor.x, 330); assert.equal(game.cursor.y, 200);
});
test('wrong direction or no movement drops without snapping', () => {
  for (const x of [-100, 0]) {
    const game = new Game(); game.apply(frame()); game.apply(contact(1));
    game.apply(frame({ x, land: 1, moving: true })); game.apply(contact(2, { x }));
    assert.equal(game.active, 0); assert.equal(game.closed, false); assert.equal(game.held, null);
    assert.equal(game.pieces[0].x, 190 + x);
  }
});
test('the hand can select a different shape in any order', () => {
  const game = new Game(); game.apply(frame());
  game.apply(frame({ x: 130, y: 180, moving: true }));
  game.apply(contact(1, { x: 130, y: 180 }));
  assert.equal(game.held, 1);
  game.apply(frame({ x: 550, y: 50, land: 1, moving: true }));
  game.apply(contact(2, { x: 550, y: 50 }));
  assert.equal(game.pieces[1].placed, true); assert.equal(game.pieces[0].placed, false);
});
test('empty grabs toggle without picking distant objects; repeated packets cannot toggle twice', () => {
  const game = new Game(); game.apply(frame());
  game.apply(frame({ x: 500, y: 0, moving: true }));
  game.apply(contact(1, { x: 500 }));
  assert.equal(game.closed, true); assert.equal(game.held, null);
  game.apply(contact(1, { x: 500 })); assert.equal(game.closed, true); assert.equal(game.contactId, 1);
  game.apply(contact(2, { x: 500 })); assert.equal(game.closed, false);
});
test('reconnect / recalibration release grip and never teleport or replay a contact', () => {
  const game = new Game(); game.apply(frame()); game.apply(contact(1));
  game.apply(contact(2, { x: 2000, epoch: 2 }));
  assert.equal(game.pieces[0].x, 190); assert.equal(game.closed, false); assert.equal(game.active, 0);
  game.baseline(); game.apply(contact(4, { x: 5000, epoch: 2 }));
  assert.equal(game.pieces[0].x, 190); assert.equal(game.closed, false);
});
test('cleaner erases moving segments; stationary contacts only produce feedback', () => {
  const game = new Game('clean'); game.apply(frame()); game.apply(contact(1));
  assert.equal(game.cleanCount, 0); assert.equal(game.contactId, 1); assert.equal(game.feedback.text, '着地を検出');
  game.apply(frame({ x: 150, stroke: 1, land: 1, moving: true }));
  const count = game.cleanCount; assert.ok(count > 180);
  game.apply(frame({ x: 150, stroke: 1, land: 1 })); game.apply(frame({ x: 150, stroke: 1, land: 1 }));
  assert.equal(game.cleanCount, count);
  game.reset(); assert.equal(game.progress, 0); assert.equal(game.cleanCount, 0);
});
test('cumulative displacement recovers a dropped intermediate packet', () => {
  const game = new Game('clean'); game.apply(frame());
  game.apply(frame({ x: 100, stroke: 1, moving: true }));
  game.apply(frame({ x: 460, stroke: 1, moving: true }));
  assert.equal(game.cursor.x, 1060);
});
test('protocol validates optional Y sensitivity and contact confirmation fields', () => {
  assert.equal(validInput(frame({ x: NaN })), false);
  assert.equal(validInput(frame({ land: -1 })), false);
  assert.equal(validInput(frame({ x: 1e20 })), false);
  assert.equal(validInput(frame({ landingProgress: 2 })), false);
  assert.equal(validInput(frame({ landingProgress: .5 })), true);
  assert.equal(validConfig({ type: 'config', sensitivity: 1, ySensitivity: 1.5, invertX: false, invertY: false }), true);
  assert.equal(validConfig({ type: 'config', sensitivity: 1, ySensitivity: -1, invertX: false, invertY: false }), false);
});
