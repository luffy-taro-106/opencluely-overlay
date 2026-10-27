'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { Store } = require('../overlay/storage');
const { InterruptedWork, FILE } = require('../overlay/interrupted-work');

function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opencluely-checkpoint-'));
  const crypto = { isEncryptionAvailable: () => true,
    encryptString: text => Buffer.from(text.split('').reverse().join('')),
    decryptString: bytes => bytes.toString().split('').reverse().join('') };
  const notices = [], store = new Store(directory, crypto, text => notices.push(text));
  let enabled = true;
  const work = new InterruptedWork({ store, enabled: () => enabled, interval: 20, report: text => notices.push(text) });
  t.after(() => { work.clear(); fs.rmSync(directory, { recursive: true, force: true }); });
  const request = { id: randomUUID(), question: { text: 'A private question', imageId: randomUUID() },
    image: { name: 'question.png', data: 'sensitive-pixels' }, text: 'Partial answer',
    provider: 'anthropic', model: 'test-model', apiKey: 'test-secret' };
  return { directory, store, work, request, notices, disable: () => { enabled = false; } };
}

test('restores partial text with attachment reminder, omits secrets/pixels and never resends a request', t => {
  const { directory, store, work, request } = setup(t);
  assert.equal(work.start(request, []), true);
  const disk = fs.readFileSync(path.join(directory, FILE));
  for (const secret of ['A private question', 'Partial answer', 'sensitive-pixels', 'test-secret']) assert.equal(disk.includes(Buffer.from(secret)), false);
  const stored = store.read(FILE, null, true);
  assert.equal(JSON.stringify(stored).includes('sensitive-pixels'), false);
  assert.equal(JSON.stringify(stored).includes('test-secret'), false);
  const replacement = new InterruptedWork({ store, enabled: () => true });
  const restored = replacement.restore([]);
  assert.equal(restored.text, 'Partial answer'); assert.equal(restored.question.imageId, null);
  assert.equal(restored.needsAttachment, true); assert.equal(restored.imageName, 'question.png');
  assert.match(restored.error, /has not resumed/);
});

test('continuous output is checkpointed; cancelling the timer prevents cleared text from returning', async t => {
  const { store, work, request } = setup(t);
  work.start(request, []);
  request.text = 'More output'; work.update(request, []);
  await delay(40);
  assert.equal(store.read(FILE, null, true).text, 'More output');
  request.text = 'Later output'; work.update(request, []);
  work.clear(); await delay(40);
  assert.equal(store.read(FILE, null, true), null);
});

test('history opt-out deletes checkpoints and stops further writes', async t => {
  const { store, work, request, disable } = setup(t);
  work.start(request, []); disable(); work.restore([]);
  work.start(request, []); work.update(request, []); await delay(40);
  assert.equal(store.read(FILE, null, true), null);
});

test('commit race and chat changes cannot duplicate an answer or restore it under a different chat', t => {
  const { work, request, store } = setup(t);
  work.start(request, []);
  assert.equal(work.restore([{ id: 'user', role: 'user', text: 'Question' }, { id: request.id, role: 'assistant', text: 'Answer' }]), null);
  assert.equal(store.read(FILE, null, true), null);
  work.start(request, []);
  assert.equal(work.restore([{ id: 'other', role: 'user', text: 'Other question' }]), null);
  assert.equal(store.read(FILE, null, true), null);
});

test('malformed checkpoints and disk failures are reported without crashing the app', t => {
  const { work, store, request, notices } = setup(t);
  store.write(FILE, { version: 1, text: [] }, true);
  assert.equal(work.restore([]), null); assert.equal(notices.length, 1);
  const original = store.write;
  store.write = () => { throw new Error('Disk full'); };
  assert.equal(work.start(request, []), false); assert.equal(notices.length, 2);
  store.write = original;
  assert.equal(work.flush(), true);
  assert.equal(work.restore([]).text, request.text);
});
test('ten attachment names restore without pixels, and older single-image checkpoints still load', t => {
  const { work, store, request } = setup(t);
  request.question = { text: 'Compare these images', imageIds: Array.from({ length: 10 }, () => randomUUID()) };
  request.images = Array.from({ length: 10 }, (_value, i) => ({ name: `${i}.png`, data: 'sensitive-pixels' }));
  work.start(request, []);
  const restored = work.restore([]);
  assert.deepEqual(restored.imageNames, request.images.map(image => image.name));
  assert.deepEqual(restored.question.imageIds, []); assert.equal(restored.needsAttachment, true);
  assert.equal(JSON.stringify(store.read(FILE, null, true)).includes('sensitive-pixels'), false);
  const saved = store.read(FILE, null, true);
  saved.version = 1; delete saved.imageNames; delete saved.question.imageIds; saved.imageName = 'old.png';
  store.write(FILE, saved, true);
  assert.deepEqual(work.restore([]).imageNames, ['old.png']);
});

test('failed encrypted checkpoint retries its latest text even after the stream goes quiet', async t => {
  const { work, store, request } = setup(t);
  const original = store.write.bind(store);
  let attempts = 0;
  store.write = (...args) => { if (++attempts === 1) throw new Error('Temporary storage failure'); return original(...args); };
  assert.equal(work.start(request, []), false);
  request.text = 'Latest text before the stream went quiet'; work.update(request, []);
  await delay(60);
  assert.equal(store.read(FILE, null, true).text, request.text);
  assert.equal(attempts, 2);
  await delay(40); assert.equal(attempts, 2, 'A clean checkpoint must remain idle');
});

test('clearing a failed checkpoint cancels retries and cannot resurrect deleted text', async t => {
  const { work, store, request } = setup(t);
  const original = store.write.bind(store);
  store.write = () => { throw new Error('Temporary storage failure'); };
  assert.equal(work.start(request, []), false);
  work.clear(); store.write = original;
  await delay(60);
  assert.equal(store.read(FILE, null, true), null);
});
