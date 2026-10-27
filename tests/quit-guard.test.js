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
test('preparation keeps external quits blocked and passes the complete-exit choice', async () => {
  let finish, observed;
  const { guard } = setup({ confirm: async options => { observed = options; return true; },
    prepare: () => new Promise(resolve => { finish = resolve; }) });
  const quitting = guard.requestQuit({ stopCompletely: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(observed, { stopCompletely: true });
  assert.equal(guard.preventQuit(), true);
  finish(); assert.equal(await quitting, true); assert.equal(guard.preventQuit(), false);
});
test('failed preparation leaves the app running and complete exit always confirms', async () => {
  const { guard, observed } = setup({ enabled: () => false,
    prepare: async () => { throw Error('Supervisor verification failed'); } });
  await assert.rejects(guard.requestQuit(), /Supervisor verification/);
  assert.equal(guard.approved, false); assert.equal(observed.quit, 0);
  assert.equal(await guard.requestQuit({ stopCompletely: true }), false);
  assert.equal(observed.confirm, 1); assert.equal(observed.quit, 0);
});

test('ordinary Quit verifies reopening before approving the actual exit', async () => {
  const calls = [];
  const { guard } = setup({
    confirm: async options => { calls.push(['confirm', options]); return true; },
    prepare: async options => { calls.push(['prepare', options]); assert.equal(guard.preventQuit(), true); },
    quit: options => { calls.push(['quit', options]); assert.equal(guard.preventQuit(), false); }
  });
  assert.equal(await guard.requestQuit(), true);
  assert.deepEqual(calls, [
    ['confirm', { stopCompletely: false }],
    ['prepare', { stopCompletely: false }],
    ['quit', { stopCompletely: false }]
  ]);
});

test('failed reopening verification preserves protection and permits a later complete exit', async () => {
  const attempts = [];
  const { guard, observed } = setup({ confirm: async () => true,
    prepare: async options => {
      attempts.push(options);
      if (!options.stopCompletely) throw new Error('Supervisor verification failed');
    } });
  await assert.rejects(guard.requestQuit(), /Supervisor verification failed/);
  assert.equal(guard.pending, null);
  assert.equal(guard.preventQuit(), true);
  assert.equal(observed.quit, 0);
  assert.equal(await guard.requestQuit({ stopCompletely: true }), true);
  assert.deepEqual(attempts, [{ stopCompletely: false }, { stopCompletely: true }]);
  assert.equal(observed.quit, 1);
});

for (const stopCompletely of [false, true]) test(`a different pending Quit choice is rejected without changing the confirmed action (stopCompletely=${stopCompletely})`, async () => {
  let confirm, finish, optionsSeen;
  const prepared = [], exited = [];
  const { guard } = setup({ confirm: options => {
    optionsSeen = options;
    return new Promise(resolve => { confirm = resolve; });
  }, prepare: options => {
    prepared.push(options);
    return new Promise(resolve => { finish = resolve; });
  }, quit: options => { exited.push(options); } });
  const first = guard.requestQuit({ stopCompletely });
  assert.equal(guard.requestQuit({ stopCompletely }), first, 'The identical action shares its pending confirmation.');
  await Promise.resolve();
  const busy = { code: 'quit_action_busy', message: /Another Quit action is already in progress/ };
  await assert.rejects(guard.requestQuit({ stopCompletely: !stopCompletely }), busy);
  assert.deepEqual(optionsSeen, { stopCompletely });
  confirm(true);
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(guard.requestQuit({ stopCompletely: !stopCompletely }), busy);
  assert.equal(guard.requestQuit({ stopCompletely }), first, 'The identical action also shares its pending preparation.');
  assert.equal(guard.preventQuit(), true);
  finish();
  assert.equal(await first, true);
  assert.deepEqual(prepared, [{ stopCompletely }]);
  assert.deepEqual(exited, [{ stopCompletely }]);
  assert.equal(guard.pending, null);
  assert.equal(guard.pendingMode, null);
});

test('canceling a pending Quit permits the owner to choose Quit completely afterward', async () => {
  let confirm;
  const confirmations = [], prepared = [], exited = [];
  const { guard } = setup({ confirm: options => {
    confirmations.push(options);
    return new Promise(resolve => { confirm = resolve; });
  }, prepare: async options => { prepared.push(options); }, quit: options => { exited.push(options); } });
  const ordinary = guard.requestQuit();
  await Promise.resolve();
  await assert.rejects(guard.requestQuit({ stopCompletely: true }), { code: 'quit_action_busy' });
  confirm(false);
  assert.equal(await ordinary, false);
  assert.equal(guard.preventQuit(), true);
  assert.deepEqual(prepared, []);
  const complete = guard.requestQuit({ stopCompletely: true });
  await Promise.resolve();
  confirm(true);
  assert.equal(await complete, true);
  assert.deepEqual(confirmations, [{ stopCompletely: false }, { stopCompletely: true }]);
  assert.deepEqual(prepared, [{ stopCompletely: true }]);
  assert.deepEqual(exited, [{ stopCompletely: true }]);
});
