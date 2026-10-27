'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { CheckpointWriter } = require('../overlay/checkpoint-writer');

function setup(t, options) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const writer = new CheckpointWriter({ interval: 10, ...options });
  t.after(() => writer.cancel());
  return writer;
}

test('continuous changes are throttled without starving the latest checkpoint', t => {
  let value = 0; const saved = [];
  const writer = setup(t, { write: () => saved.push(value) });
  writer.mark();
  for (let i = 1; i <= 10; i++) { value = i; writer.mark(); t.mock.timers.tick(1); }
  assert.deepEqual(saved, [10]);
  value = 11; writer.mark(); t.mock.timers.tick(10);
  assert.deepEqual(saved, [10, 11]);
  t.mock.timers.tick(100); assert.equal(saved.length, 2, 'Idle state must not keep writing');
});

test('a transient save failure retries without new input and resets its backoff', t => {
  let attempts = 0; const notices = [];
  const writer = setup(t, { write: () => { if (++attempts === 1) throw new Error('private error body'); }, report: () => notices.push('Could not save') });
  writer.mark(); assert.equal(writer.flush(), false);
  assert.equal(attempts, 1); t.mock.timers.tick(9); assert.equal(attempts, 1);
  t.mock.timers.tick(1); assert.equal(attempts, 2);
  assert.equal(writer.dirty, false); assert.equal(writer.retryDelay, 10);
  assert.deepEqual(notices, ['Could not save']);
  t.mock.timers.tick(100); assert.equal(attempts, 2);
});

test('persistent failures back off to a cap instead of spinning', t => {
  let attempts = 0;
  const writer = setup(t, { maximumRetryDelay: 40, write: () => { attempts++; throw new Error('Disk full'); } });
  writer.mark(); writer.flush(); assert.equal(attempts, 1);
  for (const wait of [10, 20, 40, 40]) {
    const previous = attempts;
    t.mock.timers.tick(wait - 1); assert.equal(attempts, previous);
    t.mock.timers.tick(1); assert.equal(attempts, previous + 1);
  }
  assert.equal(writer.retryDelay, 40);
});

test('updates during a failed save keep the newest value without shortening the retry delay', t => {
  let value = 'old', failing = true; const saved = [];
  const writer = setup(t, { write: () => { if (failing) throw new Error('Disk busy'); saved.push(value); } });
  writer.mark(); writer.flush(); t.mock.timers.tick(10); // Next retry waits 20 ms.
  failing = false; value = 'new'; writer.mark(); t.mock.timers.tick(10);
  assert.deepEqual(saved, []);
  t.mock.timers.tick(10); assert.deepEqual(saved, ['new']);
});

test('cancel removes a dirty or failed checkpoint and prevents late writes', t => {
  let attempts = 0;
  const writer = setup(t, { write: () => { attempts++; throw new Error('Disk unavailable'); } });
  writer.mark(); writer.flush(); writer.cancel(); t.mock.timers.tick(100);
  assert.equal(attempts, 1); assert.equal(writer.dirty, false);
  assert.equal(writer.flush(), true); assert.equal(attempts, 1);
});

test('explicit flush commits before its interval and clean flushes do not write again', t => {
  let writes = 0;
  const writer = setup(t, { write: () => writes++ });
  writer.mark(); assert.equal(writer.flush(), true); assert.equal(writes, 1);
  assert.equal(writer.flush(), true); t.mock.timers.tick(100);
  assert.equal(writes, 1);
});

test('invalid checkpoint intervals cannot create a tight timer loop', () => {
  for (const interval of [0, -1, NaN, Infinity]) assert.throws(() => new CheckpointWriter({ write() {}, interval }), /configuration/);
  assert.throws(() => new CheckpointWriter({ write() {}, interval: 10, maximumRetryDelay: 5 }), /configuration/);
});

test('a failing error reporter cannot prevent a later successful save', t => {
  let attempts = 0;
  const writer = setup(t, { write: () => { if (++attempts === 1) throw new Error('Disk busy'); }, report: () => { throw new Error('Reporter failed'); } });
  writer.mark(); assert.equal(writer.flush(), false);
  t.mock.timers.tick(10); assert.equal(attempts, 2); assert.equal(writer.dirty, false);
});

test('checkpoint health distinguishes a failed, recovered, and skipped write', t => {
  let fail = true;
  const writer = setup(t, { write: () => { if (fail) throw new Error('Disk busy'); } });
  writer.mark(); writer.flush();
  assert.deepEqual(writer.status(), { dirty: true, retryScheduled: true, consecutiveFailures: 1, lastSavedAt: null });
  fail = false; t.mock.timers.tick(10);
  assert.equal(writer.status().consecutiveFailures, 0); assert.ok(writer.status().lastSavedAt);
  const skipped = new CheckpointWriter({ write: () => false }); t.after(() => skipped.cancel()); skipped.mark(); skipped.flush();
  assert.equal(skipped.status().lastSavedAt, null);
});
