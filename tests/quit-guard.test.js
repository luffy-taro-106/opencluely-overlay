'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { QuitGuard } = require('../overlay/quit-guard');

function setup(overrides = {}) {
  const observed = { quit: 0, blocked: 0, confirm: 0 };
  const guard = new QuitGuard({ enabled: () => true, confirm: async () => { observed.confirm++; return false; }, quit: () => observed.quit++, blocked: () => observed.blocked++, ...overrides });
  return { guard, observed };
}
test('unapproved quits are blocked before any quit or confirmation action', () => {
  const { guard, observed } = setup();
  assert.equal(guard.preventQuit(), true);
  assert.deepEqual(observed, { quit: 0, blocked: 1, confirm: 0 });
});
test('cancelling a deliberate quit preserves protection for later requests', async () => {
  const { guard, observed } = setup();
  assert.equal(await guard.requestQuit(), false);
  assert.equal(guard.preventQuit(), true);
  assert.equal(observed.quit, 0);
});
test('confirming a deliberate quit allows its subsequent before-quit event', async () => {
  const { guard, observed } = setup({ confirm: async () => true });
  assert.equal(await guard.requestQuit(), true);
  assert.equal(observed.quit, 1);
  assert.equal(guard.preventQuit(), false);
});
test('simultaneous quit actions share one confirmation and cancellation resets it', async () => {
  let resolve, confirmations = 0;
  const { guard, observed } = setup({ confirm: () => { confirmations++; return new Promise(done => { resolve = done; }); } });
  const first = guard.requestQuit(), second = guard.requestQuit();
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(confirmations, 1);
  assert.equal(guard.preventQuit(), true, 'An external quit during the dialog must still be blocked');
  resolve(false); await first;
  const third = guard.requestQuit(); await Promise.resolve();
  assert.equal(confirmations, 2);
  resolve(true); await third;
  assert.equal(observed.quit, 1);
});
test('disabling protection preserves normal quit behavior without a dialog', async () => {
  const { guard, observed } = setup({ enabled: () => false });
  assert.equal(guard.preventQuit(), false);
  assert.equal(await guard.requestQuit(), true);
  assert.equal(observed.confirm, 0);
  assert.equal(observed.quit, 1);
});
test('OS session end is allowed without a confirmation', async () => {
  const { guard, observed } = setup();
  guard.allowSessionEnd();
  assert.equal(guard.preventQuit(), false);
  assert.equal(await guard.requestQuit(), true);
  assert.equal(observed.confirm, 0);
});

test('a canceled Windows shutdown restores cooperative quit protection', () => {
  const { guard } = setup();
  guard.allowSessionEnd(); assert.equal(guard.preventQuit(), false);
  guard.cancelSessionEnd(); assert.equal(guard.preventQuit(), true);
});
test('dialog or quit errors leave external quit protection enabled', async () => {
  const { guard } = setup({ confirm: async () => { throw new Error('Dialog unavailable'); } });
  await assert.rejects(guard.requestQuit(), /Dialog unavailable/);
  assert.equal(guard.preventQuit(), true);
  guard.confirm = async () => true;
  guard.quit = () => { throw new Error('Quit failed'); };
  await assert.rejects(guard.requestQuit(), /Quit failed/);
  assert.equal(guard.preventQuit(), true);
});
test('deliberate Quit waits for recovery cleanup and handles asynchronous failure', async () => {
  let finished = false;
  const { guard } = setup({ confirm: async () => true, quit: async () => { await Promise.resolve(); finished = true; } });
  assert.equal(await guard.requestQuit(), true); assert.equal(finished, true);
  guard.approved = false;
  guard.quit = async () => { throw new Error('Recovery cleanup failed'); };
  await assert.rejects(guard.requestQuit(), /Recovery cleanup failed/);
  assert.equal(guard.preventQuit(), true);
});
