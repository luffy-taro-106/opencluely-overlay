'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { DEFAULTS, validateSettings, validateQuestion, inspectImage, clampBounds, boundedContext, diskHistory, validateHistory } = require('../overlay/core');
const { PROVIDERS, MODEL_CATALOG } = require('../overlay/models');

test('preferences reject unsafe input and do not mutate defaults', () => {
  assert.throws(() => validateSettings({ provider: 'other' }));
  assert.throws(() => validateSettings({ opacity: NaN }));
  assert.throws(() => validateSettings({ models: { gemini: '../key?x=secret' } }));
  assert.throws(() => validateSettings({ launchAtLogin: 'true' }));
  assert.throws(() => validateSettings({ hideFromCapture: 'true' }));
  assert.throws(() => validateSettings({ protectFromQuit: 'true' }));
  assert.equal(validateSettings({}).protectFromQuit, true, 'Existing profiles gain close protection');
  assert.equal(validateSettings({ protectFromQuit: false }).protectFromQuit, false);
  assert.equal(validateSettings({}).hideFromCapture, true, 'Existing profiles gain capture protection by default');
  assert.equal(validateSettings({ hideFromCapture: false }).hideFromCapture, false);
  const result = validateSettings({ provider: 'gemini', models: { gemini: 'gemini-custom' }, opacity: .7 });
  assert.equal(result.models.gemini, 'gemini-custom'); assert.equal(DEFAULTS.models.gemini, 'gemini-3.8-flash');
  assert.equal(validateSettings({provider:'openai'}).models.openai,'gpt-6.1-sol');
  const previous = {provider:'gemini',models:{anthropic:'my-existing-model',gemini:'gemini-custom'},launchAtLogin:true,hideFromCapture:false};
  const migrated = validateSettings({}, previous);
  assert.equal(migrated.models.openai,'gpt-6.1-sol');
  assert.equal(migrated.models.gemini,previous.models.gemini);
  assert.equal(migrated.provider,'gemini');
  assert.equal(migrated.launchAtLogin,true);
  assert.equal(migrated.hideFromCapture,false);
  assert.equal(migrated.protectFromQuit,true);
});
test('model menus include each provider default and still permit custom vision model IDs', () => {
  for (const provider of PROVIDERS) {
    if (provider === 'chatgpt') {
      assert.deepEqual(MODEL_CATALOG[provider], [], 'Subscription model access is discovered only after connecting an account');
      assert.equal(DEFAULTS.models.chatgpt, 'chatgpt-auto');
    } else assert.ok(MODEL_CATALOG[provider].some(model => model.id === DEFAULTS.models[provider]));
    assert.equal(new Set(MODEL_CATALOG[provider].map(model => model.id)).size, MODEL_CATALOG[provider].length);
    for (const model of MODEL_CATALOG[provider]) assert.equal(validateSettings({models:{[provider]:model.id}}).models[provider],model.id);
    assert.equal(validateSettings({models:{[provider]:'custom-vision-2026'}}).models[provider],'custom-vision-2026');
  }
});

test('ChatGPT settings and completed history stay separate from API-key preferences', () => {
  const migrated = validateSettings({}, { provider: 'openai', models: { openai: 'gpt-6.1-sol' } });
  assert.equal(migrated.provider, 'openai');
  assert.equal(migrated.models.chatgpt, 'chatgpt-auto');
  const connected = validateSettings({ provider: 'chatgpt', models: { chatgpt: 'account-model' }, reasoningEfforts: { chatgpt: { 'account-model': 'high' } } }, migrated);
  assert.equal(connected.models.openai, 'gpt-6.1-sol');
  assert.equal(connected.reasoningEfforts.chatgpt['account-model'], 'high');
  const history = [{ id: 'question', role: 'user', text: 'Hello' }, { id: 'answer', role: 'assistant', text: 'Hi', provider: 'chatgpt', model: 'account-model' }];
  assert.equal(validateHistory(diskHistory(history))[1].provider, 'chatgpt');
});
test('code box opacity defaults to full opacity and migrates existing profiles independently', () => {
  assert.equal(DEFAULTS.codeOpacity, 1);
  assert.equal(validateSettings({}).codeOpacity, 1);
  const { codeOpacity: _oldCodeOpacity, ...legacyProfile } = DEFAULTS;
  const migrated = validateSettings({}, { ...legacyProfile, opacity: 0.25 });
  assert.equal(migrated.codeOpacity, 1);
  assert.equal(migrated.opacity, 0.25);

  const current = { ...DEFAULTS, opacity: 0.4, codeOpacity: 0.6 };
  assert.equal(validateSettings({ codeOpacity: 0.1 }, current).opacity, 0.4);
  assert.equal(validateSettings({ opacity: 0.1 }, current).codeOpacity, 0.6);
  assert.deepEqual(validateSettings({ opacity: 1, codeOpacity: 0.1 }, current), { ...current, opacity: 1, codeOpacity: 0.1 });
  assert.equal(current.opacity, 0.4);
  assert.equal(current.codeOpacity, 0.6);
  assert.equal(DEFAULTS.opacity, 0.98);
  assert.equal(DEFAULTS.codeOpacity, 1);
});
test('code box opacity accepts 10% through 100% and rejects invalid values', () => {
  for (const codeOpacity of [0.1, 0.55, 1]) assert.equal(validateSettings({ codeOpacity }).codeOpacity, codeOpacity);
  for (const codeOpacity of [NaN, Infinity, -Infinity, 0, 0.099, 1.001, undefined, null, '0.5', true, [], {}]) {
    assert.throws(() => validateSettings({ codeOpacity }), /Code box opacity must be between 10% and 100%\./);
  }
  for (const opacity of [0.1, 1]) assert.equal(validateSettings({ opacity }).opacity, opacity);
});
test('image-only questions receive a clear default prompt; empty and oversized inputs fail', () => {
  assert.throws(() => validateQuestion({ text: '  ' }));
  assert.throws(() => validateQuestion({ text: 'x'.repeat(12001) }));
  assert.throws(() => validateQuestion({ text: 'hi', imageId: 'file:///secret' }));
  assert.match(validateQuestion({ imageId: '12345678-1234-1234-1234-123456789012' }).text, /Read the question/);
});
test('geometry recovers detached monitors and clamps to small/negative-position displays', () => {
  assert.deepEqual(clampBounds({ x: 9000, y: 9000, width: 500, height: 800 }, { x: 0, y: 0, width: 1920, height: 1040 }), { x: 1420, y: 240, width: 500, height: 800 });
  assert.deepEqual(clampBounds({ x: 0, y: -999, width: 800, height: 1000 }, { x: -800, y: -100, width: 700, height: 500 }), { x: -800, y: -100, width: 700, height: 500 });
  assert.equal(clampBounds(null, { x: 0, y: 0, width: 1920, height: 1080 }, true).height, 122);
});
function pngHeader(width, height) { const bytes = Buffer.alloc(24); Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes); bytes.write('IHDR',12); bytes.writeUInt32BE(width,16); bytes.writeUInt32BE(height,20); return bytes; }
test('image validation checks actual format and dimensions before decoding', () => {
  assert.deepEqual(inspectImage(pngHeader(800, 600)), { width: 800, height: 600, mime: 'image/png' });
  assert.throws(() => inspectImage(pngHeader(16000,16000)));
  assert.throws(() => inspectImage(pngHeader(0,600)));
  assert.throws(() => inspectImage(Buffer.from('<svg width="200">test</svg>')));
  assert.throws(() => inspectImage(Buffer.alloc(11 * 1024 * 1024)));
  const jpeg = Buffer.alloc(32); jpeg.set([255,216,255,192,0,17,8,2,88,3,32],0);
  assert.deepEqual(inspectImage(jpeg), { width: 800, height: 600, mime: 'image/jpeg' });
});
test('follow-ups include bounded complete pairs and recent images', () => {
  const history = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: 'x'.repeat(2000), imageId: i % 2 ? null : `image${i}` }));
  const context = boundedContext(history, { text: 'follow up', imageId: 'current' }, id => ({ id }));
  assert.equal(context.length, 17); assert.equal(context.filter(message => message.image).length, 9);
  assert.equal(context.at(-1).image.id, 'current'); assert.equal(context[0].role, 'user');
});
test('ten ordered images are accepted; eleven, duplicates and malformed IDs are rejected', () => {
  const ids = Array.from({ length: 10 }, () => randomUUID());
  assert.deepEqual(validateQuestion({ imageIds: ids }).imageIds, ids);
  assert.throws(() => validateQuestion({ text: 'question', imageIds: [...ids, randomUUID()] }), /up to 10/);
  assert.throws(() => validateQuestion({ text: 'question', imageIds: [ids[0], ids[0]] }), /Invalid attachment/);
  assert.throws(() => validateQuestion({ text: 'question', imageIds: 'bad' }), /Invalid attachment/);
  assert.throws(() => validateQuestion({ text: 'question', imageIds: ['file:///secret'] }), /Invalid attachment/);
});
test('ten-image follow-ups retain count and byte bounds with names for unavailable pixels', () => {
  const ids = Array.from({ length: 10 }, () => randomUUID());
  const names = ids.map((_id, i) => `image-${i}.png`);
  const lookup = id => ({ id, data: 'cGl4ZWxz', mime: 'image/jpeg' });
  const history = [{ id: 'user', role: 'user', text: 'Compare these', imageIds: ids, imageNames: names }, { id: 'answer', role: 'assistant', text: 'Answer' }];
  const followup = boundedContext(history, { text: 'Explain' }, lookup);
  assert.deepEqual(followup[0].images.map(image => image.id), ids);
  const next = boundedContext(history, { text: 'Compare again', imageIds: ids }, lookup);
  assert.equal(next[0].images.length + next.at(-1).images.length, 10);
  assert.equal(next[0].images.length, 0, 'Current attachments reserve all ten context slots');
  assert.deepEqual(next.at(-1).images.map(image => image.id), ids);
  for (const name of names) assert.ok(next[0].text.includes(name));
  const partial = boundedContext(history, { text: 'Compare two more', imageIds: ids.slice(0, 2) }, lookup);
  assert.equal(partial[0].images.length, 8);
  assert.equal(partial.at(-1).images.length, 2);
  for (const name of names.slice(8)) assert.ok(partial[0].text.includes(name));
  const restored = boundedContext(validateHistory(diskHistory(history)), { text: 'Explain' }, lookup);
  assert.equal(restored[0].images.length, 0);
  for (const name of names) assert.ok(restored[0].text.includes(name));
  const huge = () => ({ data: Buffer.alloc(4 * 1024 * 1024).toString('base64') });
  const bounded = boundedContext(history, { text: 'New', imageIds: ids.slice(0, 5) }, huge);
  assert.equal(bounded[0].images.length, 0, 'Current images reserve the 20 MiB budget');
  assert.equal(bounded.at(-1).images.length, 5);
  const historicalOnly = boundedContext(history, { text: 'Explain the images' }, huge);
  assert.equal(historicalOnly[0].images.length, 5, 'Historical pixels remain limited to 20 MiB');
  for (const name of names.slice(5)) assert.ok(historicalOnly[0].text.includes(name));
  const allCurrent = boundedContext(history, { text: 'New', imageIds: ids }, huge);
  assert.equal(allCurrent[0].images.length, 0);
  assert.equal(allCurrent.at(-1).images.length, 10, 'Selected current images are never silently dropped');
  const saved = validateHistory(diskHistory(history));
  assert.deepEqual(saved[0].imageNames, names);
  assert.throws(() => validateHistory([{ ...saved[0], imageNames: [...names, 'overflow.png'] }, saved[1]]), /Invalid conversation data/);
});
test('disk history contains no image pixels or API keys and rejects malformed pairs', () => {
  const history = [{ id: '1', role: 'user', text: 'hello', imageId: 'secret', data: 'pixel' }, { id: '2', role: 'assistant', text: 'hi', apiKey: 'private' }];
  const disk = JSON.stringify(diskHistory(history)); assert.ok(!disk.includes('secret') && !disk.includes('private') && !disk.includes('pixel'));
  assert.equal(validateHistory(history).length,2); assert.throws(() => validateHistory([history[1]]));
});
test('restored or evicted image context explicitly tells the model pixels are unavailable', () => {
  const messages = [{role:'user',text:'Answer the image',imageName:'question.png'}, {role:'assistant',text:'42'}];
  const context = boundedContext(messages,{text:'Explain the diagram'},()=>null);
  assert.match(context[0].text,/pixels are not available/);
  assert.equal(context[0].image,null);
});
