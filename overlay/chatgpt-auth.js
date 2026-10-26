'use strict';

const http = require('node:http');
const { createHash, createPublicKey, randomBytes, randomUUID, timingSafeEqual, verify } = require('node:crypto');

const ISSUER = 'https://auth.openai.com';
const RESOURCE = 'https://api.openai.com/v1';
const AUTHORIZE = `${ISSUER}/api/accounts/authorize`;
const TOKEN = `${ISSUER}/api/accounts/oauth/token`;
const DISCOVERY = `${ISSUER}/.well-known/openid-configuration`;
const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const ACCOUNT_FILE = 'chatgpt-accounts.enc';
const HOST_FILE = 'chatgpt-host.json';
const REAUTH_CODES = new Set(['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused']);
const bounded = (value, length = 500) => typeof value === 'string' && value.length > 0 && value.length <= length;
const copy = value => structuredClone(value);

class ChatGPTAuthError extends Error {
  constructor(message, code = 'chatgpt_auth_failed') { super(message); this.name = 'ChatGPTAuthError'; this.code = code; }
}
function fail(message, code) { return new ChatGPTAuthError(message, code); }
function same(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aa = Buffer.from(a), bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}
function authURL(value) {
  try {
    const url = new URL(value);
    return url.origin === ISSUER && !url.username && !url.password && !url.hash && !url.search;
  } catch { return false; }
}
function scopes(value) {
  if (typeof value !== 'string' || value.length > 5000) throw fail('OpenAI returned invalid granted permissions.');
  return [...new Set(value.split(/\s+/).filter(Boolean))];
}
function timestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  if (typeof value === 'string') { const parsed = Date.parse(value); if (Number.isFinite(parsed)) return parsed; }
  return null;
}
function profileRecord(profile) {
  if (!profile || !bounded(profile.id, 100) || !bounded(profile.clientId, 300) || profile.clientId === 'dynamic_agent_client' ||
      profile.issuer !== ISSUER || !bounded(profile.subject, 1000)) return null;
  const result = {
    id: profile.id, clientId: profile.clientId, issuer: ISSUER, subject: profile.subject,
    email: typeof profile.email === 'string' ? profile.email.slice(0, 320) : '',
    name: typeof profile.name === 'string' ? profile.name.slice(0, 200) : '',
    label: typeof profile.label === 'string' ? profile.label.slice(0, 400) : 'ChatGPT account',
    preferences: profile.preferences && typeof profile.preferences === 'object' && !Array.isArray(profile.preferences) ? profile.preferences : {}
  };
  const tokens = profile.tokens;
  if (tokens && bounded(tokens.accessToken, 50000) && bounded(tokens.idToken, 50000) &&
      (tokens.refreshToken === null || bounded(tokens.refreshToken, 50000)) && Number.isFinite(tokens.expiresAt) &&
      Array.isArray(tokens.scopes) && tokens.scopes.length <= 100 && tokens.scopes.every(scope => bounded(scope, 200))) {
    result.tokens = { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, idToken: tokens.idToken,
      scopes: [...tokens.scopes], expiresAt: tokens.expiresAt,
      earliestRefreshAt: Number.isFinite(tokens.earliestRefreshAt) ? tokens.earliestRefreshAt : null };
  }
  return result;
}

// This module is main-process only. The renderer receives publicState(), never
// authorization URLs, raw provider errors, ID tokens or bearer credentials.
class ChatGPTAuth {
  constructor({ store, openExternal, onChange = () => {}, fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 5 * 60 * 1000 }) {
    if (!store || typeof openExternal !== 'function' || typeof fetchImpl !== 'function') throw new TypeError('ChatGPT authentication dependencies are required.');
    this.store = store; this.openExternal = openExternal; this.onChange = onChange; this.fetch = fetchImpl;
    this.now = now; this.timeoutMs = timeoutMs; this.pending = null; this.refreshes = new Map(); this.error = null;
    this.discovery = null; this.jwks = null; this.signingOut = new Set();
    this.registrationRetry = null;
    const saved = store.available() ? store.read(ACCOUNT_FILE, null, true) : null;
    this.profiles = saved?.version === 1 && Array.isArray(saved.profiles) ? saved.profiles.slice(0, 30).map(profileRecord).filter(Boolean) : [];
    // A duplicate local identifier is invalid rather than permission to combine accounts.
    if (new Set(this.profiles.map(profile => profile.id)).size !== this.profiles.length) this.profiles = [];
    this.activeProfileId = this.profiles.some(profile => profile.id === saved?.activeProfileId) ? saved.activeProfileId : null;
  }

  notify() { try { this.onChange(this.publicState()); } catch { /* UI observers cannot break credential lifecycle. */ } }
  active() { return this.profiles.find(profile => profile.id === this.activeProfileId); }
  sharing(profile = this.active()) { return !!profile?.tokens?.scopes.includes('chatgpt.tokens.use.direct'); }
  publicState() {
    const active = this.active();
    return {
      profiles: this.profiles.map(profile => ({ id: profile.id, label: profile.label, email: profile.email,
        sharing: this.sharing(profile), needsSignIn: !profile.tokens || (!profile.tokens.refreshToken && profile.tokens.expiresAt <= this.now()) })),
      activeProfileId: this.activeProfileId, connected: !!active?.tokens, sharing: this.sharing(active),
      busy: !!this.pending || this.signingOut.size > 0, error: this.error
    };
  }
  persist(profiles = this.profiles, activeProfileId = this.activeProfileId) {
    this.store.write(ACCOUNT_FILE, { version: 1, activeProfileId, profiles }, true);
    this.profiles = profiles; this.activeProfileId = activeProfileId;
  }
  requireStorage() {
    if (!this.store.available()) throw fail('Secure storage is unavailable. ChatGPT sign-in cannot save credentials on this device.', 'secure_storage_unavailable');
  }
  hostId() {
    const saved = this.store.read(HOST_FILE, null);
    if (typeof saved?.id === 'string' && /^urn:uuid:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(saved.id)) return saved.id;
    const id = `urn:uuid:${randomUUID()}`;
    this.store.write(HOST_FILE, { id });
    return id;
  }
  getProfilePreferences(profileId = this.activeProfileId) {
    return copy(this.profiles.find(profile => profile.id === profileId)?.preferences || {});
  }
  setProfilePreferences(patch, profileId = this.activeProfileId) {
    this.requireStorage();
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Buffer.byteLength(JSON.stringify(patch)) > 512000) throw fail('Invalid ChatGPT account preferences.');
    const profile = this.profiles.find(item => item.id === profileId);
    if (!profile) throw fail('Choose a saved ChatGPT account first.', 'chatgpt_not_connected');
    const next = { ...profile, preferences: { ...profile.preferences, ...copy(patch) } };
    // No notification: main can update the model cache without a state-update loop.
    this.persist(this.profiles.map(item => item === profile ? next : item));
    return copy(next.preferences);
  }
  async selectProfile(id) {
    if (this.pending || this.signingOut.size) throw fail('Finish or cancel the current ChatGPT account operation first.', 'chatgpt_auth_busy');
    if (!this.profiles.some(profile => profile.id === id)) throw fail('That ChatGPT account is no longer saved.');
    this.requireStorage(); this.persist(this.profiles, id); this.error = null; this.notify();
    return this.publicState();
  }

  async request(url, options = {}, signal) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) throw fail('ChatGPT sign-in was canceled.', 'chatgpt_auth_canceled');
    signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(abort, 15000);
    try {
      const response = await this.fetch(url, { ...options, redirect: 'error', signal: controller.signal });
      const body = await response.text();
      if (body.length > 1024 * 1024) throw fail('OpenAI returned an oversized authentication response.');
      let data = null;
      if (body) { try { data = JSON.parse(body); } catch { throw fail('OpenAI returned an unreadable authentication response.'); } }
      if (!response.ok) {
        const code = typeof data?.error === 'string' ? data.error : data?.error?.code;
        const safeCode = /^[a-z][a-z0-9_]{0,99}$/.test(code || '') ? code : 'chatgpt_auth_service_error';
        const error = fail(response.status === 429 ? 'ChatGPT sign-in is temporarily rate limited. Try again later.' :
          'OpenAI could not complete the account request. Try again or reconnect the account.', safeCode);
        error.status = response.status; throw error;
      }
      return data;
    } catch (error) {
      if (error instanceof ChatGPTAuthError) throw error;
      if (signal?.aborted) throw fail('ChatGPT sign-in was canceled.', 'chatgpt_auth_canceled');
      throw fail('Could not reach OpenAI. Check your connection and try again.', 'chatgpt_auth_network');
    } finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort); }
  }
  async metadata(signal) {
    if (this.discovery) return this.discovery;
    const metadata = await this.request(DISCOVERY, {}, signal);
    if (metadata?.issuer !== ISSUER || !authURL(metadata.jwks_uri) ||
        (metadata.revocation_endpoint && !authURL(metadata.revocation_endpoint))) throw fail('OpenAI returned invalid sign-in metadata.');
    this.discovery = metadata; return metadata;
  }
  async verifyIdentity(token, { clientId, nonce, subject, signal } = {}) {
    if (!bounded(token, 50000)) throw fail('OpenAI did not return a valid identity token.');
    const parts = token.split('.');
    if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) throw fail('OpenAI returned an invalid identity token.');
    let header, claims;
    try { header = JSON.parse(Buffer.from(parts[0], 'base64url')); claims = JSON.parse(Buffer.from(parts[1], 'base64url')); }
    catch { throw fail('OpenAI returned an invalid identity token.'); }
    if (!['RS256', 'ES256'].includes(header.alg) || !bounded(header.kid, 300) || header.crit) throw fail('The ChatGPT identity signature could not be verified.');
    const metadata = await this.metadata(signal);
    let keys = this.jwks;
    if (!keys || !keys.keys.some(key => key.kid === header.kid)) {
      keys = await this.request(metadata.jwks_uri, {}, signal);
      if (!Array.isArray(keys?.keys) || keys.keys.length > 100) throw fail('OpenAI returned invalid identity signing keys.');
      this.jwks = keys;
    }
    const candidates = keys.keys.filter(key => key.kid === header.kid && (!key.use || key.use === 'sig') &&
      (!key.key_ops || (Array.isArray(key.key_ops) && key.key_ops.includes('verify'))) && (!key.alg || key.alg === header.alg));
    if (candidates.length !== 1 || (header.alg === 'RS256' && candidates[0].kty !== 'RSA') || (header.alg === 'ES256' && (candidates[0].kty !== 'EC' || candidates[0].crv !== 'P-256'))) throw fail('The ChatGPT identity signature could not be verified.');
    let verified = false;
    try {
      const key = createPublicKey({ key: candidates[0], format: 'jwk' });
      verified = verify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`),
        header.alg === 'ES256' ? { key, dsaEncoding: 'ieee-p1363' } : key, Buffer.from(parts[2], 'base64url'));
    } catch { /* Fail closed on malformed keys/signatures. */ }
    const now = this.now() / 1000;
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!verified || claims.iss !== ISSUER || !audience.includes(clientId) ||
        ((audience.length > 1 || claims.azp !== undefined) && claims.azp !== clientId) ||
        !Number.isFinite(claims.exp) || claims.exp <= now || (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > now + 30)) ||
        !Number.isFinite(claims.iat) || claims.iat > now + 30 ||
        !bounded(claims.sub, 1000) || (nonce !== undefined && !same(claims.nonce, nonce)) ||
        (subject !== undefined && !same(claims.sub, subject))) throw fail('The returned ChatGPT identity did not match this sign-in attempt.', 'chatgpt_identity_invalid');
    return { issuer: ISSUER, subject: claims.sub, email: typeof claims.email === 'string' ? claims.email.slice(0, 320) : '',
      name: typeof claims.name === 'string' ? claims.name.slice(0, 200) : '' };
  }
  tokenSet(data, previous, identityToken) {
    if (!data || !bounded(data.access_token, 50000) || typeof data.token_type !== 'string' || data.token_type.toLowerCase() !== 'bearer' ||
        !Number.isFinite(data.expires_in) || data.expires_in <= 0 || data.expires_in > 7 * 24 * 3600 ||
        (data.refresh_token !== undefined && !bounded(data.refresh_token, 50000))) throw fail('OpenAI returned an invalid credential set.');
    const granted = data.scope === undefined && previous ? [...previous.scopes] : scopes(data.scope);
    const refreshToken = data.refresh_token || null;
    // Rotating credentials must be saved as one complete set. Never continue a
    // successful refresh with the old refresh token if its replacement is absent.
    if ((previous?.refreshToken || granted.includes('offline_access')) && !refreshToken) throw fail('OpenAI did not return the renewable session credentials. Reconnect ChatGPT.', 'chatgpt_refresh_incomplete');
    return { accessToken: data.access_token, refreshToken, idToken: identityToken,
      scopes: granted, expiresAt: this.now() + data.expires_in * 1000, earliestRefreshAt: timestamp(data.earliest_refresh_at) };
  }

  async signIn(options = {}) {
    this.requireStorage();
    if (this.pending || this.signingOut.size) throw fail('A ChatGPT sign-in is already running. Finish or cancel it first.', 'chatgpt_auth_busy');
    if (!options || typeof options !== 'object') throw fail('Invalid ChatGPT sign-in options.');
    const selectedId = options.newProfile ? null : options.profileId || this.activeProfileId;
    const existing = selectedId ? this.profiles.find(profile => profile.id === selectedId) : null;
    const requestedClient = existing?.clientId || (!existing && this.registrationRetry?.clientId) || null;
    if (selectedId && !existing) throw fail('That ChatGPT account is no longer saved.');
    if (!existing && this.profiles.length >= 30) throw fail('Too many saved ChatGPT accounts.');
    const hostId = this.hostId();
    const attempt = { state: randomBytes(32).toString('base64url'), nonce: randomBytes(32).toString('base64url'),
      verifier: randomBytes(64).toString('base64url'), controller: new AbortController(), server: null, timer: null, settled: false, processing: false };
    this.pending = attempt; this.error = null; this.notify();
    return new Promise((resolve, reject) => {
      const finish = (error, result) => {
        if (attempt.settled) return;
        attempt.settled = true; clearTimeout(attempt.timer); attempt.controller.abort();
        attempt.server?.close(); attempt.server?.closeIdleConnections?.();
        if (this.pending === attempt) this.pending = null;
        this.error = error ? error.message : null; this.notify();
        if (error) reject(error); else resolve(result || this.publicState());
      };
      attempt.finish = finish;
      const reply = (response, status, text) => {
        response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'", 'Connection': 'close', 'X-Content-Type-Options': 'nosniff' });
        response.end(text);
      };
      const server = http.createServer((request, response) => {
        let callback;
        try { callback = new URL(request.url, attempt.redirectURI); } catch { reply(response, 400, 'Invalid sign-in callback.'); return; }
        if (request.method !== 'GET' || callback.origin !== new URL(attempt.redirectURI).origin || callback.pathname !== '/auth/callback' || request.headers.host !== new URL(attempt.redirectURI).host || request.socket.remoteAddress !== '127.0.0.1') { reply(response, 404, 'Not found.'); return; }
        if (attempt.settled || this.pending !== attempt || attempt.processing) { reply(response, 409, 'This sign-in callback has already been used.'); return; }
        const parameters = callback.searchParams;
        if (['state', 'code', 'client_id', 'error'].some(key => parameters.getAll(key).length > 1) || !same(parameters.get('state'), attempt.state)) { reply(response, 400, 'This callback does not match the pending sign-in.'); return; }
        if (parameters.has('error')) {
          reply(response, 400, 'ChatGPT sign-in was not completed. You can return to OpenCluely.');
          finish(fail(parameters.get('error') === 'access_denied' ? 'ChatGPT sign-in was canceled or permission was declined.' : 'ChatGPT sign-in was not completed.', 'chatgpt_auth_canceled')); return;
        }
        const code = parameters.get('code'), returnedClient = parameters.get('client_id');
        const clientId = requestedClient || returnedClient;
        if (!bounded(code, 10000) || !bounded(clientId, 300) || clientId === 'dynamic_agent_client' || !/^[A-Za-z0-9_-]+$/.test(clientId) ||
            (requestedClient && returnedClient !== null && returnedClient !== requestedClient)) { reply(response, 400, 'The client registration did not match this sign-in.'); finish(fail('ChatGPT registration was incomplete or did not match the selected account.', 'chatgpt_client_invalid')); return; }
        attempt.processing = true;
        reply(response, 200, 'Finishing ChatGPT sign-in. You can return to OpenCluely.');
        void (async () => {
          try {
            let data;
            try {
              data = await this.request(TOKEN, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: attempt.verifier, redirect_uri: attempt.redirectURI, resource: RESOURCE }).toString() }, attempt.controller.signal);
            } catch (error) {
              if (error.code === 'invalid_grant' && !attempt.settled && this.pending === attempt) {
                // Keep an issued registration for a fresh code/PKCE attempt,
                // without treating its unverified identity as a saved account.
                if (!existing) this.registrationRetry = { clientId };
                throw fail('The ChatGPT sign-in code expired or was already used. Continue with ChatGPT again to retry.', 'invalid_grant');
              }
              throw error;
            }
            const identity = await this.verifyIdentity(data?.id_token, { clientId, nonce: attempt.nonce, subject: existing?.subject, signal: attempt.controller.signal });
            const tokens = this.tokenSet(data, null, data.id_token);
            if (attempt.settled || this.pending !== attempt || attempt.controller.signal.aborted) return;
            if (!existing && this.profiles.some(profile => profile.clientId === clientId)) throw fail('This client registration is already saved. Choose its existing ChatGPT account.', 'chatgpt_client_invalid');
            const id = existing?.id || randomUUID();
            const label = existing?.label || `${identity.email || identity.name || 'ChatGPT account'} · Connection ${this.profiles.length + 1}`;
            const profile = { id, clientId, ...identity, label, tokens, preferences: existing?.preferences || {} };
            this.persist(existing ? this.profiles.map(item => item.id === existing.id ? profile : item) : [...this.profiles, profile], id);
            if (!existing) this.registrationRetry = null;
            finish(null);
          } catch (error) { finish(error instanceof ChatGPTAuthError ? error : fail('ChatGPT sign-in could not be saved securely. Please try again.')); }
        })();
      });
      server.requestTimeout = 10000; server.headersTimeout = 10000;
      attempt.server = server;
      server.on('error', () => finish(fail('OpenCluely could not open the local ChatGPT callback listener. Try again.', 'chatgpt_callback_unavailable')));
      attempt.timer = setTimeout(() => finish(fail('ChatGPT sign-in timed out. Please try again.', 'chatgpt_auth_timeout')), this.timeoutMs);
      server.listen(0, '127.0.0.1', () => {
        if (attempt.settled || this.pending !== attempt) { server.close(); return; }
        const port = server.address().port;
        attempt.redirectURI = `http://127.0.0.1:${port}/auth/callback`;
        const url = new URL(AUTHORIZE);
        const parameters = { client_id: requestedClient || 'dynamic_agent_client', ext_agent_host_id: hostId, response_type: 'code',
          redirect_uri: attempt.redirectURI, scope: SCOPES, resource: RESOURCE, state: attempt.state, nonce: attempt.nonce,
          code_challenge_method: 'S256', code_challenge: createHash('sha256').update(attempt.verifier).digest('base64url') };
        if (!requestedClient) parameters.agent_name_hint = 'OpenCluely Overlay';
        if (existing?.tokens?.idToken) parameters.id_token_hint = existing.tokens.idToken;
        if (existing?.email) parameters.login_hint = existing.email;
        if (options.consent === true) parameters.prompt = 'consent';
        for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
        Promise.resolve().then(() => this.openExternal(url.href)).catch(() => finish(fail('OpenCluely could not open your browser for ChatGPT sign-in. Try again.', 'chatgpt_browser_unavailable')));
      });
    });
  }
  cancelSignIn() {
    this.registrationRetry = null;
    if (this.pending) this.pending.finish(fail('ChatGPT sign-in was canceled.', 'chatgpt_auth_canceled'));
    return this.publicState();
  }

  async refresh(profile) {
    const tokens = profile.tokens;
    let exchanged = false;
    try {
      const data = await this.request(TOKEN, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', client_id: profile.clientId, refresh_token: tokens.refreshToken, resource: RESOURCE }).toString() });
      exchanged = true;
      if (data?.id_token !== undefined) await this.verifyIdentity(data.id_token, { clientId: profile.clientId, subject: profile.subject });
      const nextTokens = this.tokenSet(data, tokens, data.id_token || tokens.idToken);
      const current = this.profiles.find(item => item.id === profile.id);
      if (!current || current.tokens !== tokens) throw fail('The ChatGPT session changed while renewing it. Try again.', 'chatgpt_session_changed');
      const next = { ...current, tokens: nextTokens };
      this.persist(this.profiles.map(item => item === current ? next : item)); this.error = null; this.notify();
      if (!this.sharing(next)) throw fail('Enable ChatGPT plan usage for this connection in Settings.', 'chatgpt_plan_usage_disabled');
      return nextTokens.accessToken;
    } catch (error) {
      const current = this.profiles.find(item => item.id === profile.id);
      if ((REAUTH_CODES.has(error.code) || exchanged) && current?.tokens === tokens) {
        const next = { ...current }; delete next.tokens;
        const profiles = this.profiles.map(item => item === current ? next : item);
        let saved = true;
        try { this.persist(profiles); } catch { saved = false; this.profiles = profiles; }
        this.error = saved ? 'Your ChatGPT session ended or could not be renewed safely. Sign in again to reconnect.' :
          'ChatGPT credentials could not be saved securely. This session has been disconnected; resolve the storage problem and sign in again.';
        this.notify();
        throw fail(this.error, saved ? 'chatgpt_reconnect_required' : 'chatgpt_refresh_storage_failed');
      }
      throw error instanceof ChatGPTAuthError ? error : fail('The renewed ChatGPT session could not be saved securely. Reconnect ChatGPT.', 'chatgpt_refresh_storage_failed');
    }
  }
  async accessToken({ signal } = {}) {
    if (signal?.aborted) throw fail('The ChatGPT request was canceled.', 'chatgpt_request_canceled');
    const profile = this.active();
    if (!profile?.tokens || this.signingOut.has(profile.id)) throw fail('Sign in to ChatGPT before asking a question.', 'chatgpt_not_connected');
    if (!this.sharing(profile)) throw fail('Enable ChatGPT plan usage for this connection in Settings.', 'chatgpt_plan_usage_disabled');
    const tokens = profile.tokens;
    if (tokens.expiresAt > this.now() + 60000 || (tokens.expiresAt > this.now() && tokens.earliestRefreshAt > this.now())) return tokens.accessToken;
    if (!tokens.refreshToken) {
      if (tokens.expiresAt > this.now()) return tokens.accessToken;
      throw fail('Your ChatGPT session expired. Sign in again.', 'chatgpt_reconnect_required');
    }
    if (tokens.earliestRefreshAt > this.now()) throw fail('ChatGPT renewal is not available yet. Wait briefly and try again.', 'chatgpt_refresh_too_early');
    let refresh = this.refreshes.get(profile.id);
    if (!refresh) {
      refresh = this.refresh(profile).finally(() => { if (this.refreshes.get(profile.id) === refresh) this.refreshes.delete(profile.id); });
      this.refreshes.set(profile.id, refresh);
    }
    if (!signal) return refresh;
    return new Promise((resolve, reject) => {
      const abort = () => { cleanup(); reject(fail('The ChatGPT request was canceled.', 'chatgpt_request_canceled')); };
      const cleanup = () => signal.removeEventListener('abort', abort);
      signal.addEventListener('abort', abort, { once: true });
      refresh.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    });
  }
  async signOut(id = this.activeProfileId) {
    if (this.pending) this.cancelSignIn();
    const profile = this.profiles.find(item => item.id === id);
    if (!profile) throw fail('Choose a saved ChatGPT account first.');
    if (this.signingOut.has(id)) throw fail('This ChatGPT account is already signing out.', 'chatgpt_auth_busy');
    this.requireStorage(); this.signingOut.add(id); this.notify();
    let revoked = !profile.tokens;
    try {
      // A refresh may already be rotating the token. Wait for that one operation
      // before choosing which replacement token to revoke. New token consumers
      // are blocked by signingOut, and the local credentials are then cleared.
      const pendingRefresh = this.refreshes.get(id);
      if (pendingRefresh) { try { await pendingRefresh; } catch { /* Local sign-out still proceeds. */ } }
      const current = this.profiles.find(item => item.id === id);
      const token = current?.tokens?.refreshToken || profile.tokens?.refreshToken;
      if (token) {
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const metadata = await this.metadata();
            if (!metadata.revocation_endpoint) break;
            await this.request(metadata.revocation_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams({ token, token_type_hint: 'refresh_token', client_id: profile.clientId }).toString() });
            revoked = true; break;
          } catch (error) {
            if (attempt > 0 || (error.status && error.status < 500)) break;
            await new Promise(resolve => setTimeout(resolve, 250));
          }
        }
      }
      const latest = this.profiles.find(item => item.id === id);
      const signedOut = { ...latest }; delete signedOut.tokens;
      const profiles = this.profiles.map(item => item.id === id ? signedOut : item);
      try { this.persist(profiles); }
      catch {
        // A successfully revoked credential must never become usable again just
        // because the disk refused the write. Other registrations stay intact.
        this.profiles = profiles;
        this.error = 'Signed out for this session, but saved credentials could not be removed. Resolve the storage problem before reopening OpenCluely; disconnect the app in ChatGPT Settings if remote revocation was not confirmed.';
        throw fail(this.error, 'chatgpt_signout_storage_failed');
      }
      this.error = revoked ? null : 'Signed out on this device. Remote revocation was not confirmed; disconnect OpenCluely in ChatGPT Settings if needed.';
      return { revoked, warning: this.error };
    } finally { this.signingOut.delete(id); this.notify(); }
  }
}

module.exports = { ChatGPTAuth, ChatGPTAuthError, ACCOUNT_FILE, HOST_FILE };
