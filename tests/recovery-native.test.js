'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { writePrivate } = require('../overlay/recovery');

const root = path.join(__dirname, '..');
const helper = path.join(root, 'overlay', 'native', 'bin', 'recovery-helper-win32-x64.exe');
const windows = process.platform === 'win32';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function json(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function events(file) { try { return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch { return []; } }
async function until(predicate, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = predicate(); if (value) return value; await delay(25); }
  throw new Error('Timed out waiting for disposable Windows recovery fixture.');
}
function kill(pid) { try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
function exit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
}
function compileHelper() {
  const built = spawnSync(process.execPath, ['scripts/build-recovery.js'], { cwd: root, encoding: 'utf8', windowsHide: true });
  assert.equal(built.status, 0, built.stdout + built.stderr);
}
function compileFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opencluely-recovery-native-'));
  const executablePath = path.join(directory, 'Recovery Fixture.exe');
  const compiler = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  const result = spawnSync(compiler, ['/nologo', '/target:winexe', '/platform:x64', '/reference:System.Windows.Forms.dll',
    '/reference:System.Web.Extensions.dll', `/out:${executablePath}`, path.join(__dirname, 'recovery-fixture.cs')], {
    encoding: 'utf8', windowsHide: true, timeout: 30000
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const sessionId = randomUUID(), statePath = path.join(directory, 'state.json'), eventPath = path.join(directory, 'events.jsonl');
  fs.writeFileSync(path.join(directory, 'fixture-config.json'), JSON.stringify({ sessionId, statePath, eventPath }));
  const prep = spawnSync(helper, ['--prepare', directory], { encoding: 'utf8', windowsHide: true });
  assert.equal(prep.status, 0);
  let supervisor;
  const pids = new Set();
  t.after(async () => {
    const state = json(statePath);
    if (state) { pids.add(state.pid); writePrivate(statePath, { ...state, enabled: false }); }
    if (supervisor && supervisor.exitCode === null && supervisor.signalCode === null) {
      await Promise.race([exit(supervisor), delay(2000)]);
      if (supervisor.exitCode === null && supervisor.signalCode === null) { supervisor.kill('SIGKILL'); await exit(supervisor); }
    }
    for (const record of events(eventPath)) pids.add(record.pid);
    for (const pid of pids) kill(pid);
    await delay(150);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, executablePath, statePath, eventPath, sessionId, pids,
    startHelper: () => (supervisor = spawn(helper, ['--state', statePath, '--session', sessionId], { stdio: 'ignore', windowsHide: true })) };
}

test('Windows helper compiles, reports event-driven supervision and validates process identity', { skip: !windows }, () => {
  compileHelper();
  const probe = spawnSync(helper, ['--probe'], { encoding: 'utf8', windowsHide: true });
  assert.equal(probe.status, 0);
  assert.deepEqual(JSON.parse(probe.stdout), { version: 1, platform: 'win32', processEvents: true, sessionEvents: true });
  const identity = spawnSync(helper, ['--process-identity', String(process.pid)], { encoding: 'utf8', windowsHide: true });
  assert.equal(identity.status, 0);
  const actual = JSON.parse(identity.stdout);
  assert.equal(actual.pid, process.pid);
  assert.equal(actual.executablePath.toLowerCase(), process.execPath.toLowerCase());
  assert.match(actual.startTimeTicks, /^\d+$/);
});

test('native supervisor reopens after repeated forced exits and pause leaves its GUI alive', { skip: !windows, timeout: 45000 }, async t => {
  const fixture = compileFixture(t);
  const firstChild = spawn(fixture.executablePath, [], { stdio: 'ignore', windowsHide: true });
  const first = await until(() => json(fixture.statePath)); fixture.pids.add(first.pid);
  assert.equal(first.pid, firstChild.pid);
  const supervisor = fixture.startHelper();
  const readyPath = path.join(fixture.directory, 'helper.json');
  const ready = await until(() => json(readyPath));
  const verify = (...args) => spawnSync(helper, ['--verify-helper', readyPath, '--session', fixture.sessionId, ...args], {
    encoding: 'utf8', windowsHide: true, timeout: 5000
  });
  assert.equal(verify().status, 0);
  writePrivate(readyPath, { ...ready, startTimeTicks: '1' });
  assert.equal(verify().status, 1, 'A recycled PID must not pass native identity verification.');
  writePrivate(readyPath, ready);
  await delay(250); assert.equal(events(fixture.eventPath).length, 1);
  kill(first.pid);
  const second = await until(() => { const state = json(fixture.statePath); return state?.pid !== first.pid && state; });
  fixture.pids.add(second.pid);
  assert.equal(second.sessionId, fixture.sessionId);
  kill(second.pid);
  const third = await until(() => { const state = json(fixture.statePath); return state?.pid !== first.pid && state?.pid !== second.pid && state; }, 25000);
  fixture.pids.add(third.pid);
  const records = events(fixture.eventPath);
  assert.equal(records.length, 3);
  assert.deepEqual(records.map(record => record.recovered), [false, true, true]);
  writePrivate(fixture.statePath, { ...third, enabled: false });
  assert.equal(await Promise.race([exit(supervisor), delay(3000).then(() => 'timeout')]), 0);
  assert.doesNotThrow(() => process.kill(third.pid, 0));
  kill(third.pid);
  await delay(2300); assert.equal(events(fixture.eventPath).length, 3);
});

test('Windows session-end query disarms native recovery without vetoing shutdown', { skip: !windows, timeout: 15000 }, async t => {
  const fixture = compileFixture(t);
  spawn(fixture.executablePath, [], { stdio: 'ignore', windowsHide: true });
  const first = await until(() => json(fixture.statePath)); fixture.pids.add(first.pid);
  const supervisor = fixture.startHelper();
  const ready = await until(() => json(path.join(fixture.directory, 'helper.json')));
  const query = spawnSync(fixture.executablePath, ['--query-session-end', String(ready.pid)], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  assert.equal(query.status, 0);
  assert.equal(await Promise.race([exit(supervisor), delay(3000).then(() => 'timeout')]), 0);
  assert.equal(json(fixture.statePath).enabled, false);
  assert.equal(json(fixture.statePath).reason, 'windows-session-end');
  assert.equal(json(fixture.statePath).wasEnabled, true);
  kill(first.pid);
  await delay(2300); assert.equal(events(fixture.eventPath).length, 1);
});

test('stale tokens, target changes and deleted state stop native recovery', { skip: !windows, timeout: 15000 }, async t => {
  const fixture = compileFixture(t);
  spawn(fixture.executablePath, [], { stdio: 'ignore', windowsHide: true });
  const first = await until(() => json(fixture.statePath)); fixture.pids.add(first.pid);
  const stale = spawnSync(helper, ['--state', fixture.statePath, '--session', randomUUID()], { encoding: 'utf8', windowsHide: true, timeout: 3000 });
  assert.equal(stale.status, 1);
  let supervisor = fixture.startHelper();
  await until(() => json(path.join(fixture.directory, 'helper.json')));
  writePrivate(fixture.statePath, { ...first, executablePath: process.execPath });
  assert.equal(await exit(supervisor), 0);
  writePrivate(fixture.statePath, first);
  supervisor = fixture.startHelper();
  await until(() => json(path.join(fixture.directory, 'helper.json')));
  fs.rmSync(fixture.statePath);
  assert.equal(await exit(supervisor), 0);
  assert.doesNotThrow(() => process.kill(first.pid, 0));
});
