'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { Diagnostics, ownProcessMetrics, checkpointStatus, inspectOwnFile, inspectPE } = require('../overlay/diagnostics');

test('diagnostics are off by default and never change an operation result', async () => {
  const recorder = new Diagnostics(); const result = { secret: 'private-result' };
  assert.equal(await recorder.run('save-settings', () => result), result);
  recorder.lifecycle('lock'); assert.deepEqual(recorder.snapshot().events, []);
  assert.equal(recorder.status().recording, false);
});

test('opt-in calls record ordered timing and result types without values, credentials or error messages', async () => {
  const recorder = new Diagnostics(); recorder.start();
  const result = { apiKey: 'never-record-this-key', text: 'never-record-this-answer' };
  assert.equal(await recorder.run('ask', async () => result), result);
  const failure = new Error('private prompt, URL or provider response');
  await assert.rejects(recorder.run('ask', () => { throw failure; }), error => error === failure);
  const snapshot = recorder.snapshot(), text = JSON.stringify(snapshot);
  for (const privateText of [...Object.values(result), failure.message]) assert.equal(text.includes(privateText), false);
  assert.deepEqual(snapshot.events.map(event => event.sequence), [1, 2, 3, 4]);
  assert.equal(snapshot.events[1].call, 1); assert.equal(snapshot.events[1].resultType, 'object');
  assert.equal(snapshot.events[3].outcome, 'error'); assert.equal(snapshot.failures, 1);
  assert.ok(snapshot.events[1].durationMs >= 0); assert.ok(snapshot.measuredInstrumentationMs >= 0);
});

test('overlapping calls retain their own start IDs and completion order', async () => {
  const recorder = new Diagnostics(); recorder.start();
  let finishFirst; const first = recorder.run('first', () => new Promise(resolve => { finishFirst = resolve; }));
  await recorder.run('second', async () => 2); finishFirst(1); assert.equal(await first, 1);
  assert.deepEqual(recorder.snapshot().events.map(event => [event.type, event.name, event.call]),
    [['call-start', 'first', undefined], ['call-start', 'second', undefined], ['call-end', 'second', 2], ['call-end', 'first', 1]]);
  assert.equal(recorder.status().active, 0);
});

test('stopping or restarting recording cannot import a late result into a new session', async () => {
  const recorder = new Diagnostics(); recorder.start();
  let finish; const pending = recorder.run('ask', () => new Promise(resolve => { finish = resolve; }));
  recorder.stop(); recorder.start(); finish('private late text'); await pending;
  assert.equal(recorder.status().active, 0); assert.deepEqual(recorder.snapshot().events, []);
});

test('bounded history and allowlisted lifecycle labels reject arbitrary event payloads', () => {
  const recorder = new Diagnostics({ maximumEvents: 3 }); recorder.start();
  recorder.lifecycle('private prompt');
  for (const event of ['lock', 'unlock', 'suspend', 'resume']) recorder.lifecycle(event);
  assert.deepEqual(recorder.snapshot().events.map(event => event.name), ['unlock', 'suspend', 'resume']);
  const copy = recorder.snapshot(); copy.events[0].name = 'mutated';
  assert.equal(recorder.snapshot().events[0].name, 'unlock');
  assert.throws(() => new Diagnostics({ maximumEvents: 100000 }), /limit/);
});

test('own-process metric projection excludes paths, service names, command lines and unknown fields', () => {
  const result = ownProcessMetrics([{ pid: 123, type: 'Browser', name: 'secret-user-name', serviceName: 'secret-service',
    cpu: { percentCPUUsage: 3 }, memory: { workingSetSize: 1024, peakWorkingSetSize: 2048 }, commandLine: 'private-token' }]);
  assert.deepEqual(result, [{ pid: 123, type: 'Browser', cpuPercent: 3, workingSetKiB: 1024, peakWorkingSetKiB: 2048 }]);
  assert.equal(ownProcessMetrics([{ type: 'private title' }])[0].type, 'Other');
});

test('checkpoint projection reports dirty/retry state without retaining error bodies or pending data', () => {
  assert.deepEqual(checkpointStatus({ dirty: true, retryScheduled: true, consecutiveFailures: 2, lastSavedAt: null, text: 'private' }),
    { dirty: true, retryScheduled: true, consecutiveFailures: 2, lastSavedAt: null });
});

test('known-file hashing produces a stable identity and missing files expose only a status code', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'opencluely-diagnostics-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'owned-file.js'); await fs.writeFile(filename, 'owned fixture');
  const result = await inspectOwnFile('owned-file.js', filename);
  assert.equal(result.sha256, createHash('sha256').update('owned fixture').digest('hex'));
  assert.equal(JSON.stringify(result).includes(directory), false);
  assert.deepEqual(await inspectOwnFile('missing', path.join(directory, 'private-account-name')), { name: 'missing', status: 'ENOENT' });
  await fs.writeFile(filename, Buffer.alloc(2 * 1024 * 1024 + 1));
  assert.equal((await inspectOwnFile('owned-file.js', filename)).status, 'not-inspected');
});

test('bounded PE inspection identifies architecture and rejects malformed offsets and headers', () => {
  const fixture = Buffer.alloc(512); fixture.writeUInt16LE(0x5a4d, 0); fixture.writeUInt32LE(128, 0x3c);
  fixture.writeUInt32LE(0x00004550, 128); fixture.writeUInt16LE(0x8664, 132); fixture.writeUInt16LE(3, 134);
  fixture.writeUInt16LE(240, 148); fixture.writeUInt16LE(0x20b, 152);
  assert.deepEqual(inspectPE(fixture), { valid: true, machine: 'x64', sections: 3, format: 'PE32+' });
  fixture.writeUInt32LE(0xffffffff, 0x3c); assert.deepEqual(inspectPE(fixture), { valid: false });
  assert.deepEqual(inspectPE(Buffer.from('not a PE')), { valid: false });
});
