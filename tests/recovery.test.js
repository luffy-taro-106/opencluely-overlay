'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { WindowsRecovery, recoverySession, writePrivate } = require('../overlay/recovery');

function setup(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opencluely-recovery-unit-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const calls = [], states = [];
  let recovery;
  recovery = new WindowsRecovery({ available: true, directory, executablePath: process.execPath,
    helperPath: process.execPath, pid: 1234, readyTimeout: 100, stopTimeout: 100,
    prepare: async () => { calls.push('prepare'); },
    launch: (helperPath, statePath, sessionId) => {
      calls.push('launch');
      writePrivate(recovery.readyPath, { version: 1, sessionId, pid: 9876, executablePath: helperPath });
    },
    isAlive: pid => pid === 9876 && recovery.readState()?.enabled === true, verify: async () => true,
    onChange: state => states.push(state), ...overrides });
  return { recovery, calls, states, directory };
}

test('manual launch arms a random session and watches the existing PID without restarting it', async t => {
  const { recovery, calls, states } = setup(t);
  await recovery.enable();
  assert.equal(recovery.readState().enabled, true);
  assert.equal(recovery.readState().pid, 1234);
  assert.equal(recovery.enabled, true);
  assert.equal(recovery.busy, false);
  assert.deepEqual(calls, ['prepare', 'launch']);
  assert.equal(states[0].busy, true); assert.equal(states.at(-1).busy, false);
  const token = recovery.sessionId;
  await recovery.enable();
  assert.equal(recovery.sessionId, token);
  assert.equal(calls.length, 2);
});

test('pause writes the disabled state before waiting for native exit and leaves target PID unchanged', async t => {
  const { recovery } = setup(t);
  await recovery.enable();
  const wait = recovery.waitForStop.bind(recovery);
  recovery.waitForStop = async token => {
    assert.equal(recovery.readState().enabled, false);
    assert.equal(recovery.readState().pid, 1234);
    return wait(token);
  };
  await recovery.disable();
  assert.equal(recovery.enabled, false);
});

test('a later manual launch creates a new session after pause', async t => {
  const { recovery } = setup(t);
  await recovery.enable(); const token = recovery.sessionId;
  await recovery.disable(); await recovery.enable();
  assert.notEqual(recovery.sessionId, token);
  assert.equal(recovery.enabled, true);
});

test('a valid automatic launch publishes the new PID without starting a second helper', async t => {
  const { recovery, calls } = setup(t);
  await recovery.enable();
  const next = new WindowsRecovery({ available: true, directory: recovery.directory,
    executablePath: recovery.executablePath, helperPath: recovery.helperPath, pid: 5678,
    prepare: async () => {}, isAlive: recovery.isAlive, verify: async () => true, launch: () => { calls.push('unexpected'); } });
  await next.enable({ sessionId: recovery.sessionId });
  assert.equal(next.readState().pid, 5678);
  assert.equal(next.sessionId, recovery.sessionId);
  assert.equal(calls.includes('unexpected'), false);
});

test('stale, paused, malformed or retargeted recovery tokens cannot reopen the app', async t => {
  const { recovery } = setup(t);
  await recovery.enable();
  const original = recovery.readState(), token = recovery.sessionId;
  assert.equal(recovery.acceptsSession(randomUUID()), false);
  assert.equal(recovery.acceptsSession('invalid'), false);
  writePrivate(recovery.statePath, { ...original, executablePath: path.join(recovery.directory, 'other.exe') });
  assert.equal(recovery.acceptsSession(token), false);
  writePrivate(recovery.statePath, original);
  await recovery.disable();
  await assert.rejects(recovery.enable({ sessionId: token }), /session has stopped/);
  assert.equal(recovery.enabled, false);
});

test('native helper startup failure disarms state and surfaces a recoverable error', async t => {
  const { recovery } = setup(t, { launch: () => {} });
  await assert.rejects(recovery.enable(), /could not start/);
  assert.equal(recovery.readState().enabled, false);
  assert.equal(recovery.enabled, false);
  assert.equal(recovery.busy, false);
});

test('a stopped helper is shown as paused and explicit enable starts a fresh session', async t => {
  const { recovery, calls } = setup(t);
  await recovery.enable(); const token = recovery.sessionId;
  const alive = recovery.isAlive;
  recovery.isAlive = () => false;
  assert.equal(recovery.status().enabled, false);
  assert.match(recovery.status().error, /stopped/);
  fs.rmSync(recovery.readyPath);
  recovery.isAlive = alive;
  await recovery.enable();
  assert.equal(recovery.enabled, true);
  assert.notEqual(recovery.sessionId, token);
  assert.equal(calls.filter(call => call === 'launch').length, 2);
});

test('native identity verification rejects a reused ready PID before adopting it', async t => {
  const { recovery } = setup(t);
  await recovery.enable(); const oldToken = recovery.sessionId;
  recovery.verify = async () => false;
  // The stale PID passes the cheap liveness check but cannot pass native identity.
  recovery.waitForStop = async () => {};
  await assert.rejects(recovery.enable(), /could not start/);
  assert.notEqual(recovery.sessionId, oldToken);
  assert.equal(recovery.readState().enabled, false);
});

for (const event of ['exit', 'error']) test(`native helper ${event} updates owner controls without restarting it`, async t => {
  const { recovery, calls } = setup(t);
  const helper = new EventEmitter();
  const launch = recovery.launch;
  recovery.launch = (...args) => { launch(...args); return helper; };
  await recovery.enable();
  helper.emit(event, event === 'error' ? new Error('fixture helper stopped') : 1);
  assert.equal(recovery.enabled, false);
  assert.match(recovery.status().error, /stopped/);
  assert.equal(calls.filter(call => call === 'launch').length, 1);
});

test('a delayed exit from an older helper cannot pause a later recovery session', async t => {
  const { recovery } = setup(t);
  const oldHelper = new EventEmitter(), newHelper = new EventEmitter();
  let launches = 0;
  const launch = recovery.launch;
  recovery.launch = (...args) => { launch(...args); return launches++ === 0 ? oldHelper : newHelper; };
  await recovery.enable();
  await recovery.disable();
  await recovery.enable();
  oldHelper.emit('exit', 0);
  assert.equal(recovery.enabled, true);
  assert.equal(recovery.status().error, '');
});

test('intentional Quit waits for pending startup then disarms recovery', async t => {
  let release;
  const { recovery } = setup(t, { prepare: () => new Promise(resolve => { release = resolve; }) });
  const started = recovery.enable();
  while (!release) await new Promise(resolve => setImmediate(resolve));
  const stopped = recovery.stopForQuit();
  release(); await started; await stopped;
  assert.equal(recovery.enabled, false); assert.equal(recovery.readState().enabled, false);
});

for (const terminal of [true, false]) test(`session end cancels a pending native start (terminal=${terminal})`, async t => {
  let release;
  const { recovery, calls } = setup(t, { prepare: () => new Promise(resolve => { release = resolve; }) });
  const started = recovery.enable();
  while (!release) await new Promise(resolve => setImmediate(resolve));
  recovery.disarmForSessionEnd({ terminal });
  release(); await assert.rejects(started);
  assert.equal(recovery.enabled, false);
  assert.notEqual(recovery.readState()?.enabled, true);
  assert.equal(calls.includes('launch'), false);
  if (terminal) await assert.rejects(recovery.enable(), /signing out/);
  else {
    recovery.prepare = async () => {};
    await recovery.enable();
    assert.equal(recovery.enabled, true);
  }
});

test('a canceled shutdown permits explicit re-enabling with a new token', async t => {
  const { recovery } = setup(t);
  await recovery.enable(); const token = recovery.sessionId;
  recovery.disarmForSessionEnd({ terminal: false });
  assert.equal(recovery.readState().enabled, false);
  assert.equal(recovery.acceptsSession(token), false);
  await recovery.enable();
  assert.equal(recovery.enabled, true);
  assert.notEqual(recovery.sessionId, token);
});

test('native-first session-end marking survives helper exit and allows canceled-shutdown recovery', async t => {
  const { recovery } = setup(t);
  await recovery.enable(); const token = recovery.sessionId;
  writePrivate(recovery.statePath, { ...recovery.readState(), enabled: false,
    reason: 'windows-session-end', wasEnabled: true });
  assert.equal(recovery.status().enabled, false, 'Native helper exited before the GUI saw the query.');
  assert.equal(recovery.shouldResumeAfterSessionEnd(), true);
  recovery.disarmForSessionEnd({ terminal: false });
  assert.equal(recovery.shouldResumeAfterSessionEnd(), true);
  await recovery.enable();
  assert.equal(recovery.enabled, true);
  assert.notEqual(recovery.sessionId, token);
  assert.equal(recovery.shouldResumeAfterSessionEnd(), false);
  assert.equal(recovery.readState().reason, undefined);
});

test('explicit pause supersedes a native session-end marker and prevents cancellation from restoring it', async t => {
  const { recovery } = setup(t);
  await recovery.enable();
  const original = recovery.readState();
  assert.equal(recovery.shouldResumeAfterSessionEnd(), false);
  writePrivate(recovery.statePath, { ...original, enabled: false, reason: 'windows-session-end', wasEnabled: true });
  assert.equal(recovery.shouldResumeAfterSessionEnd(), true);
  await recovery.disable();
  assert.equal(recovery.shouldResumeAfterSessionEnd(), false);
  assert.equal(recovery.readState().reason, undefined);
  writePrivate(recovery.statePath, { ...original, sessionId: randomUUID(), enabled: false,
    reason: 'windows-session-end', wasEnabled: true });
  assert.equal(recovery.shouldResumeAfterSessionEnd(), false, 'Another session cannot opt this one into restoration.');
});

test('source and portable apps do not prepare files or start recovery by default', async t => {
  const { recovery, calls } = setup(t, { available: false });
  await assert.rejects(recovery.enable(), /installed Windows app/);
  await recovery.stopForQuit();
  assert.deepEqual(calls, []);
});

test('parsing recovery arguments validates a complete UUID', () => {
  const token = randomUUID();
  assert.equal(recoverySession(['app']), null);
  assert.equal(recoverySession(['app', '--opencluely-recovery', token]), token);
  assert.equal(recoverySession(['app', '--opencluely-recovery']), '');
  assert.equal(recoverySession(['app', '--opencluely-recovery', '------------------------------------']), '');
});
