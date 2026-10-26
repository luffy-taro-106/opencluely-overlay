# Account models and reasoning effort

OpenCluely 2.3.6 refreshes each configured provider's model catalog on launch and after saving a replacement key. In Settings, **Refresh models / check key** repeats the authenticated catalog request for that provider. This check does not generate an answer or test billing. API access, the model count, refresh time, and connection errors appear beside the model selector. A failed refresh retains the previous list; a successful list is cached for offline use. Replacing or removing a key discards that provider's old catalog.

The dropdown includes chat models compatible with the app's generation endpoints, including dated snapshots that remain available. It excludes already retired models and models requiring speech, image generation, embedding, agent, or other specialized workflows. A catalog entry does not guarantee account billing, quota, or model capacity at generation time. Custom model IDs remain available.

The main window and Settings both have a reasoning effort selector. Choices are saved independently for each provider and model. **Auto** omits the effort override and uses the provider's default. Unsupported choices are excluded and rejected before sending. Text-only models are marked and reject image attachments locally.

OpenAI uses `reasoning.effort`. Claude's live capability flags determine its supported levels and thinking mode; adaptive models use `output_config.effort` with adaptive thinking. Older thinking models use token budgets. Gemini 3/4 use `thinkingConfig.thinkingLevel`; Gemini 2.5 uses `thinkingBudget`. Budget presets are Low = 1,024, Medium = 4,096, High = 8,192 thinking tokens. Unknown contracts and moving aliases offer Auto until their adjustable options are verified. Explicit effort requests allow 16,384 total output tokens; thinking tokens count toward that limit.

Official contracts checked on 22 October 2026:

- [OpenAI reasoning](https://developers.openai.com/api/docs/guides/reasoning)
- [OpenAI GPT-5.5 efforts](https://developers.openai.com/api/docs/models/gpt-5.5)
- [OpenAI GPT-5.6 Sol efforts](https://developers.openai.com/api/docs/models/gpt-5.6-sol)
- [Claude effort](https://platform.claude.com/docs/en/build-with-claude/effort)
- [Claude model capabilities and pagination](https://platform.claude.com/docs/en/api/models/list)
- [Gemini thinking levels and budgets](https://ai.google.dev/gemini-api/docs/generate-content/thinking)

## Live verification on 22 October 2026

The user's existing encrypted keys authenticated successfully. No key values were printed or written to the report or model cache.

| Provider | API models returned | Compatible chat models | Live generation check |
| --- | ---: | ---: | --- |
| OpenAI | 133 | 61 | `chat-latest` and `gpt-6.1-sol` returned `OK`; the latter used Low effort |
| Claude | 14 | 14 | `claude-sonnet-5-5` returned `OK` with Auto and Low effort |
| Google | 63 | 21 | `gemini-3.6-flash` returned `OK` with Auto and Low effort |

`gemini-3.8-flash` authenticated but returned HTTP 503 with a temporary high-demand message during generation. Its saved model preference was preserved. These are point-in-time checks, not generation tests of every listed model.

Additional compatibility samples: `gpt-4`, `gpt-4o-mini`, and `gemini-flash-latest` returned `OK`. `gemini-omni-1.1-flash` and `gemini-pro-latest` returned HTTP 429 with zero account quota for those models. `gemma-4-31b-it` and `gemini-flash-lite-latest` did not complete within the 25-second sample deadline. They remain catalog entries because listing, per-model quota, capacity, and generation are separate checks.

Validation: 66 automated unit checks; 25 desktop integration checks plus credential/preference restoration in a fresh process and confirmed Quit. Integration checks cover native request fields, catalog pagination, failure retention, refresh deduplication, IPC, draft selections during refresh, and per-model effort persistence.

Installed and reopened the macOS app as version 2.3.6. Strict deep code-signature verification passed. The installed app refreshed all three catalogs and displayed 61 / 14 / 21 chat models. Native UI verification confirmed GPT-6.1 Sol offers Auto, Low, Medium, High, Extra high, and Max. The original `chat-latest` selection was retained. Encrypted credential, current conversation, and archived-chat files were unchanged byte-for-byte. Provider/model selections, opacity, and other saved preferences were preserved. The prior app and encrypted profile were backed up locally before installation.
