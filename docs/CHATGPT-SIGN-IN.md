# ChatGPT account connection

OpenCluely 2.4 adds **ChatGPT account** alongside the separate **OpenAI API key**, Claude and Gemini connections. This local open-source integration uses OpenAI's documented Sign in with ChatGPT flow and public Responses endpoint.

## Connect

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

## Official references

- [Registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [Accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)
- [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [Errors and recovery](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery)
- [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)

Implementation checked against these documents on 26 October 2026. This feature does not promise access to every ChatGPT or API model.
