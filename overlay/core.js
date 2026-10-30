'use strict';

const MAX_TEXT = 12000;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_IMAGES = 10;
const MAX_CONTEXT_IMAGES = 10;
const imageIds = value => Array.isArray(value?.imageIds) ? value.imageIds : value?.imageId ? [value.imageId] : [];
const imageNames = value => Array.isArray(value?.imageNames) ? value.imageNames : value?.imageName ? [value.imageName] : [];
const { PROVIDERS, EFFORTS, validModelId } = require('./models');
const DEFAULTS = Object.freeze({
  provider: 'anthropic',
  models: { anthropic: 'claude-sonnet-5-5', gemini: 'gemini-3.8-flash', openai: 'gpt-6.1-sol', chatgpt: 'chatgpt-auto', codex: 'codex-auto' },
  reasoningEfforts: {},
  opacity: 0.98, codeOpacity: 1, launchAtLogin: false, rememberHistory: true, hideFromCapture: true, protectFromQuit: true,
  bounds: null, compact: false, theme: 'dark'
});

function validateSettings(input, current = DEFAULTS) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid settings.');
  const next = { ...DEFAULTS, ...current, models: { ...DEFAULTS.models, ...current.models }, reasoningEfforts: { ...current.reasoningEfforts } };
  if ('theme' in input) {
    if (!['dark', 'light'].includes(input.theme)) throw new Error('Choose Dark or Light appearance.');
    next.theme = input.theme;
  }
  if ('provider' in input) {
    if (!PROVIDERS.includes(input.provider)) throw new Error('Choose Claude, Gemini, an OpenAI API key, ChatGPT, or Codex.');
    next.provider = input.provider;
  }
  for (const provider of PROVIDERS) {
    if (input.models && provider in input.models) {
      const model = input.models[provider];
      if (typeof model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,99}$/.test(model)) throw new Error('Enter a valid model ID.');
      next.models[provider] = model;
    }
    if (input.reasoningEfforts && provider in input.reasoningEfforts) {
      const choices = input.reasoningEfforts[provider];
      if (!choices || typeof choices !== 'object' || Array.isArray(choices) || Object.keys(choices).length > 500) throw new Error('Invalid reasoning preferences.');
      next.reasoningEfforts[provider] = { ...next.reasoningEfforts[provider] };
      for (const [id, effort] of Object.entries(choices)) {
        if (!validModelId(id) || !EFFORTS.includes(effort)) throw new Error('Choose a valid reasoning effort.');
        next.reasoningEfforts[provider][id] = effort;
      }
      if (Object.keys(next.reasoningEfforts[provider]).length > 500) throw new Error('Too many reasoning preferences.');
    }
  }
  if ('reasoningEfforts' in input && (!input.reasoningEfforts || typeof input.reasoningEfforts !== 'object' || Array.isArray(input.reasoningEfforts) || Object.keys(input.reasoningEfforts).some(provider => !PROVIDERS.includes(provider)))) throw new Error('Invalid reasoning preferences.');
  if ('opacity' in input) {
    if (!Number.isFinite(input.opacity) || input.opacity < 0.1 || input.opacity > 1) throw new Error('Opacity must be between 10% and 100%.');
    next.opacity = input.opacity;
  }
  if ('codeOpacity' in input) {
    if (!Number.isFinite(input.codeOpacity) || input.codeOpacity < 0.1 || input.codeOpacity > 1) throw new Error('Code box opacity must be between 10% and 100%.');
    next.codeOpacity = input.codeOpacity;
  }
  for (const key of ['launchAtLogin', 'rememberHistory', 'compact', 'hideFromCapture', 'protectFromQuit']) {
    if (key in input) {
      if (typeof input[key] !== 'boolean') throw new Error('Invalid preference.');
      next[key] = input[key];
    }
  }
  return next;
}

function validateQuestion(input) {
  if (!input || typeof input !== 'object') throw new Error('Enter a question.');
  const text = typeof input.text === 'string' ? input.text.trim() : '';
  if (text.length > MAX_TEXT) throw new Error('Question is too long (12,000 characters maximum).');
  if ('imageIds' in input && !Array.isArray(input.imageIds)) throw new Error('Invalid attachments.');
  const ids = imageIds(input);
  if (ids.length > MAX_IMAGES) throw new Error(`Attach up to ${MAX_IMAGES} images per question.`);
  if (ids.some(id => typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) || new Set(ids).size !== ids.length) throw new Error('Invalid attachment.');
  if (!text && !ids.length) throw new Error('Type a question or attach an image.');
  return { text: text || `Read the question in ${ids.length === 1 ? 'this image' : 'these images'} and answer it. If any part is unclear, say so.`, imageId: ids[0] || null, imageIds: [...ids] };
}

// Inspect dimensions before invoking a native decoder, including JPEG SOF markers.
function inspectImage(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 24 || bytes.length > MAX_IMAGE_BYTES) throw new Error('Choose a PNG or JPEG up to 10 MB.');
  let width, height, mime;
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.toString('ascii', 12, 16) === 'IHDR') {
    width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20); mime = 'image/png';
  } else if (bytes[0] === 255 && bytes[1] === 216) {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 255) break;
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 217 || marker === 218) break;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      if (offset + 2 > bytes.length) break;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker) && length >= 8) {
        height = bytes.readUInt16BE(offset + 3); width = bytes.readUInt16BE(offset + 5); mime = 'image/jpeg'; break;
      }
      offset += length;
    }
  }
  if (!mime || !width || !height || width > 16000 || height > 16000 || width * height > 32_000_000) {
    throw new Error('Image is invalid or too large. Use PNG/JPEG with at most 32 megapixels.');
  }
  return { width, height, mime };
}

function clampBounds(saved, workArea, compact = false) {
  const width = Math.round(Math.min(workArea.width, Math.max(360, Number(saved?.width) || 460)));
  const height = Math.round(Math.min(workArea.height, compact ? 122 : Math.max(440, Number(saved?.height) || 700)));
  const proposedX = Number.isFinite(saved?.x) ? saved.x : workArea.x + workArea.width - width - 28;
  const proposedY = Number.isFinite(saved?.y) ? saved.y : workArea.y + 40;
  return {
    x: Math.round(Math.max(workArea.x, Math.min(proposedX, workArea.x + workArea.width - width))),
    y: Math.round(Math.max(workArea.y, Math.min(proposedY, workArea.y + workArea.height - height))),
    width, height
  };
}

function boundedContext(history, current, imageLookup) {
  const pairs = [];
  let chars = current.text.length;
  const currentImages = imageIds(current).map(imageLookup).filter(Boolean);
  let count = currentImages.length;
  let bytes = currentImages.reduce((sum, image) => sum + Buffer.byteLength(image.data || '', 'base64'), 0);
  for (let i = history.length - 2; i >= 0 && pairs.length < 8; i -= 2) {
    const user = history[i], answer = history[i + 1];
    if (user?.role !== 'user' || answer?.role !== 'assistant') continue;
    if (chars + user.text.length + answer.text.length > 48000) break;
    chars += user.text.length + answer.text.length;
    const ids = imageIds(user), names = imageNames(user), included = [], missing = [];
    for (let index = 0; index < Math.max(ids.length, names.length); index++) {
      const image = ids[index] ? imageLookup(ids[index]) : null;
      const size = image ? Buffer.byteLength(image.data || '', 'base64') : 0;
      if (image && count < MAX_CONTEXT_IMAGES && bytes + size <= 20 * 1024 * 1024) {
        included.push(image); count++; bytes += size;
      } else if (names[index]) missing.push(names[index]);
    }
    const text = missing.length ? `${user.text}\n[Earlier images: ${missing.join(', ')}. Their pixels are not available in this request.]` : user.text;
    pairs.unshift([{ role: 'user', text, images: included, image: included[0] || null }, { role: 'assistant', text: answer.text }]);
  }
  return [...pairs.flat(), { role: 'user', text: current.text, images: currentImages, image: currentImages[0] || null }];
}

function diskHistory(history) {
  return history.slice(-40).map(({ id, role, text, imageName, imageNames, model, provider, createdAt }) => ({ id, role, text, imageName, model, provider, createdAt,
    ...(Array.isArray(imageNames) ? { imageNames: imageNames.slice(0, MAX_IMAGES) } : {}) }));
}

function validateHistory(value) {
  if (!Array.isArray(value)) throw new Error('Invalid conversation data.');
  const clean = value.slice(-40);
  if (clean.length % 2 || clean.some((message, i) => !message || message.role !== (i % 2 ? 'assistant' : 'user') ||
    typeof message.text !== 'string' || message.text.length > 80000 || typeof message.id !== 'string' ||
    (message.imageNames !== undefined && (!Array.isArray(message.imageNames) || message.imageNames.length > MAX_IMAGES || message.imageNames.some(name => typeof name !== 'string' || name.length > 255))))) throw new Error('Invalid conversation data.');
  return diskHistory(clean);
}

module.exports = { DEFAULTS, MAX_TEXT, MAX_IMAGE_BYTES, MAX_IMAGES, imageIds, imageNames, validateSettings, validateQuestion, inspectImage, clampBounds, boundedContext, diskHistory, validateHistory };
