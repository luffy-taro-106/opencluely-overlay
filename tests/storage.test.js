'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../overlay/storage');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

test('secure persistence uses the encryption provider and atomic rename', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'opencluely-store-test-')); t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const crypto = {isEncryptionAvailable:()=>true,encryptString:text=>Buffer.from(text.split('').reverse().join('')),decryptString:bytes=>bytes.toString().split('').reverse().join('')};
  const store = new Store(directory,crypto); store.write('credentials.enc',{key:'secret-key'},true);
  assert.ok(!fs.readFileSync(path.join(directory,'credentials.enc'),'utf8').includes('secret-key'));
  assert.deepEqual(store.read('credentials.enc',{},true),{key:'secret-key'}); assert.ok(!fs.existsSync(path.join(directory,'credentials.enc.tmp')));
});

test('write and flush failures leave the last committed save intact and clean staging files', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opencluely-store-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new Store(directory, {});
  store.write('preferences.json', { value: 'previous' });
  for (const operation of ['fsyncSync', 'renameSync']) {
    const original = fs[operation];
    fs[operation] = () => { throw new Error('Simulated disk failure'); };
    try { assert.throws(() => store.write('preferences.json', { value: 'next' }), /disk failure/); }
    finally { fs[operation] = original; }
    assert.deepEqual(store.read('preferences.json', null), { value: 'previous' });
    assert.deepEqual(fs.readdirSync(directory), ['preferences.json']);
  }
});

test('SIGKILL between staging and commit preserves the previous save; removal clears orphaned staging files', { timeout: 10000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opencluely-store-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new Store(directory, {});
  store.write('preferences.json', { value: 'previous' });
  const child = spawn(process.execPath, ['-e', `
    const fs = require('node:fs');
    const { Store } = require(${JSON.stringify(require.resolve('../overlay/storage'))});
    const store = new Store(process.argv[1], {});
    fs.renameSync = () => {
      process.send('staged', () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0));
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    };
    store.write('preferences.json', { value: 'next' });
  `, directory], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const [message] = await once(child, 'message'); assert.equal(message, 'staged');
  const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit;
  assert.deepEqual(store.read('preferences.json', null), { value: 'previous' });
  assert.equal(fs.readdirSync(directory).length, 2);
  store.remove('preferences.json');
  assert.deepEqual(fs.readdirSync(directory), []);
});

test('oversized writes, unsafe filenames and symlink reads are rejected', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opencluely-store-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const notices = [], store = new Store(directory, {}, message => notices.push(message));
  assert.throws(() => store.write('../escape', {}), /filename/);
  assert.throws(() => store.write('preferences.json', 'x'.repeat(4 * 1024 * 1024)), /full/);
  store.write('real.json', { private: true });
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.join(directory, 'real.json')).mode & 0o777, 0o600);
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
    fs.symlinkSync(path.join(directory, 'real.json'), path.join(directory, 'linked.json'));
    assert.equal(store.read('linked.json', null), null);
    assert.equal(notices.length, 1);
  }
});
test('corrupt data is preserved and reported; encryption never falls back to plaintext', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'opencluely-store-test-')); t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const notices=[]; const store=new Store(directory,{isEncryptionAvailable:()=>false},text=>notices.push(text));
  fs.writeFileSync(path.join(directory,'preferences.json'),'broken'); assert.deepEqual(store.read('preferences.json',{}),{});
  assert.equal(notices.length,1); assert.equal(fs.readFileSync(path.join(directory,'preferences.json'),'utf8'),'broken');
  assert.throws(()=>store.write('credentials.enc',{key:'secret'},true),/Secure storage/); assert.ok(!fs.existsSync(path.join(directory,'credentials.enc')));
});

test('oversized writes preserve saved data and archives remain readable above the legacy limit', t => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'opencluely-store-test-')); t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const crypto={isEncryptionAvailable:()=>true,encryptString:text=>Buffer.from(text),decryptString:bytes=>bytes.toString()};
  const store=new Store(directory,crypto);
  store.write('conversation.enc',['existing conversation'],true);
  assert.throws(()=>store.write('conversation.enc',['x'.repeat(4*1024*1024)],true),/full/);
  assert.deepEqual(store.read('conversation.enc',[],true),['existing conversation']);
  const archive={current:[],archive:['x'.repeat(4*1024*1024)]};
  store.write('chats.enc',archive,true); assert.deepEqual(store.read('chats.enc',null,true),archive);
});
