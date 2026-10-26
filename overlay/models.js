'use strict';

// Offline starting points only. Configured accounts replace these with live catalogs.
const PRESETS = {
  // ChatGPT connections discover their own account catalog. No bundled model
  // name is evidence that a subscription has access to it.
  chatgpt: [],
  openai: [
    { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol · balanced' },
    { id: 'gpt-6-astra', name: 'GPT-6 Astra · advanced reasoning' },
    { id: 'gpt-6-luna', name: 'GPT-6 Luna · fast and economical' },
    { id: 'chat-latest', name: 'ChatGPT · latest Instant' }
  ],
  anthropic: [
    { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5 · balanced' },
    { id: 'claude-opus-5-5', name: 'Claude Opus 5.5 · advanced' },
    { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5 · fast' },
    { id: 'claude-fable-5-1', name: 'Claude Fable 5.1 · deep reasoning' }
  ],
  gemini: [
    { id: 'gemini-4-argon', name: 'Gemini 4 Argon' },
    { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash · balanced' },
    { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro · preview' },
    { id: 'gemini-3.5-flash-lite', name: 'Gemini 3.5 Flash-Lite · economical' },
    { id: 'gemini-3.6-flash', name: 'Gemini 3.6 Flash' },
    { id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash-Lite' },
    { id: 'gemini-3-flash-preview', name: 'Gemini 3 Flash · preview' },
    { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro · legacy access' },
    { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash · legacy access' }
  ]
};
const PROVIDERS = Object.freeze(['anthropic', 'gemini', 'openai', 'chatgpt']);
const PROVIDER_NAMES = Object.freeze({ anthropic: 'Claude', gemini: 'Gemini', openai: 'OpenAI API key', chatgpt: 'ChatGPT account' });
const EFFORTS = Object.freeze(['auto', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const BASIC = ['low', 'medium', 'high'];
const EXTENDED = [...BASIC, 'xhigh', 'max'];
const validModelId = id => typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,99}$/.test(id);

// Official contracts checked 22 October 2026. Claude's live capability flags
// override these fallbacks. Unknown models stay on provider defaults.
function modelDetails(provider, id, metadata = {}) {
  let reasoningEfforts = [], reasoningMode = null, thinking = null, vision = true;
  if (provider === 'chatgpt') {
    // SIWC catalogs are an account-specific contract. Use explicit capability
    // metadata rather than inferring subscription capabilities from a slug.
    const modalities = metadata.input_modalities || metadata.modalities?.input;
    vision = Array.isArray(modalities) ? modalities.includes('image')
      : typeof metadata.capabilities?.image_input?.supported === 'boolean' ? metadata.capabilities.image_input.supported
        : typeof metadata.supports_images === 'boolean' ? metadata.supports_images : null;
    const efforts = metadata.supported_reasoning_efforts || metadata.supported_reasoning_levels || metadata.reasoning_efforts;
    if (Array.isArray(efforts)) reasoningEfforts = [...new Set(efforts.map(value => typeof value === 'string' ? value : value?.effort).filter(value => EFFORTS.includes(value) && value !== 'auto'))];
    if (reasoningEfforts.length) reasoningMode = 'effort';
  } else if (provider === 'openai') {
    if (/^gpt-6(?:\.1)?-(?:astra|sol|luna)(?:-|$)/.test(id) || /^gpt-5\.6-(?:sol|terra|luna)(?:-|$)/.test(id)) {
      reasoningEfforts = /^(?:gpt-6-(?:sol|luna)|gpt-5\.6-)/.test(id) ? ['none', ...EXTENDED] : EXTENDED;
    } else if (/^gpt-5(?:\.\d+)?-chat|^chat-latest$/.test(id)) {
      reasoningEfforts = [];
    } else if (/^gpt-5-pro(?:-|$)/.test(id)) reasoningEfforts = ['high'];
    else if (/^gpt-5\.[245]-pro(?:-|$)/.test(id)) reasoningEfforts = ['medium', 'high', 'xhigh'];
    else if (/^gpt-5\.[2345](?:-|$)/.test(id)) reasoningEfforts = /codex/.test(id) ? [...BASIC, 'xhigh'] : ['none', ...BASIC, 'xhigh'];
    else if (/^gpt-5\.1-codex-max(?:-|$)/.test(id)) reasoningEfforts = [...BASIC, 'xhigh'];
    else if (/^gpt-5\.1(?:-|$)/.test(id)) reasoningEfforts = /codex/.test(id) ? BASIC : ['none', ...BASIC];
    else if (/^gpt-5(?:-|$)/.test(id)) reasoningEfforts = /codex/.test(id) ? BASIC : ['minimal', ...BASIC];
    else if (/^o[134](?:-|$)/.test(id) && !/^o1-pro/.test(id)) reasoningEfforts = BASIC;
    vision = !/^o3-mini(?:-|$)/.test(id) && !/^gpt-4(?:-\d|$)/.test(id);
    if (reasoningEfforts.length) reasoningMode = 'effort';
  } else if (provider === 'anthropic') {
    const capabilities = metadata.capabilities;
    if (capabilities) {
      vision = capabilities.image_input?.supported !== false;
      const effort = capabilities.effort;
      if (effort?.supported) reasoningEfforts = EFFORTS.filter(value => effort[value]?.supported);
      if (capabilities.thinking?.types?.adaptive?.supported) thinking = 'adaptive';
      else if (capabilities.thinking?.types?.enabled?.supported) thinking = 'enabled';
      if (effort?.supported && reasoningEfforts.length) reasoningMode = 'effort';
      else if (thinking === 'enabled') { reasoningEfforts = BASIC; reasoningMode = 'thinkingBudget'; }
    } else if (/^claude-(?:(?:opus|sonnet|haiku)-5|(?:fable|mythos)-5|opus-4-[78])(?:-|$)/.test(id)) {
      reasoningEfforts = EXTENDED; reasoningMode = 'effort'; thinking = 'adaptive';
    } else if (/^claude-(?:opus|sonnet)-4-6(?:-|$)/.test(id)) {
      reasoningEfforts = [...BASIC, 'max']; reasoningMode = 'effort'; thinking = 'adaptive';
    } else if (/^claude-(?:opus|sonnet|haiku)-4-5(?:-|$)/.test(id)) {
      reasoningEfforts = BASIC; thinking = 'enabled'; reasoningMode = /^claude-opus/.test(id) ? 'effort' : 'thinkingBudget';
    }
  } else if (provider === 'gemini' && metadata.thinking !== false) {
    if (/^gemini-(?:4-argon|3\.[78]-flash)(?:-|$)/.test(id)) { reasoningEfforts = BASIC; reasoningMode = 'thinkingLevel'; }
    else if (/^gemini-3(?:\.\d+)?-(?:flash|pro)(?:-|$)/.test(id)) {
      reasoningEfforts = /-pro/.test(id) ? BASIC : ['minimal', ...BASIC]; reasoningMode = 'thinkingLevel';
    } else if (/^gemini-2\.5-(?:flash|pro)(?:-|$)/.test(id)) { reasoningEfforts = BASIC; reasoningMode = 'thinkingBudget'; }
  }
  return { id, name: metadata.display_name || metadata.displayName || id, reasoningEfforts: [...reasoningEfforts], reasoningMode, thinking, vision };
}

function normalizeModels(provider, items, now = new Date()) {
  if (!PROVIDERS.includes(provider) || !Array.isArray(items)) throw new Error('Invalid model catalog.');
  const seen = new Set(), models = [];
  for (const item of items) {
    const id = provider === 'gemini' ? item?.name?.replace(/^models\//, '') : provider === 'chatgpt' ? item?.slug : item?.id;
    if (!validModelId(id) || seen.has(id)) continue;
    if (provider === 'chatgpt' && item.visibility !== 'list') continue;
    if (item.shutdown_date && item.shutdown_date <= now.toISOString().slice(0, 10)) continue;
    if (item.lifecycle === 'retired' || (item.retires_at && Date.parse(item.retires_at) <= now.getTime())) continue;
    if (provider === 'openai' && (!/^(?:gpt-[456](?:[.o-]|$)|o[134](?:-|$)|chat-latest$)/.test(id) || /audio|realtime|transcribe|tts|image|search|deep-research/.test(id))) continue;
    if (provider === 'anthropic' && !id.startsWith('claude-')) continue;
    if (provider === 'gemini' && (!item.supportedGenerationMethods?.includes('generateContent') || !/^(?:gemini-|gemma-)/.test(id) || /image|nano-banana|tts|transcribe|audio|live|computer-use|robotics/.test(id))) continue;
    const model = modelDetails(provider, id, item);
    if (item.shutdown_date) model.name += ` · retires ${item.shutdown_date}`;
    if (!model.vision && provider !== 'chatgpt') model.name += ' · text only';
    models.push(model); seen.add(id);
  }
  if (provider === 'chatgpt') return models;
  const preferred = PRESETS[provider].map(model => model.id);
  return models.sort((a, b) => {
    const ai = preferred.indexOf(a.id), bi = preferred.indexOf(b.id);
    return (ai < 0 ? 1000 : ai) - (bi < 0 ? 1000 : bi) || b.id.localeCompare(a.id, 'en', { numeric: true });
  });
}

const MODEL_CATALOG = Object.freeze(Object.fromEntries(PROVIDERS.map(provider => [provider,
  PRESETS[provider].map(model => ({ ...modelDetails(provider, model.id), name: model.name }))
])));
module.exports = { MODEL_CATALOG, PROVIDERS, PROVIDER_NAMES, EFFORTS, validModelId, modelDetails, normalizeModels };
