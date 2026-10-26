'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeModels, modelDetails, MODEL_CATALOG } = require('../overlay/models');
const { validateSettings, DEFAULTS } = require('../overlay/core');
const { listProviderModels, buildRequest, streamAnswer } = require('../overlay/providers');
const messages = [{ role: 'user', text: 'Hello' }];
const json = data => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });

test('live catalogs keep chat models, flag text-only IDs, and exclude retired/specialized models', () => {
  const openai = normalizeModels('openai', ['gpt-6.1-sol', 'o3-mini', 'gpt-4', 'gpt-4o', 'gpt-4o-mini', 'gpt-image-2', 'gpt-realtime', 'gpt-audio', 'text-embedding-3-small', '../invalid', 'gpt-6.1-sol'].map(id => ({ id }))
    .concat({ id: 'gpt-5-mini', shutdown_date: '2026-01-01' }));
  assert.deepEqual(new Set(openai.map(model => model.id)), new Set(['gpt-6.1-sol', 'o3-mini', 'gpt-4', 'gpt-4o', 'gpt-4o-mini']));
  assert.equal(openai.find(model => model.id === 'o3-mini').vision, false); assert.equal(openai.find(model => model.id === 'gpt-4').vision, false);
  const google = normalizeModels('gemini', ['gemini-3.8-flash', 'gemma-4-31b-it', 'gemini-3.8-flash-tts', 'gemini-3-pro-image', 'gemini-nano-banana-2.1', 'lyria-3.5'].map(id => ({ name: `models/${id}`, supportedGenerationMethods: ['generateContent'] })));
  assert.deepEqual(new Set(google.map(model => model.id)), new Set(['gemini-3.8-flash', 'gemma-4-31b-it']));
  assert.deepEqual(normalizeModels('gemini', [{ name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['bidiGenerateContent'] }]), []);
});

test('ChatGPT catalogs use account slugs, listed visibility and server ordering without bundled entitlements', async () => {
  assert.deepEqual(MODEL_CATALOG.chatgpt, []);
  const items = [
    { slug: 'account-z', display_name: 'Workspace model Z', visibility: 'list', input_modalities: ['text', 'image'], supported_reasoning_efforts: ['low', 'high'] },
    { slug: 'hidden-model', visibility: 'hidden' },
    { slug: 'account-a', display_name: 'Workspace model A', visibility: 'list' },
    { slug: 'account-z', visibility: 'list' },
    { id: 'api-key-schema-model', visibility: 'list' },
    { slug: '../unsafe', visibility: 'list' }
  ];
  let calls = 0;
  const catalog = await listProviderModels('chatgpt', 'private-oauth-token', { fetchImpl: async (url, input) => {
    calls++;
    assert.equal(url, 'https://api.openai.com/v1/models');
    assert.equal(input.headers.Authorization, 'Bearer private-oauth-token');
    assert.equal(input.redirect, 'error');
    return json({ models: items });
  } });
  assert.equal(calls, 1);
  assert.deepEqual(catalog.models.map(model => model.id), ['account-z', 'account-a']);
  assert.deepEqual(catalog.models.map(model => model.name), ['Workspace model Z', 'Workspace model A']);
  assert.equal(catalog.models[0].vision, true);
  assert.deepEqual(catalog.models[0].reasoningEfforts, ['low', 'high']);
  assert.equal(catalog.models[1].vision, null, 'Unknown capabilities must not be inferred from model names or treated as a denial');
  assert.deepEqual(catalog.models[1].reasoningEfforts, []);
  assert.equal(modelDetails('chatgpt', 'gpt-6.1-sol').vision, null);
  assert.equal(modelDetails('chatgpt', 'account-model', { input_modalities: ['text'] }).vision, false);
  assert.equal(modelDetails('chatgpt', 'account-model', { capabilities: { image_input: { supported: false } } }).vision, false);
  assert.deepEqual(modelDetails('chatgpt', 'gpt-6.1-sol').reasoningEfforts, []);
  await assert.rejects(listProviderModels('chatgpt', 'private-oauth-token', { fetchImpl: async () => json({ data: [{ id: 'api-model' }] }) }), /invalid model catalog/);
});

test('live Claude capability flags override model-name inference and legacy models use budgets', () => {
  const info = modelDetails('anthropic', 'claude-opus-5-5', { capabilities: { effort: { supported: true, low: { supported: true }, medium: { supported: true }, high: { supported: true }, max: { supported: false } }, thinking: { types: { adaptive: { supported: true } } } } });
  assert.deepEqual(info.reasoningEfforts, ['low', 'medium', 'high']);
  assert.equal(info.thinking, 'adaptive');
  const older = modelDetails('anthropic', 'claude-sonnet-4-5-20250929', { capabilities: { effort: { supported: false }, thinking: { types: { enabled: { supported: true } } } } });
  assert.equal(older.reasoningMode, 'thinkingBudget'); assert.deepEqual(older.reasoningEfforts, ['low', 'medium', 'high']);
  assert.deepEqual(modelDetails('gemini', 'gemini-3.8-flash', { thinking: false }).reasoningEfforts, []);
});

test('reasoning controls preserve each model and provider independently without mutating prior preferences', () => {
  const first = validateSettings({ reasoningEfforts: { openai: { 'gpt-6.1-sol': 'high', 'gpt-6-luna': 'low' } } });
  const next = validateSettings({ reasoningEfforts: { openai: { 'gpt-6.1-sol': 'medium' }, gemini: { 'gemini-3.8-flash': 'low' } } }, first);
  assert.equal(first.reasoningEfforts.openai['gpt-6.1-sol'], 'high');
  assert.equal(next.reasoningEfforts.openai['gpt-6-luna'], 'low');
  assert.equal(next.reasoningEfforts.gemini['gemini-3.8-flash'], 'low');
  assert.deepEqual(DEFAULTS.reasoningEfforts, {});
  for (const reasoningEfforts of [null, [], 'high', { other: {} }, { openai: [] }, { openai: { 'gpt-6.1-sol': 'ultra' } }, { openai: { '../model': 'high' } }]) assert.throws(() => validateSettings({ reasoningEfforts }));
});

test('named efforts reach each native API and Auto omits overrides', () => {
  for (const effort of ['low', 'medium', 'high']) {
    assert.deepEqual(buildRequest('openai', 'gpt-6.1-sol', 'private', messages, { reasoningEffort: effort }).body.reasoning, { effort });
    const claude = buildRequest('anthropic', 'claude-sonnet-5-5', 'private', messages, { reasoningEffort: effort }).body;
    assert.deepEqual(claude.output_config, { effort }); assert.deepEqual(claude.thinking, { type: 'adaptive' });
    assert.deepEqual(buildRequest('gemini', 'gemini-3.8-flash', 'private', messages, { reasoningEffort: effort }).body.generationConfig.thinkingConfig, { thinkingLevel: effort });
  }
  assert.equal(buildRequest('openai', 'gpt-6.1-sol', 'private', messages).body.reasoning, undefined);
  assert.equal(buildRequest('anthropic', 'claude-sonnet-5-5', 'private', messages).body.thinking, undefined);
  assert.equal(buildRequest('gemini', 'gemini-3.8-flash', 'private', messages).body.generationConfig.thinkingConfig, undefined);
  assert.throws(() => buildRequest('openai', 'chat-latest', 'private', messages, { reasoningEffort: 'high' }), /does not support/);
  assert.throws(() => buildRequest('openai', 'gpt-6.1-sol', 'private', messages, { reasoningEffort: 'none' }), /does not support/);
  assert.throws(() => buildRequest('gemini', 'gemini-3.8-flash', 'private', messages, { reasoningEffort: 'minimal' }), /does not support/);
  assert.throws(() => buildRequest('openai', 'o3-mini', 'private', [{ role: 'user', text: 'Read', images: [{ mime: 'image/png', data: 'x' }] }]), /text only/);
});

test('legacy thinking budgets leave output room and use provider-specific fields', () => {
  for (const [effort, budget] of [['low', 1024], ['medium', 4096], ['high', 8192]]) {
    const claude = buildRequest('anthropic', 'claude-sonnet-4-5-20250929', 'private', messages, { reasoningEffort: effort }).body;
    assert.deepEqual(claude.thinking, { type: 'enabled', budget_tokens: budget }); assert.ok(claude.max_tokens > budget);
    assert.equal(claude.output_config, undefined);
    const gemini = buildRequest('gemini', 'gemini-2.5-pro', 'private', messages, { reasoningEffort: effort }).body;
    assert.deepEqual(gemini.generationConfig.thinkingConfig, { thinkingBudget: budget }); assert.ok(gemini.generationConfig.maxOutputTokens > budget);
  }
});

test('full model listing follows Gemini and Claude pagination without leaking keys or following remote URLs', async () => {
  for (const provider of ['gemini', 'anthropic']) {
    let calls = 0;
    const result = await listProviderModels(provider, 'private-key', { fetchImpl: async (url, input) => {
      calls++; assert.equal(input.method, 'GET'); assert.equal(input.redirect, 'error'); assert.ok(!url.includes('private-key'));
      const next = 'https://untrusted.invalid/page';
      assert.equal(new URL(url).host, provider === 'gemini' ? 'generativelanguage.googleapis.com' : 'api.anthropic.com');
      if (calls === 2) assert.equal(new URL(url).searchParams.get(provider === 'gemini' ? 'pageToken' : 'after_id'), next);
      return json(provider === 'gemini' ? { models: [{ name: `models/gemini-3.${calls}-flash`, supportedGenerationMethods: ['generateContent'] }], ...(calls === 1 ? { nextPageToken: next } : {}) }
        : { data: [{ id: `claude-sonnet-5-${calls}` }], has_more: calls === 1, last_id: next });
    } });
    assert.equal(calls, 2); assert.equal(result.total, 2); assert.equal(result.models.length, 2); assert.ok(Date.parse(result.checkedAt));
  }
  const openai = await listProviderModels('openai', 'private-key', { fetchImpl: async (_url, input) => { assert.equal(input.headers.Authorization, 'Bearer private-key'); return json({ data: [{ id: 'gpt-6.1-sol' }] }); } });
  assert.equal(openai.models[0].id, 'gpt-6.1-sol');
});

test('catalog errors, malformed pagination, timeouts, and bad JSON fail with safe messages', async () => {
  for (const status of [401, 403, 429, 503]) await assert.rejects(listProviderModels('gemini', 'private-key', { fetchImpl: async () => new Response('private-key', { status }) }), error => !error.message.includes('private-key'));
  await assert.rejects(listProviderModels('anthropic', 'private-key', { fetchImpl: async () => json({ data: [], has_more: true }) }), /incomplete/);
  await assert.rejects(listProviderModels('gemini', 'private-key', { fetchImpl: async () => json({ models: [], nextPageToken: 'same' }) }), /invalid model pagination/);
  await assert.rejects(listProviderModels('openai', 'private-key', { fetchImpl: async () => json({ data: 'private-key' }) }), /invalid model catalog/);
  await assert.rejects(listProviderModels('openai', 'private-key', { fetchImpl: async () => { throw new Error('private-key'); } }), error => !error.message.includes('private-key'));
  await assert.rejects(listProviderModels('gemini', 'private-key', { timeoutMs: 5, fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason))) }), /timed out/);
});

test('the streaming path forwards selected effort and rejects invalid effort before any network request', async () => {
  let calls = 0;
  const fetchImpl = async (_url, input) => {
    calls++; assert.deepEqual(JSON.parse(input.body).reasoning, { effort: 'high' });
    return new Response('data: {"type":"response.output_text.delta","delta":"OK"}\n\ndata: {"type":"response.completed"}\n\n');
  };
  assert.equal((await streamAnswer({ provider: 'openai', model: 'gpt-6.1-sol', apiKey: 'private-key', messages, reasoningEffort: 'high', fetchImpl })).text, 'OK');
  await assert.rejects(streamAnswer({ provider: 'openai', model: 'gpt-6.1-sol', apiKey: 'private-key', messages, reasoningEffort: 'none', fetchImpl }), /does not support/);
  assert.equal(calls, 1);
  assert.ok(MODEL_CATALOG.gemini.some(model => model.id === 'gemini-4-argon'));
});
