'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { setTimeout: delay } = require('node:timers/promises');
const { CodexConnection, binaryPath, childEnvironment, serverArgs, questionInput } = require('../overlay/codex');
const { normalizeModels } = require('../overlay/models');

function fixture(t, options = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'opencluely-codex-unit-'));
  const child = new EventEmitter(); Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  child.kill = () => { queueMicrotask(() => child.emit('close', 0)); return true; };
  const state = { requests: [], urls: [], account: null, handler: null, ...options };
  const send = (method, params) => child.stdout.write(JSON.stringify({ method, params }) + '\n');
  let input = '';
  child.stdin.on('data', data => {
    input += data.toString(); let index;
    while ((index = input.indexOf('\n')) >= 0) {
      const value = JSON.parse(input.slice(0, index)); input = input.slice(index + 1); state.requests.push(value);
      if (value.id === undefined) continue;
      queueMicrotask(async () => {
        let result = {};
        if (state.handler) { const valueResult = await state.handler(value); if (valueResult !== undefined) result = valueResult; }
        if (value.method === 'account/read') result = { account: state.account };
        if (value.method === 'account/login/start') result = { type: 'chatgpt', loginId: 'fixture-login', authUrl: state.url || 'https://auth.openai.com/oauth/authorize?state=fixture' };
        if (value.method === 'account/logout') state.account = null;
        if (value.method === 'thread/start') result = { thread: { id: 'thread-fixture' } };
        if (value.method === 'turn/start') result = { turn: { id: 'turn-fixture' } };
        if (value.method === 'model/list') result = { data: [{ id: 'model-one', model: 'codex-model-one', displayName: 'Codex One', inputModalities: ['text', 'image'], supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }] };
        if (value.method === 'hold') return;
        if (value.method === 'fail') { child.stdout.write(JSON.stringify({ id: value.id, error: { code: -1, message: 'sensitive-provider-response' } }) + '\n'); return; }
        child.stdout.write(JSON.stringify({ id: value.id, result }) + '\n');
        if (value.method === 'turn/start' && state.turn) state.turn(send);
      });
    }
  });
  const client = new CodexConnection({ directory: home, resolveBinary: () => 'fixture-codex.exe', timeoutMs: 200, loginTimeoutMs: 1000,
    spawnImpl: (_exe, args, spawnOptions) => { state.args = args; state.spawnOptions = spawnOptions; return child; },
    openExternal: async url => { state.urls.push(url); }, ...options.client });
  t.after(() => client.stop());
  return { client, state, send, child, home };
}
async function until(predicate) { for (let i = 0; i < 100; i++) { if (predicate()) return; await delay(5); } throw Error('Fixture condition timed out'); }

test('Codex uses its pinned native binary and isolated OS credential store', () => {
  assert.ok(fs.existsSync(binaryPath()));
  assert.match(binaryPath(), /@openai[\\/]codex-/);
  const env = childEnvironment('fixture-own-home');
  assert.equal(env.CODEX_HOME, 'fixture-own-home');
  assert.equal(env.OPENAI_API_KEY, undefined); assert.equal(env.OPENAI_BASE_URL, undefined);
  assert.ok(serverArgs().includes('cli_auth_credentials_store="keyring"'));
  assert.ok(serverArgs().includes('features.shell_tool=false'));
  assert.ok(serverArgs().includes('features.multi_agent=false'));
});
test('Codex model schema stays separate from ChatGPT plan and API model schemas', () => {
  const models = normalizeModels('codex', [{ id: 'rpc-id', model: 'actual-model', displayName: 'Account Model', inputModalities: ['text'], supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'max' }] }, { id: 'hidden-model', hidden: true }]);
  assert.equal(models[0].id, 'actual-model'); assert.match(models[0].name, /Account Model/);
  assert.equal(models[0].vision, false); assert.deepEqual(models[0].reasoningEfforts, ['low', 'max']); assert.equal(models.length, 1);
  assert.deepEqual(normalizeModels('chatgpt', [{ id: 'actual-model' }]), []);
});
test('Codex initialization and account state never return raw account credentials', async t => {
  const { client, state } = fixture(t, { account: { type: 'chatgpt', email: 'owner@example.test', planType: 'plus', access_token: 'hidden-secret' } });
  await client.readAccount();
  assert.equal(state.requests[0].method, 'initialize'); assert.equal(state.requests[1].method, 'initialized');
  assert.equal(client.publicState().connected, true); assert.equal(state.spawnOptions.windowsHide, true);
  assert.equal(JSON.stringify(client.publicState()).includes('hidden-secret'), false);
});
test('Codex browser sign-in completes only after successful notification and account read', async t => {
  const { client, state, send } = fixture(t);
  const login = client.signIn();
  await until(() => state.urls.length > 0);
  assert.equal(client.publicState().signingIn, true); assert.equal(client.publicState().connected, false);
  state.account = { type: 'chatgpt', email: 'owner@example.test', planType: 'pro' };
  send('account/login/completed', { loginId: 'other-login', success: true });
  await delay(5); assert.equal(client.publicState().connected, false);
  send('account/login/completed', { loginId: 'fixture-login', success: true });
  await login; assert.equal(client.publicState().connected, true); assert.equal(client.publicState().busy, false);
  const catalog = await client.listModels(); assert.equal(catalog.models[0].id, 'codex-model-one');
  await client.signOut(); assert.equal(client.publicState().connected, false);
});
test('Codex sign-in supports cancellation and rejects untrusted authorization URLs', async t => {
  const { client, state } = fixture(t);
  const login = client.signIn(); const rejected = assert.rejects(login, /canceled/);
  await until(() => state.urls.length); await client.cancelSignIn(); await rejected;
  assert.ok(state.requests.some(value => value.method === 'account/login/cancel'));
  assert.equal(client.publicState().busy, false);
  state.url = 'https://example.test/steal-login';
  await assert.rejects(client.signIn(), /not completed/); assert.equal(state.urls.length, 1);
});
test('Codex RPC timeouts and failures expose safe messages', async t => {
  const { client } = fixture(t); await client.start();
  await assert.rejects(client.rpc('hold', {}, 10), /did not respond/);
  await assert.rejects(client.rpc('fail'), error => !error.message.includes('sensitive-provider-response'));
});
test('Codex text/image streaming supplies bounded context, chosen model and effort', async t => {
  const { client, state } = fixture(t, { account: { type: 'chatgpt' }, turn: send => {
    send('item/agentMessage/delta', { threadId: 'thread-fixture', itemId: 'message-one', delta: 'Image answer' });
    send('item/completed', { threadId: 'thread-fixture', item: { id: 'message-one', type: 'agentMessage', text: 'Image answer' } });
    send('turn/completed', { threadId: 'thread-fixture', turn: { id: 'turn-fixture', status: 'completed' } });
  } });
  await client.readAccount(); let delta = '';
  const messages = [{ role: 'user', text: 'first' }, { role: 'assistant', text: 'previous answer' }, { role: 'user', text: 'Question', images: [{ mime: 'image/png', data: 'fixture-base64' }] }];
  const result = await client.answer({ model: 'codex-model-one', messages, reasoningEffort: 'high', signal: new AbortController().signal, onDelta: value => { delta += value; } });
  assert.equal(result.text, 'Image answer'); assert.equal(delta, result.text);
  const start = state.requests.find(value => value.method === 'thread/start').params;
  assert.equal(start.model, 'codex-model-one'); assert.equal(start.ephemeral, true); assert.equal(start.sandbox, 'read-only'); assert.equal(start.approvalPolicy, 'never');
  const turn = state.requests.find(value => value.method === 'turn/start').params;
  assert.equal(turn.effort, 'high'); assert.deepEqual(turn.input, questionInput(messages));
  assert.equal(turn.input.at(-1).url, 'data:image/png;base64,fixture-base64');
});
test('Codex partial output followed by failure is not treated as success or automatically resent', async t => {
  const { client, state } = fixture(t, { account: { type: 'chatgpt' }, turn: send => {
    send('item/agentMessage/delta', { threadId: 'thread-fixture', itemId: 'one', delta: 'partial' });
    send('turn/completed', { threadId: 'thread-fixture', turn: { status: 'failed' } });
  } });
  await client.readAccount(); let partial = '';
  await assert.rejects(client.answer({ model: 'codex-model-one', messages: [{ role: 'user', text: 'question' }], signal: new AbortController().signal, onDelta: text => { partial += text; } }), /could not complete/);
  assert.equal(partial, 'partial'); assert.equal(state.requests.filter(value => value.method === 'turn/start').length, 1);
});
test('Codex cancellation interrupts only its active turn', async t => {
  const { client, state } = fixture(t, { account: { type: 'chatgpt' } });
  await client.readAccount(); const controller = new AbortController();
  const answer = client.answer({ model: 'codex-model-one', messages: [{ role: 'user', text: 'question' }], signal: controller.signal, onDelta: () => {} });
  const rejected = assert.rejects(answer, /stopped/);
  await until(() => state.requests.some(value => value.method === 'turn/start')); await delay(5); controller.abort(); await rejected;
  assert.ok(state.requests.some(value => value.method === 'turn/interrupt' && value.params.turnId === 'turn-fixture'));
});
test('real packaged Codex binary can initialize with a fresh isolated profile and no login', { timeout: 45000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opencluely-codex-native-'));
  const client = new CodexConnection({ directory, openExternal: () => { throw Error('No browser login during tests'); }, timeoutMs: 30000 });
  t.after(() => client.stop());
  const account = await client.readAccount();
  assert.equal(account.connected, false); assert.equal(fs.existsSync(path.join(directory, 'auth.json')), false);
  const thread = await client.rpc('thread/start', { model: 'gpt-6.1-sol', cwd: client.workspace, ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only', baseInstructions: 'Answer supplied text and images only.' });
  assert.equal(typeof thread.thread.id, 'string');
});
test('real Codex managed login returns an official browser URL and cancels without saving credentials', { timeout: 45000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opencluely-codex-login-'));
  let authURL;
  const client = new CodexConnection({ directory, openExternal: url => { authURL = new URL(url); }, timeoutMs: 30000 });
  t.after(() => client.stop());
  const login = client.signIn(); const rejected = assert.rejects(login, /canceled/);
  for (let attempt = 0; attempt < 300 && !authURL; attempt++) await delay(50);
  assert.ok(authURL); assert.equal(authURL.protocol, 'https:');
  assert.ok(['auth.openai.com', 'chatgpt.com'].includes(authURL.hostname));
  await client.cancelSignIn(); await rejected;
  assert.equal((await client.readAccount()).connected, false);
  assert.equal(fs.existsSync(path.join(directory, 'auth.json')), false);
});
test('real Codex Q&A client sends no computer tools and targets only a local fixture provider', { timeout: 30000 }, async t => {
  let receive, timer;
  const received = new Promise(resolve => { receive = resolve; });
  const server = http.createServer((request, response) => {
    let body = ''; request.on('data', chunk => { body += chunk; }); request.on('end', () => {
      receive(JSON.parse(body)); response.writeHead(400, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'Fixture rejects generation.', type: 'invalid_request_error' } }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const client = new CodexConnection({ directory: fs.mkdtempSync(path.join(os.tmpdir(), 'opencluely-codex-tools-')), openExternal: () => {}, timeoutMs: 10000 });
  t.after(() => { clearTimeout(timer); client.stop(); server.close(); server.closeAllConnections(); });
  await client.start();
  const thread = await client.rpc('thread/start', { model: 'gpt-6.1-sol', modelProvider: 'fixture', cwd: client.workspace, ephemeral: true, sandbox: 'read-only', approvalPolicy: 'never',
    config: { 'model_providers.fixture': { name: 'Fixture', base_url: `http://127.0.0.1:${server.address().port}/v1`, wire_api: 'responses', requires_openai_auth: false, supports_websockets: false } } });
  await client.rpc('turn/start', { threadId: thread.thread.id, input: [{ type: 'text', text: 'Fixture question' }] });
  const request = await Promise.race([received, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('No fixture request')), 12000); })]);
  assert.deepEqual(request.tools || [], []); assert.equal(request.model, 'gpt-6.1-sol');
});
