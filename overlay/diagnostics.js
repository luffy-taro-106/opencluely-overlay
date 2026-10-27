'use strict';

const fs = require('node:fs/promises');
const { performance } = require('node:perf_hooks');
const { createHash } = require('node:crypto');

const LIFECYCLE = new Set(['ready', 'renderer-recovery', 'session-end', 'session-end-cancelled',
  'suspend', 'resume', 'lock', 'unlock', 'display-change', 'quit', 'fatal']);
const FAILURE_CODES = new Set(['ENOENT', 'EACCES', 'EPERM', 'EIO', 'EBUSY']);
const number = value => Number.isFinite(value) ? value : null;
const kind = value => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
const code = error => FAILURE_CODES.has(error?.code) ? error.code : 'unavailable';

// Explicit instrumentation of our own call sites. No patching, injection,
// external process access, argument values, response bodies or error messages.
class Diagnostics {
  constructor({ maximumEvents = 200 } = {}) {
    if (!Number.isSafeInteger(maximumEvents) || maximumEvents < 2 || maximumEvents > 1000) throw new TypeError('Invalid diagnostic history limit.');
    this.maximumEvents = maximumEvents; this.enabled = false; this.generation = 0;
    this.events = []; this.sequence = 0; this.active = 0; this.calls = 0; this.failures = 0;
    this.overheadMs = 0; this.startedAt = null;
  }
  start() {
    this.generation++; this.enabled = true; this.events = []; this.sequence = 0;
    this.active = 0; this.calls = 0; this.failures = 0; this.overheadMs = 0;
    this.startedAt = new Date().toISOString(); return this.status();
  }
  stop() { this.generation++; this.enabled = false; this.active = 0; return this.status(); }
  append(event) {
    this.events.push({ sequence: ++this.sequence, at: new Date().toISOString(), ...event });
    if (this.events.length > this.maximumEvents) this.events.shift();
  }
  lifecycle(name) { if (this.enabled && LIFECYCLE.has(name)) this.append({ type: 'lifecycle', name }); }
  async run(name, action) {
    if (!this.enabled || typeof name !== 'string' || !/^[a-z][a-z-]{0,49}$/.test(name)) return action();
    const preparation = performance.now(), generation = this.generation;
    const cpu = process.cpuUsage(), started = performance.now();
    this.calls++; this.active++; this.append({ type: 'call-start', name });
    const call = this.sequence;
    this.overheadMs += performance.now() - preparation;
    let outcome = 'ok', resultType = 'undefined';
    try { const result = await action(); resultType = kind(result); return result; }
    catch (error) { outcome = 'error'; throw error; }
    finally {
      if (this.enabled && this.generation === generation) {
        const ended = performance.now(), usage = process.cpuUsage(cpu);
        this.active = Math.max(0, this.active - 1); if (outcome === 'error') this.failures++;
        this.append({ type: 'call-end', name, call, outcome, resultType,
          durationMs: ended - started, mainProcessCpuMsDuringCall: (usage.user + usage.system) / 1000 });
        this.overheadMs += performance.now() - ended;
      }
    }
  }
  status() {
    return { recording: this.enabled, startedAt: this.startedAt, retainedEvents: this.events.length,
      calls: this.calls, failures: this.failures, active: this.active,
      measuredInstrumentationMs: this.overheadMs, mechanism: 'explicit-own-code-calls' };
  }
  snapshot() { return { ...this.status(), events: this.events.map(event => ({ ...event })) }; }
}

function ownProcessMetrics(metrics) {
  const types = new Set(['Browser', 'Tab', 'Utility', 'GPU', 'Zygote', 'Sandbox helper', 'Pepper Plugin', 'Pepper Plugin Broker']);
  return metrics.slice(0, 100).map(metric => ({ pid: number(metric.pid),
    type: types.has(metric.type) ? metric.type : 'Other',
    cpuPercent: number(metric.cpu?.percentCPUUsage),
    workingSetKiB: number(metric.memory?.workingSetSize),
    peakWorkingSetKiB: number(metric.memory?.peakWorkingSetSize) }));
}

function checkpointStatus(value) {
  return { dirty: value?.dirty === true, retryScheduled: value?.retryScheduled === true,
    consecutiveFailures: number(value?.consecutiveFailures),
    lastSavedAt: typeof value?.lastSavedAt === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.lastSavedAt) ? value.lastSavedAt : null };
}

async function inspectOwnFile(name, filename, { pe = false } = {}) {
  // Callers supply fixed application-owned files, never a renderer-supplied path.
  try {
    const info = await fs.lstat(filename);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 2 * 1024 * 1024) return { name, status: 'not-inspected' };
    const bytes = await fs.readFile(filename);
    if (bytes.length > 2 * 1024 * 1024) return { name, status: 'not-inspected' };
    const result = { name, status: 'readable', bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex') };
    if (pe) result.pe = inspectPE(bytes);
    return result;
  } catch (error) { return { name, status: code(error) }; }
}

function inspectPE(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 64 || bytes.readUInt16LE(0) !== 0x5a4d) return { valid: false };
  const offset = bytes.readUInt32LE(0x3c);
  if (offset > bytes.length - 26 || bytes.readUInt32LE(offset) !== 0x00004550) return { valid: false };
  const machine = bytes.readUInt16LE(offset + 4), sections = bytes.readUInt16LE(offset + 6);
  const optionalSize = bytes.readUInt16LE(offset + 20);
  if (sections < 1 || sections > 96 || optionalSize < 2 || offset + 24 + optionalSize > bytes.length) return { valid: false };
  const magic = bytes.readUInt16LE(offset + 24);
  if (![0x10b, 0x20b].includes(magic)) return { valid: false };
  return { valid: true, machine: ({ 0x14c: 'x86', 0x8664: 'x64', 0xaa64: 'arm64' })[machine] || 'other',
    sections, format: magic === 0x20b ? 'PE32+' : 'PE32' };
}

module.exports = { Diagnostics, ownProcessMetrics, checkpointStatus, inspectOwnFile, inspectPE };
