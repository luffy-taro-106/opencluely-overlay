# ChatGPT account connection

OpenCluely 2.5.0 incorporates upstream commit `723ad56` and adds two separate account connections alongside **OpenAI API key**, Claude and Gemini.

| Connection | Login and models | Credential storage |
| --- | --- | --- |
| ChatGPT account | OpenCluely's own Sign in with ChatGPT registration; direct public Responses endpoint and the selected connection's `/v1/models` catalog | App-encrypted `chatgpt-accounts.enc` |
| Codex account | Official pinned Codex client 0.164.0, managed browser login, `model/list` and app-server streaming | OS credential store, isolated under this app's `codex-profile` namespace |
| OpenAI API key | Existing API-key flow and its API organization/project catalog | Existing encrypted `credentials.enc` |

The regular ChatGPT website, ChatGPT plan usage in another app, Codex, and API billing do not guarantee identical model access. Each picker uses its connection's returned models; the website's complete Chat picker is not promised. Credentials stay in this app's protected local storage or its isolated OS credential-store namespace, without third-party token synchronization.

## Connect Codex

Choose **Codex account** in Settings, then **Sign in to Codex with ChatGPT**. Complete the browser flow and return to choose a Codex model. The client manages refresh and OS credential storage. Cancel sign-in and Sign out are available. Signing out stops an active Codex answer and clears this connection's cached models and effort choices. Its account is separate from the ChatGPT-plan connection and from the user's Codex desktop/CLI session. The client is included in the installer; no separate CLI installation is required.

Codex questions use ephemeral in-memory threads and the overlay's bounded conversation context, including attached images. Shell execution, multi-agent tools and web search are disabled; the connection is for answering supplied questions. A native test inspects the request to a local fixture endpoint and verifies that no computer tools are sent. Cancellation interrupts the current turn. The app stops its owned client on Quit. Codex model/list may use its own cached catalog; a displayed model is not a guarantee of account entitlement or successful inference.

## Connect ChatGPT plan usage

1. Open Settings and choose **ChatGPT account**.
2. Click **Continue with ChatGPT**. Complete account/workspace selection and permission to use your plan in your system browser.
3. Return to OpenCluely. Choose a model from your connection's refreshed model list, then ask a question.

Account sign-in and permission to use a ChatGPT plan are separate. A connected account without that permission can use **Enable ChatGPT plan usage**. Eligibility, workspace policy, model access and usage limits still apply. **Manage usage** opens ChatGPT's usage settings. OpenCluely never switches a ChatGPT request to API-key billing.

Use **Add account / workspace** for another registration and the account picker to switch saved connections. Each registration remembers its model, reasoning preferences and cached catalog separately. **Reconnect with ChatGPT** reuses the selected registration. **Cancel sign-in** closes the pending callback listener. **Sign out** stops any answer using that account, attempts remote session revocation, and clears its local tokens while retaining its account mapping for later reconnection. If remote revocation cannot be confirmed, the interface says so; access can also be disconnected in ChatGPT Settings.

Models are discovered from the selected OAuth connection, preserving the server's display order. API-key catalogs and the ChatGPT website model picker are separate. Reasoning controls use declared capabilities; unknown reasoning options use Auto. If a catalog does not declare image capability, an explicitly requested image question can be attempted; the server may reject an unsupported input.

## Credential handling

The Electron main process owns the browser flow, token renewal and network requests. The renderer sees account display information and connection status, never access, refresh or ID tokens. No other application's login/token store is read.

- `chatgpt-host.json`: stable opaque installation ID; contains no credential.
- `chatgpt-accounts.enc`: encrypted registration identities, rotating token sets and per-connection preferences using the app's existing Windows protected storage.
- Existing `credentials.enc`: independent provider API keys, unchanged by ChatGPT sign-out.

The loopback listener binds `127.0.0.1` on an available port before opening the browser. Every attempt uses fresh state, nonce and PKCE. The issued app client ID is retained with the verified identity. Signature, issuer, audience, expiration, nonce and returning account identity are checked before credentials become active. Refreshes are serialized and persisted atomically. Network failures do not erase an otherwise valid saved connection.

OAuth inference sends `store:false`, `stream:true` and explicit context to `https://api.openai.com/v1/responses`; unsupported API-key fields are omitted. An answer is complete only after `response.completed`. Terminal failures, quota errors and interrupted streams do not trigger automatic duplicate generation or another billing connection.

## Validation

`npm test` includes isolated callback/JWT/refresh/revocation fixtures, model-schema tests and mocked Responses streams. `npm run test:desktop` exercises the sandboxed renderer and main-process bridge with isolated profiles and mock connections. Real sign-in and plan inference require the owner's browser consent; automated fixtures do not establish an account's eligibility or quota.

The Windows native Codex checks initialize the actual bundled binary with fresh profiles, exercise managed login URL creation and cancellation without browser consent, and inspect a question request against a local mock server. They do not consume a real ChatGPT plan. Text/image routing for both account choices, model selection, sign-out during an answer, saved API-key restoration and owner-confirmed Quit are covered by desktop checks.

## Official references

- [Registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [Accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)
- [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [Errors and recovery](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery)
- [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
- [Codex app-server authentication, models and turns](https://learn.chatgpt.com/docs/app-server)
- [Codex OS credential storage](https://learn.chatgpt.com/docs/auth)

Implementation checked against these documents on 26 October 2026. This feature does not promise access to every ChatGPT or API model.
