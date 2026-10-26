'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync, sign, createHash } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ChatGPTAuth, ACCOUNT_FILE, HOST_FILE } = require('../overlay/chatgpt-auth');
const { Store } = require('../overlay/storage');

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const key = { ...publicKey.export({ format: 'jwk' }), kid: 'fixture-key', alg: 'RS256', use: 'sig' };
const NOW = 1793016000000;
const SCOPE = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const json = (data, status = 200) => new Response(JSON.stringify(data), { status });

class MemoryStore {
  constructor() { this.values = new Map(); this.writes = []; this.secure = true; this.failWrites = false; }
  available() { return this.secure; }
  read(name, fallback) { return structuredClone(this.values.has(name) ? this.values.get(name) : fallback); }
  write(name, value, encrypted = false) {
    if (this.failWrites) throw Error('fixture disk failure');
    if (name === ACCOUNT_FILE) assert.equal(encrypted, true, 'Account credentials must use protected storage.');
    this.writes.push({ name, encrypted }); this.values.set(name, structuredClone(value));
  }
}
function jwt(claims, header = {}) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const body = `${encode({ alg: 'RS256', kid: key.kid, ...header })}.${encode(claims)}`;
  return `${body}.${sign('sha256', Buffer.from(body), privateKey).toString('base64url')}`;
}
function fixture(t, options = {}) {
  const store = options.store || new MemoryStore();
  const state = { now: NOW, urls: [], calls: [], client: 'oaiapp_fixture_one', subject: 'subject-one',
    granted: SCOPE, identityOverrides: {}, headerOverrides: {}, ...options };
  const tokenResult = () => {
    const auth = state.urls.at(-1);
    return {
      token_type: 'Bearer', expires_in: 3600, scope: state.granted,
      access_token: 'access-token-fixture-one', refresh_token: 'refresh-token-fixture-one',
      id_token: jwt({ iss: 'https://auth.openai.com', sub: state.subject, aud: state.client,
        nonce: auth?.searchParams.get('nonce'), iat: Math.floor(state.now / 1000), exp: Math.floor(state.now / 1000) + 3600,
        email: 'person@example.test', name: 'Fixture Person', ...state.identityOverrides }, state.headerOverrides)
    };
  };
  const fetchImpl = async (url, init = {}) => {
    state.calls.push({ url, init });
    if (state.handler) { const result = await state.handler(url, init, tokenResult); if (result !== undefined) return result; }
    if (url.endsWith('/.well-known/openid-configuration')) return json({ issuer: 'https://auth.openai.com', jwks_uri: 'https://auth.openai.com/.well-known/jwks.json', revocation_endpoint: 'https://auth.openai.com/oauth/revoke' });
    if (url.endsWith('/.well-known/jwks.json')) return json({ keys: [key] });
    if (url.endsWith('/api/accounts/oauth/token')) return json(tokenResult());
    if (url.endsWith('/oauth/revoke')) return new Response('', { status: 200 });
    throw Error('Unexpected fixture URL');
  };
  const auth = new ChatGPTAuth({ store, fetchImpl, now: () => state.now, timeoutMs: options.timeoutMs || 3000,
    openExternal: async url => { state.urls.push(new URL(url)); if (state.browserFailure) throw Error('browser failed with private URL'); },
    onChange: status => { state.lastStatus = status; } });
  t.after(() => { auth.cancelSignIn(); });
  return { auth, store, state, tokenResult };
}
async function begin(auth, state, options) {
  const count = state.urls.length;
  const promise = auth.signIn(options);
  // Register a rejection handler before driving negative callbacks.
  promise.catch(() => {});
  for (let i = 0; state.urls.length === count && i < 100; i++) await delay(2);
  const url = state.urls[count]; assert.ok(url, 'Browser authorization URL should be opened.');
  return { promise, url };
}
async function callback(url, values = {}) {
  const target = new URL(url.searchParams.get('redirect_uri'));
  target.searchParams.set('state', url.searchParams.get('state'));
  target.searchParams.set('code', 'fixture-authorization-code');
  target.searchParams.set('client_id', 'oaiapp_fixture_one');
  for (const [key, value] of Object.entries(values)) { if (value === null) target.searchParams.delete(key); else target.searchParams.set(key, value); }
  return fetch(target, { redirect: 'error' });
}
async function login(auth, state, options, values) {
  const attempt = await begin(auth, state, options);
  await callback(attempt.url, values);
  return attempt.promise;
}
function tokenCalls(state, grant) {
  return state.calls.filter(call => call.url.endsWith('/api/accounts/oauth/token') && new URLSearchParams(call.init.body).get('grant_type') === grant);
}

test('dynamic registration binds an ephemeral listener first, validates identity and protects saved credentials', async t => {
  const { auth, state, store } = fixture(t);
  assert.equal(state.calls.length, 0, 'Offline startup must not contact OpenAI.');
  assert.equal(store.values.size, 0);
  const { promise, url } = await begin(auth, state);
  assert.equal(url.origin, 'https://auth.openai.com');
  assert.equal(url.pathname, '/api/accounts/authorize');
  assert.equal(url.searchParams.get('client_id'), 'dynamic_agent_client');
  assert.equal(url.searchParams.get('agent_name_hint'), 'OpenCluely Overlay');
  assert.match(url.searchParams.get('ext_agent_host_id'), /^urn:uuid:/);
  const redirect = new URL(url.searchParams.get('redirect_uri'));
  assert.equal(redirect.hostname, '127.0.0.1'); assert.equal(redirect.pathname, '/auth/callback'); assert.ok(Number(redirect.port) > 0);
  assert.equal((await fetch(new URL('/wrong-path', redirect))).status, 404);
  assert.equal((await callback(url)).status, 200);
  const result = await promise;
  assert.equal(result.connected, true); assert.equal(result.sharing, true); assert.equal(result.busy, false);
  assert.equal(result.profiles.length, 1);
  assert.equal(result.profiles[0].email, 'person@example.test');
  const exchange = new URLSearchParams(tokenCalls(state, 'authorization_code')[0].init.body);
  assert.equal(exchange.get('client_id'), 'oaiapp_fixture_one');
  assert.equal(exchange.get('redirect_uri'), redirect.href);
  assert.equal(exchange.get('resource'), 'https://api.openai.com/v1');
  assert.equal(createHash('sha256').update(exchange.get('code_verifier')).digest('base64url'), url.searchParams.get('code_challenge'));
  assert.equal(exchange.has('client_secret'), false);
  assert.equal(await auth.accessToken(), 'access-token-fixture-one');
  assert.equal(JSON.stringify(result).includes('access-token'), false);
  assert.equal(JSON.stringify(result).includes('refresh-token'), false);
  assert.equal(JSON.stringify(result).includes('eyJ'), false);
  assert.equal(store.writes.find(write => write.name === ACCOUNT_FILE).encrypted, true);
});

test('state mismatch, duplicate parameters, unrelated paths and replay never exchange a code', async t => {
  const { auth, state } = fixture(t);
  const { promise, url } = await begin(auth, state);
  assert.equal((await callback(url, { state: 'wrong-state' })).status, 400);
  assert.equal(tokenCalls(state, 'authorization_code').length, 0);
  const duplicate = new URL(url.searchParams.get('redirect_uri'));
  duplicate.searchParams.append('state', url.searchParams.get('state')); duplicate.searchParams.append('state', url.searchParams.get('state'));
  duplicate.searchParams.set('code', 'one'); duplicate.searchParams.set('client_id', state.client);
  assert.equal((await fetch(duplicate)).status, 400);
  assert.equal(auth.publicState().busy, true);
  await callback(url); await promise;
  await assert.rejects(callback(url));
  assert.equal(tokenCalls(state, 'authorization_code').length, 1);
});

test('callback requires issued registration client and cancellation closes its listener', async t => {
  const { auth, state } = fixture(t);
  let attempt = await begin(auth, state);
  await callback(attempt.url, { client_id: null });
  await assert.rejects(attempt.promise, /registration was incomplete/);
  assert.equal(tokenCalls(state, 'authorization_code').length, 0);
  attempt = await begin(auth, state);
  await callback(attempt.url, { error: 'access_denied', code: null, client_id: null });
  await assert.rejects(attempt.promise, /canceled or permission was declined/);
  assert.equal(auth.publicState().connected, false);
  attempt = await begin(auth, state);
  auth.cancelSignIn(); await assert.rejects(attempt.promise, /canceled/);
  await assert.rejects(callback(attempt.url));
  assert.equal(auth.publicState().busy, false);
});

test('an expired initial code retries with its issued client and fresh PKCE without trusting an unverified identity', async t => {
  const { auth, state } = fixture(t);
  state.handler = async url => { if (url.endsWith('/api/accounts/oauth/token')) return json({ error: 'invalid_grant' }, 400); };
  const initial = await begin(auth, state); await callback(initial.url);
  await assert.rejects(initial.promise, error => error.code === 'invalid_grant');
  assert.equal(auth.publicState().profiles.length, 0);
  state.handler = null;
  const retry = await begin(auth, state);
  assert.equal(retry.url.searchParams.get('client_id'), state.client);
  assert.equal(retry.url.searchParams.has('agent_name_hint'), false);
  assert.notEqual(retry.url.searchParams.get('state'), initial.url.searchParams.get('state'));
  assert.notEqual(retry.url.searchParams.get('code_challenge'), initial.url.searchParams.get('code_challenge'));
  await callback(retry.url, { client_id: null }); await retry.promise;
  assert.equal(auth.publicState().profiles.length, 1);
  assert.equal(auth.publicState().connected, true);
});

for (const [name, identityOverrides, headerOverrides] of [
  ['wrong issuer', { iss: 'https://attacker.test' }],
  ['wrong audience', { aud: 'another-client' }],
  ['wrong nonce', { nonce: 'not-the-attempt-nonce' }],
  ['expired identity', { exp: Math.floor(NOW / 1000) - 1 }],
  ['future identity', { nbf: Math.floor(NOW / 1000) + 3600 }],
  ['ambiguous audience', { aud: ['oaiapp_fixture_one', 'another-client'] }],
  ['unsigned algorithm', {}, { alg: 'none' }],
  ['unknown signing key', {}, { kid: 'unpublished-key' }]
]) test(`identity validation rejects ${name} without saving a profile`, async t => {
  const { auth, state, store } = fixture(t, { identityOverrides, headerOverrides });
  const attempt = await begin(auth, state); await callback(attempt.url);
  await assert.rejects(attempt.promise, /identity|signature/);
  assert.equal(auth.publicState().profiles.length, 0); assert.equal(store.values.has(ACCOUNT_FILE), false);
});

test('forged signature is rejected even with otherwise matching claims', async t => {
  const { auth, state } = fixture(t);
  state.handler = async (url, _init, result) => {
    if (url.endsWith('/api/accounts/oauth/token')) {
      const tokens = result();
      const parts = tokens.id_token.split('.'); parts[2] = Buffer.alloc(256).toString('base64url'); tokens.id_token = parts.join('.');
      return json(tokens);
    }
  };
  const attempt = await begin(auth, state); await callback(attempt.url);
  await assert.rejects(attempt.promise, /identity/);
  assert.equal(auth.publicState().connected, false);
});

test('declined plan-usage scope retains verified identity while blocking inference', async t => {
  const { auth, state } = fixture(t, { granted: 'openid profile email' });
  await login(auth, state);
  assert.equal(auth.publicState().connected, true); assert.equal(auth.publicState().sharing, false);
  await assert.rejects(auth.accessToken(), error => error.code === 'chatgpt_plan_usage_disabled');
  const attempt = await begin(auth, state, { consent: true });
  assert.equal(attempt.url.searchParams.get('client_id'), state.client);
  assert.equal(attempt.url.searchParams.get('prompt'), 'consent');
  assert.ok(attempt.url.searchParams.get('scope').includes('chatgpt.tokens.use.direct'));
  auth.cancelSignIn(); await assert.rejects(attempt.promise);
});

test('account registrations stay separate and failed reauthorization preserves the active account', async t => {
  const { auth, state, store } = fixture(t);
  await login(auth, state);
  const first = auth.publicState().activeProfileId;
  auth.setProfilePreferences({ model: 'model-one', reasoningEfforts: { 'model-one': 'high' }, models: [{ id: 'model-one' }] });
  const notifications = state.lastStatus;
  auth.setProfilePreferences({ total: 1 });
  assert.equal(state.lastStatus, notifications, 'Preference saves must not recurse through onChange.');
  state.client = 'oaiapp_fixture_two'; state.subject = 'subject-two';
  await login(auth, state, { newProfile: true }, { client_id: state.client });
  const second = auth.publicState().activeProfileId;
  assert.notEqual(second, first); assert.equal(auth.publicState().profiles.length, 2);
  assert.notEqual(auth.publicState().profiles[0].label, auth.publicState().profiles[1].label);
  assert.deepEqual(auth.getProfilePreferences(), {});
  await auth.selectProfile(first);
  assert.equal(auth.getProfilePreferences().model, 'model-one');
  const host = store.read(HOST_FILE, null).id;
  const attempt = await begin(auth, state, { profileId: first });
  assert.equal(attempt.url.searchParams.get('client_id'), 'oaiapp_fixture_one');
  assert.equal(attempt.url.searchParams.has('agent_name_hint'), false);
  assert.equal(attempt.url.searchParams.get('ext_agent_host_id'), host);
  assert.ok(attempt.url.searchParams.get('id_token_hint'));
  assert.equal(attempt.url.searchParams.get('login_hint'), 'person@example.test');
  state.identityOverrides = { aud: 'oaiapp_fixture_one', sub: 'different-subject' };
  await callback(attempt.url, { client_id: null });
  await assert.rejects(attempt.promise, /identity/);
  assert.equal(auth.publicState().activeProfileId, first);
  assert.equal(await auth.accessToken(), 'access-token-fixture-one');
});

test('returning callback cannot replace a selected registration with another client ID', async t => {
  const { auth, state } = fixture(t); await login(auth, state);
  const attempt = await begin(auth, state);
  await callback(attempt.url, { client_id: 'oaiapp_attacker' });
  await assert.rejects(attempt.promise, /registration/);
  assert.equal(tokenCalls(state, 'authorization_code').length, 1);
  assert.equal(auth.publicState().connected, true);
});

test('refresh rotation is serialized, atomic, scoped to its registration and restored offline', async t => {
  const { auth, state, store } = fixture(t); await login(auth, state);
  state.now += 3600000;
  state.handler = async (url, init) => {
    if (url.endsWith('/api/accounts/oauth/token') && new URLSearchParams(init.body).get('grant_type') === 'refresh_token') {
      await delay(10);
      return json({ access_token: 'access-token-rotated', refresh_token: 'refresh-token-rotated', token_type: 'Bearer', expires_in: 3600 });
    }
  };
  const results = await Promise.all([auth.accessToken(), auth.accessToken(), auth.accessToken()]);
  assert.deepEqual(results, Array(3).fill('access-token-rotated'));
  const refresh = tokenCalls(state, 'refresh_token'); assert.equal(refresh.length, 1);
  const form = new URLSearchParams(refresh[0].init.body);
  assert.equal(form.get('client_id'), 'oaiapp_fixture_one'); assert.equal(form.get('refresh_token'), 'refresh-token-fixture-one');
  assert.equal(form.get('resource'), 'https://api.openai.com/v1'); assert.equal(form.has('scope'), false);
  const credentials = store.read(ACCOUNT_FILE).profiles[0].tokens;
  assert.equal(credentials.accessToken, 'access-token-rotated'); assert.equal(credentials.refreshToken, 'refresh-token-rotated');
  const restored = fixture(t, { store, now: state.now });
  assert.equal(restored.state.calls.length, 0);
  assert.equal(await restored.auth.accessToken(), 'access-token-rotated');
  assert.equal(restored.state.calls.length, 0);
});

test('one canceled caller does not abort a shared rotating-token refresh', async t => {
  const { auth, state } = fixture(t); await login(auth, state); state.now += 3600000;
  let release; const gate = new Promise(resolve => { release = resolve; });
  state.handler = async (url, init) => {
    if (url.endsWith('/api/accounts/oauth/token') && new URLSearchParams(init.body).get('grant_type') === 'refresh_token') {
      await gate;
      return json({ access_token: 'renewed', refresh_token: 'rotated', token_type: 'Bearer', expires_in: 3600 });
    }
  };
  const controller = new AbortController();
  const canceled = auth.accessToken({ signal: controller.signal }); canceled.catch(() => {});
  const other = auth.accessToken(); controller.abort();
  await assert.rejects(canceled, error => error.code === 'chatgpt_request_canceled');
  release(); assert.equal(await other, 'renewed');
  assert.equal(tokenCalls(state, 'refresh_token').length, 1);
});

test('temporary refresh failure preserves credentials; terminal refresh revocation clears tokens only', async t => {
  const { auth, state, store } = fixture(t); await login(auth, state); state.now += 3600000;
  const profileId = auth.publicState().activeProfileId;
  state.handler = async url => { if (url.endsWith('/api/accounts/oauth/token')) throw Error('network exception containing secret'); };
  await assert.rejects(auth.accessToken(), error => error.code === 'chatgpt_auth_network' && !error.message.includes('secret'));
  assert.equal(auth.publicState().connected, true);
  state.handler = async url => { if (url.endsWith('/api/accounts/oauth/token')) return json({ error: 'refresh_token_reused', error_description: 'private service details' }, 400); };
  await assert.rejects(auth.accessToken(), error => error.code === 'chatgpt_reconnect_required');
  assert.equal(auth.publicState().connected, false); assert.equal(auth.publicState().activeProfileId, profileId);
  assert.equal(auth.publicState().profiles.length, 1);
  assert.equal(store.read(ACCOUNT_FILE).profiles[0].clientId, 'oaiapp_fixture_one');
  assert.equal(store.read(ACCOUNT_FILE).profiles[0].tokens, undefined);
  assert.equal(JSON.stringify(auth.publicState()).includes('private service details'), false);
});

test('a rotated token is disconnected in memory if its replacement cannot be persisted', async t => {
  const { auth, state, store } = fixture(t); await login(auth, state); state.now += 3600000;
  store.failWrites = true;
  state.handler = async url => {
    if (url.endsWith('/api/accounts/oauth/token')) return json({ access_token: 'rotated-access', refresh_token: 'consumed-old-refresh', token_type: 'Bearer', expires_in: 3600 });
  };
  await assert.rejects(auth.accessToken(), error => error.code === 'chatgpt_refresh_storage_failed');
  assert.equal(auth.publicState().connected, false);
  const count = tokenCalls(state, 'refresh_token').length;
  await assert.rejects(auth.accessToken(), error => error.code === 'chatgpt_not_connected');
  assert.equal(tokenCalls(state, 'refresh_token').length, count, 'Never retry a consumed rotating token after storage failure.');
});

test('revoked tokens never become usable again when local sign-out persistence fails', async t => {
  const { auth, state, store } = fixture(t); await login(auth, state); store.failWrites = true;
  await assert.rejects(auth.signOut(), error => error.code === 'chatgpt_signout_storage_failed');
  assert.equal(auth.publicState().connected, false); assert.equal(auth.publicState().busy, false);
  assert.equal(state.calls.filter(call => call.url.endsWith('/oauth/revoke')).length, 1);
  await assert.rejects(auth.accessToken(), error => error.code === 'chatgpt_not_connected');
});

test('renewed scopes are checked again before returning an inference token', async t => {
  const { auth, state } = fixture(t); await login(auth, state); state.now += 3600000;
  state.handler = async url => {
    if (url.endsWith('/api/accounts/oauth/token')) return json({ access_token: 'identity-only-access', refresh_token: 'rotated-refresh', token_type: 'Bearer', expires_in: 3600, scope: 'openid profile email offline_access' });
  };
  await assert.rejects(auth.accessToken(), error => error.code === 'chatgpt_plan_usage_disabled');
  assert.equal(auth.publicState().connected, true); assert.equal(auth.publicState().sharing, false);
});

test('sign-out revokes the renewable session, clears tokens, retains mapping and reuses host without hints', async t => {
  const { auth, state, store } = fixture(t); await login(auth, state);
  const id = auth.publicState().activeProfileId, hostId = store.read(HOST_FILE).id;
  const result = await auth.signOut(); assert.equal(result.revoked, true);
  assert.equal(auth.publicState().connected, false); assert.equal(auth.publicState().profiles[0].needsSignIn, true);
  const call = state.calls.find(call => call.url.endsWith('/oauth/revoke'));
  const form = new URLSearchParams(call.init.body);
  assert.equal(form.get('token_type_hint'), 'refresh_token'); assert.equal(form.get('client_id'), state.client);
  assert.equal(form.get('token'), 'refresh-token-fixture-one');
  const attempt = await begin(auth, state, { profileId: id });
  assert.equal(attempt.url.searchParams.get('client_id'), state.client);
  assert.equal(attempt.url.searchParams.get('ext_agent_host_id'), hostId);
  assert.equal(attempt.url.searchParams.has('id_token_hint'), false);
  auth.cancelSignIn(); await assert.rejects(attempt.promise);
});

test('offline sign-out clears local tokens and reports unconfirmed remote revocation', async t => {
  const { auth, state, store } = fixture(t); await login(auth, state);
  state.handler = async url => { if (url.endsWith('/oauth/revoke')) return json({ error: 'temporarily_unavailable' }, 503); };
  const result = await auth.signOut(); assert.equal(result.revoked, false); assert.match(result.warning, /Remote revocation was not confirmed/);
  assert.equal(state.calls.filter(call => call.url.endsWith('/oauth/revoke')).length, 2);
  assert.equal(store.read(ACCOUNT_FILE).profiles[0].tokens, undefined);
  await assert.rejects(auth.accessToken(), error => error.code === 'chatgpt_not_connected');
});

test('an access-only session works through expiry but does not claim confirmed remote revocation', async t => {
  const { auth, state } = fixture(t, { granted: 'openid profile email resource.invoke chatgpt.tokens.use.direct' });
  state.handler = async (url, _init, result) => {
    if (url.endsWith('/api/accounts/oauth/token')) { const tokens = result(); delete tokens.refresh_token; return json(tokens); }
  };
  await login(auth, state); state.now += 3570000;
  assert.equal(await auth.accessToken(), 'access-token-fixture-one');
  state.now += 30001;
  await assert.rejects(auth.accessToken(), error => error.code === 'chatgpt_reconnect_required');
  assert.equal(auth.publicState().profiles[0].needsSignIn, true);
  const result = await auth.signOut(); assert.equal(result.revoked, false);
  assert.match(result.warning, /Remote revocation was not confirmed/);
});

test('sign-out waits for a rotating refresh, revokes its replacement and never resurrects credentials', async t => {
  const { auth, state, store } = fixture(t); await login(auth, state); state.now += 3600000;
  let release; const gate = new Promise(resolve => { release = resolve; });
  state.handler = async (url, init) => {
    if (url.endsWith('/api/accounts/oauth/token') && new URLSearchParams(init.body).get('grant_type') === 'refresh_token') {
      await gate;
      return json({ access_token: 'renewed-before-signout', refresh_token: 'replacement-to-revoke', token_type: 'Bearer', expires_in: 3600 });
    }
  };
  const renewing = auth.accessToken();
  const signingOut = auth.signOut();
  await assert.rejects(auth.accessToken(), error => error.code === 'chatgpt_not_connected');
  release(); await renewing; await signingOut;
  const revoke = state.calls.find(call => call.url.endsWith('/oauth/revoke'));
  assert.equal(new URLSearchParams(revoke.init.body).get('token'), 'replacement-to-revoke');
  assert.equal(store.read(ACCOUNT_FILE).profiles[0].tokens, undefined);
});

test('unavailable secure storage, browser errors and timeout fail without leaking credentials', async t => {
  const unavailable = fixture(t); unavailable.store.secure = false;
  await assert.rejects(unavailable.auth.signIn(), error => error.code === 'secure_storage_unavailable');
  assert.equal(unavailable.state.urls.length, 0);
  const browser = fixture(t, { browserFailure: true });
  await assert.rejects(browser.auth.signIn(), error => error.code === 'chatgpt_browser_unavailable' && !error.message.includes('private URL'));
  const timeout = fixture(t, { timeoutMs: 20 });
  await assert.rejects(timeout.auth.signIn(), error => error.code === 'chatgpt_auth_timeout');
  assert.equal(timeout.auth.publicState().busy, false);
});

test('protected Store persists accounts encrypted and restores credentials with no startup network', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opencluely-auth-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const crypto = { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value).map(byte => byte ^ 0x73), decryptString: value => Buffer.from(value).map(byte => byte ^ 0x73).toString() };
  const store = new Store(directory, crypto);
  const first = fixture(t, { store }); await login(first.auth, first.state);
  const disk = fs.readFileSync(path.join(directory, ACCOUNT_FILE), 'utf8');
  assert.equal(disk.includes('access-token'), false); assert.equal(disk.includes('person@example.test'), false);
  const second = fixture(t, { store }); assert.equal(second.auth.publicState().connected, true);
  assert.equal(await second.auth.accessToken(), 'access-token-fixture-one'); assert.equal(second.state.calls.length, 0);
});
