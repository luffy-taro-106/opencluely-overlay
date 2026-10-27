'use strict';

const { createHash } = require('node:crypto');
const { validateQuestion, diskHistory, imageIds, imageNames, MAX_IMAGES } = require('./core');
const { PROVIDERS } = require('./models');
const { CheckpointWriter } = require('./checkpoint-writer');

const FILE = 'interrupted-work.enc';
function contextKey(history) {
  return createHash('sha256').update(JSON.stringify(diskHistory(history))).digest('hex');
}

// Checkpoints contain submitted text and partial output only. Images, API keys
// and request bodies stay out. Restoration never sends another provider request.
class InterruptedWork {
  constructor({ store, enabled, report = () => {}, interval = 1000 }) {
    this.store = store; this.enabled = enabled; this.report = report;
    this.pending = null;
    this.checkpoint = new CheckpointWriter({ interval,
      write: () => { if (!this.enabled() || !this.pending) return false; this.store.write(FILE, this.pending, true); },
      report: () => this.report('The unfinished answer could not be saved. Keep the app open or copy the text before quitting.') });
  }
  capture(request, history) {
    if (!this.enabled()) return;
    this.pending = {
      version: 2, context: this.pending?.id === request.id ? this.pending.context : contextKey(history), id: request.id,
      question: { text: request.question.text, imageId: null, imageIds: [] },
      needsAttachment: imageIds(request.question).length > 0 || request.needsAttachment === true,
      imageName: (request.images?.[0]?.name || request.image?.name || request.imageName || '').slice(0, 255),
      imageNames: (request.images?.map(image => image.name) || imageNames(request)).slice(0, MAX_IMAGES).map(name => name.slice(0, 255)),
      text: request.text.slice(0, 80000), provider: request.provider, model: request.model
    };
    return true;
  }
  start(request, history) {
    if (!this.capture(request, history)) return true;
    this.checkpoint.mark(); return this.flush();
  }
  update(request, history) {
    if (this.capture(request, history)) this.checkpoint.mark();
  }
  flush() { return this.checkpoint.flush(); }
  clear() {
    this.checkpoint.cancel(); this.pending = null;
    this.store.remove(FILE);
  }
  restore(history) {
    if (!this.enabled()) { this.clear(); return null; }
    const saved = this.store.read(FILE, null, true);
    if (saved === null) return null;
    try {
      if (![1, 2].includes(saved.version) || typeof saved.id !== 'string' || !/^[a-f0-9-]{36}$/i.test(saved.id) ||
        typeof saved.text !== 'string' || saved.text.length > 80000 || !PROVIDERS.includes(saved.provider) ||
        typeof saved.model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,99}$/.test(saved.model) ||
        typeof saved.needsAttachment !== 'boolean' || typeof saved.imageName !== 'string' || saved.imageName.length > 255 ||
        saved.question?.imageId !== null || (saved.question.imageIds !== undefined && (!Array.isArray(saved.question.imageIds) || saved.question.imageIds.length)) ||
        (saved.version === 2 && (!Array.isArray(saved.imageNames) || saved.imageNames.length > MAX_IMAGES || saved.imageNames.some(name => typeof name !== 'string' || name.length > 255)))) throw new Error('Invalid checkpoint.');
      const question = validateQuestion(saved.question);
      // If history committed just before termination, do not show the answer
      // twice. A different chat must not inherit another chat's interrupted work.
      if (history.some(message => message.id === saved.id) || saved.context !== contextKey(history)) {
        this.clear(); return null;
      }
      return { id: saved.id, question, text: saved.text, provider: saved.provider, model: saved.model,
        needsAttachment: saved.needsAttachment, imageName: saved.imageName, imageNames: imageNames(saved),
        error: 'This answer was interrupted. Saved text is restored; generation has not resumed.' +
          (saved.needsAttachment ? ' Attach the original images again before retrying.' : ' Retry only if you want to send the question again.') };
    } catch {
      this.report('The unfinished answer could not be restored. Completed conversations are unaffected.');
      return null;
    }
  }
}

module.exports = { InterruptedWork, FILE };
