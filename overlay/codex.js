'use strict';

const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { StringDecoder } = require('node:string_decoder');
const fs = require('node:fs');
const path = require('node:path');
const { normalizeModels } = require('./models');
const { SYSTEM } = require('./providers');

const safeError = (code = 'codex_unavailable') => Object.assign(new Error({
  codex_unavailable: 'The Codex connection stopped. Reconnect or refresh its models in Settings.',
  codex_timeout: 'Codex did not respond in time. Check your connection and try again.',
  codex_login_failed: 'Codex sign-in was not completed. Try again in Settings.',
  codex_canceled: 'Codex sign-in was canceled.',
  codex_request_failed: 'Codex could not complete this request. Check account access, usage and the selected model in Settings.',
  codex_tool_unavailable: 'This overlay answers supplied text and images. The requested Codex tool is unavailable.'
}[code] || 'Codex could not complete this operation.'), { code });

function binaryPath() {
  const targets = { 'win32-x64': 'x86_64-pc-windows-msvc', 'win32-arm64': 'aarch64-pc-windows-msvc',
    'darwin-x64': 'x86_64-apple-darwin', 'darwin-arm64': 'aarch64-apple-darwin',
    'linux-x64': 'x86_64-unknown-linux-musl', 'linux-arm64': 'aarch64-unknown-linux-musl' };
  const platform = `${process.platform}-${process.arch}`, target = targets[platform];
  if (!target) throw safeError();
  let filename = path.join(path.dirname(require.resolve(`@openai/codex-${platform}/package.json`)), 'vendor', target, 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex');
  filename = filename.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
  if (!fs.existsSync(filename)) throw safeError();
  return filename;
}
function childEnvironment(home) {
  // Use this app's separate credential namespace. Never inherit another
  // client's CODEX_HOME, bearer tokens, API keys or model-provider overrides.
  const allowed = new Set(['systemroot', 'windir', 'systemdrive', 'comspec', 'userprofile', 'home', 'path', 'pathext',
    'appdata', 'localappdata', 'programdata', 'temp', 'tmp', 'tmpdir', 'lang', 'lc_all', 'https_proxy', 'http_proxy', 'no_proxy']);
  return { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key.toLowerCase()))), CODEX_HOME: home };
}
function serverArgs() {
  const config = ['cli_auth_credentials_store="keyring"', 'forced_login_method="chatgpt"',
    'features.shell_tool=false', 'features.unified_exec=false', 'features.multi_agent=false',
    'features.memories=false', 'web_search="disabled"', 'history.persistence="none"',
    'analytics.enabled=false', 'project_doc_max_bytes=0', 'check_for_update_on_startup=false'];
  return ['app-server', '--listen', 'stdio://', ...config.flatMap(value => ['-c', value])];
}
function questionInput(messages) {
  const input = [];
  messages.forEach((message, index) => {
    input.push({ type: 'text', text: index === messages.length - 1 ? message.text || 'Please answer the attached image question.'
      : `Previous ${message.role} message (quoted conversation context):\n${message.text || ''}` });
    if (message.role === 'user') for (const image of message.images || (message.image ? [message.image] : []))
      input.push({ type: 'image', url: `data:${image.mime};base64,${image.data}` });
  });
  return input;
}

// Official Codex app-server owns its browser login, OS credential-store
// persistence and refresh. No credential ever enters this module or the UI.
class CodexConnection extends EventEmitter {
  constructor({ directory, openExternal, onChange = () => {}, spawnImpl = spawn, resolveBinary = binaryPath, version = '2.5.0', timeoutMs = 30000, loginTimeoutMs = 300000 }) {
    super();
    this.directory = directory; this.workspace = path.join(directory, 'questions');
    this.openExternal = openExternal; this.onChange = onChange; this.spawn = spawnImpl; this.resolveBinary = resolveBinary;
    this.version = version; this.timeoutMs = timeoutMs; this.loginTimeoutMs = loginTimeoutMs;
    this.child = null; this.ready = null; this.pending = new Map(); this.sequence = 0;
    this.account = null; this.login = null; this.operation = false; this.error = null; this.activeTurn = null;
  }
  publicState() {
    return { connected: this.account?.type === 'chatgpt', email: this.account?.email || '', planType: this.account?.planType || '',
      busy: !!this.login || this.operation, signingIn: !!this.login, error: this.error };
  }
  notify() { try { this.onChange(this.publicState()); } catch { /* An observer cannot break the client. */ } }
  send(value) {
    if (!this.child || this.child.stdin.destroyed) throw safeError();
    this.child.stdin.write(JSON.stringify(value) + '\n');
  }
  rpc(method, params = {}, timeoutMs = this.timeoutMs) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(safeError('codex_timeout')); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); }
      catch { clearTimeout(timer); this.pending.delete(id); reject(safeError()); }
    });
  }
  message(value) {
    if (!value || typeof value !== 'object') return;
    if (value.id !== undefined && !value.method) {
      const pending = this.pending.get(value.id);
      if (!pending) return;
      this.pending.delete(value.id); clearTimeout(pending.timer);
      if (value.error) pending.reject(safeError('codex_request_failed')); else pending.resolve(value.result);
      return;
    }
    if (value.id !== undefined && value.method) {
      // This Q&A connection never approves commands, file changes or tools.
      if (/requestApproval$/.test(value.method)) this.send({ id: value.id, result: { decision: 'decline' } });
      else this.send({ id: value.id, error: { code: -32601, message: 'Tool unavailable in this overlay.' } });
      this.emit('tool-denied'); return;
    }
    const params = value.params || {};
    if (value.method === 'account/login/completed' && this.login) {
      this.login.completion = params;
      if (this.login.id && params.loginId === this.login.id) void this.completeLogin();
    }
    if (value.method === 'account/updated') {
      if (!params.authMode) { this.account = null; this.notify(); }
    }
    this.emit('notification', value.method, params);
  }
  start() {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      fs.mkdirSync(this.workspace, { recursive: true, mode: 0o700 });
      const child = this.spawn(this.resolveBinary(), serverArgs(), { cwd: this.workspace, env: childEnvironment(this.directory),
        windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      this.child = child;
      let buffer = ''; const decoder = new StringDecoder('utf8');
      const closed = () => {
        if (this.child !== child) return;
        this.child = null; this.ready = null;
        for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(safeError()); }
        this.pending.clear();
        this.login?.finish(safeError());
        this.emit('disconnected');
      };
      child.once('error', closed); child.once('close', closed);
      child.stdin.on('error', () => {});
      child.stdout.on('data', data => {
        buffer += decoder.write(data);
        if (buffer.length > 16 * 1024 * 1024) { child.kill(); return; }
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
          if (!line.trim()) continue;
          try { this.message(JSON.parse(line)); } catch { child.kill(); return; }
        }
      });
      // stderr may contain account/request information. Drain without logging.
      child.stderr.on('data', () => {});
      await this.rpc('initialize', { clientInfo: { name: 'opencluely_overlay', title: 'OpenCluely Overlay', version: this.version } });
      this.send({ method: 'initialized', params: {} });
    })().catch(error => { this.stop(); throw error instanceof Error ? error : safeError(); });
    return this.ready;
  }
  async readAccount() {
    await this.start();
    const result = await this.rpc('account/read', { refreshToken: false });
    const account = result?.account;
    this.account = account?.type === 'chatgpt' ? { type: 'chatgpt', email: typeof account.email === 'string' ? account.email.slice(0, 320) : '',
      planType: typeof account.planType === 'string' ? account.planType.slice(0, 80) : '' } : null;
    this.notify(); return this.publicState();
  }
  async signIn() {
    if (this.login || this.operation) throw new Error('Finish or cancel the current Codex account operation first.');
    await this.start();
    if (this.login || this.operation) throw new Error('A Codex sign-in is already running.');
    let resolve, reject;
    const done = new Promise((yes, no) => { resolve = yes; reject = no; });
    // Attach a rejection handler while the initial RPC/browser request is pending.
    done.catch(() => {});
    const login = { id: null, completion: null, finishing: false, finish: (error) => {
      if (this.login !== login) return;
      clearTimeout(login.timer); this.login = null; this.error = error?.message || null; this.notify();
      if (error) reject(error); else resolve(this.publicState());
    } };
    this.login = login; this.error = null; this.notify();
    login.timer = setTimeout(() => { void this.cancelSignIn(safeError('codex_timeout')); }, this.loginTimeoutMs);
    try {
      const result = await this.rpc('account/login/start', { type: 'chatgpt', appBrand: 'codex', useHostedLoginSuccessPage: true });
      if (this.login !== login) { if (result?.loginId) await this.rpc('account/login/cancel', { loginId: result.loginId }); return done; }
      if (result?.type !== 'chatgpt' || typeof result.loginId !== 'string') throw safeError('codex_login_failed');
      const url = new URL(result.authUrl);
      if (url.protocol !== 'https:' || !['auth.openai.com', 'chatgpt.com'].includes(url.hostname) || url.username || url.password || url.port) throw safeError('codex_login_failed');
      login.id = result.loginId;
      await this.openExternal(url.href);
      if (login.completion?.loginId === login.id) void this.completeLogin();
    } catch { login.finish(safeError('codex_login_failed')); }
    return done;
  }
  async completeLogin() {
    const login = this.login;
    if (!login || login.finishing) return;
    login.finishing = true;
    try {
      if (login.completion?.success !== true) throw safeError('codex_login_failed');
      await this.readAccount();
      if (!this.publicState().connected) throw safeError('codex_login_failed');
      login.finish();
    } catch { login.finish(safeError('codex_login_failed')); }
  }
  async cancelSignIn(error = safeError('codex_canceled')) {
    const login = this.login;
    if (!login) return;
    login.finish(error);
    if (login.id) { try { await this.rpc('account/login/cancel', { loginId: login.id }, 8000); } catch { this.stop(); } }
  }
  async signOut() {
    await this.cancelSignIn();
    if (this.operation) throw new Error('Wait for the current Codex operation.');
    this.operation = true; this.notify();
    try {
      await this.start(); await this.rpc('account/logout');
      this.account = null; this.error = null; return this.publicState();
    } catch { this.error = 'Codex sign-out could not be confirmed. Try again before closing the app.'; throw new Error(this.error); }
    finally { this.operation = false; this.notify(); }
  }
  async listModels() {
    await this.readAccount();
    if (!this.publicState().connected) throw new Error('Sign in to the Codex connection in Settings first.');
    const items = []; let cursor = null;
    for (let page = 0; page < 30; page++) {
      const result = await this.rpc('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(result?.data) || items.length + result.data.length > 10000) throw safeError();
      items.push(...result.data);
      if (!result.nextCursor) return { models: normalizeModels('codex', items), total: items.length, checkedAt: new Date().toISOString() };
      if (typeof result.nextCursor !== 'string' || result.nextCursor === cursor) throw safeError();
      cursor = result.nextCursor;
    }
    throw safeError();
  }
  async answer({ model, messages, reasoningEffort = 'auto', signal, onDelta, onStatus = () => {} }) {
    if (this.activeTurn) throw new Error('A Codex answer is already running.');
    await this.start(); signal.throwIfAborted();
    if (!this.publicState().connected) throw new Error('Sign in to the Codex connection first.');
    let threadId = null, turnId = null, text = '', settle;
    const items = new Map();
    const done = new Promise((resolve, reject) => { settle = (error) => error ? reject(error) : resolve({ text, truncated: false }); });
    done.catch(() => {});
    const abort = () => {
      if (threadId && turnId) void this.rpc('turn/interrupt', { threadId, turnId }, 8000).catch(() => this.stop());
      else this.stop();
      settle(new Error('Answer stopped.'));
    };
    const disconnected = () => settle(safeError());
    const denied = () => settle(safeError('codex_tool_unavailable'));
    const notify = (method, value) => {
      if (!threadId || value.threadId !== threadId) return;
      if (method === 'item/agentMessage/delta' && typeof value.delta === 'string') {
        const id = value.itemId || 'message';
        const separator = !items.has(id) && text ? '\n\n' : '';
        items.set(id, (items.get(id) || '') + value.delta);
        text += separator + value.delta;
        if (text.length > 80000) { abort(); return; }
        onDelta(separator + value.delta);
      }
      if (method === 'item/completed' && value.item?.type === 'agentMessage' && typeof value.item.text === 'string') {
        items.set(value.item.id, value.item.text);
      }
      if (method === 'turn/completed') {
        text = [...items.values()].join('\n\n');
        if (value.turn?.status !== 'completed' || !text.trim() || text.length > 80000) settle(safeError('codex_request_failed'));
        else settle();
      }
    };
    this.activeTurn = { abort }; this.on('notification', notify); this.on('disconnected', disconnected); this.on('tool-denied', denied);
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, 10 * 60 * 1000);
    try {
      onStatus('Connecting to Codex…');
      const started = await this.rpc('thread/start', { model, cwd: this.workspace, ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only',
        baseInstructions: SYSTEM + ' Answer directly using only the supplied question, images and quoted context. Do not run tools, read local files, or change anything on the computer.' });
      signal.throwIfAborted(); threadId = started?.thread?.id;
      if (typeof threadId !== 'string') throw safeError();
      const turn = await this.rpc('turn/start', { threadId, input: questionInput(messages), ...(reasoningEffort === 'auto' ? {} : { effort: reasoningEffort }) });
      turnId = turn?.turn?.id; signal.throwIfAborted();
      onStatus('Codex is answering…');
      return await done;
    } finally {
      clearTimeout(timer); signal.removeEventListener('abort', abort);
      this.off('notification', notify); this.off('disconnected', disconnected); this.off('tool-denied', denied); this.activeTurn = null;
      if (threadId && this.child) void this.rpc('thread/unsubscribe', { threadId }, 8000).catch(() => {});
    }
  }
  stop() {
    const child = this.child;
    if (!child) { this.ready = null; return; }
    child.kill();
    this.child = null; this.ready = null;
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(safeError()); }
    this.pending.clear(); this.login?.finish(safeError()); this.emit('disconnected');
  }
}

module.exports = { CodexConnection, binaryPath, childEnvironment, serverArgs, questionInput };
