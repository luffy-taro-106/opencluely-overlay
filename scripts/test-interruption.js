'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const assert = require('node:assert/strict');

const root = path.join(__dirname, '..');
const profile = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'opencluely-interruption-test-'));
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const children = [];
function launch(phase) {
  const child = spawn(require('electron'), [root, '--interruption-smoke-test', phase, profile], {
    env, stdio: ['ignore', 'inherit', 'inherit', 'ipc'], windowsHide: true
  });
  children.push(child); return child;
}

void (async () => {
  const writer = launch('write');
  const exit = once(writer, 'exit');
  let timer;
  try {
    await Promise.race([
      once(writer, 'message').then(([message]) => assert.equal(message.ready, true)),
      exit.then(() => { throw new Error('Checkpoint fixture exited before it was ready.'); }),
      new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Checkpoint fixture timed out.')), 25000); })
    ]);
  } finally { clearTimeout(timer); }
  // Let a fresh Electron profile finish persisting its native encryption state.
  await new Promise(resolve => setTimeout(resolve, 10000));
  writer.kill('SIGKILL');
  const [code, signal] = await exit;
  assert.ok(signal === 'SIGKILL' || (process.platform === 'win32' && code !== 0));
  const reader = launch('read');
  const [readCode] = await once(reader, 'exit');
  assert.equal(readCode, 0, 'Restoration fixture must pass');
})().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit;
    }
  }
  fs.rmSync(profile, { recursive: true, force: true });
});
