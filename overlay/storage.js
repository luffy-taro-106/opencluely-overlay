'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

class Store {
  constructor(directory, crypto, report = () => {}) {
    this.directory = directory; this.crypto = crypto; this.report = report;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const info = fs.lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('App data must be stored in a real directory.');
    if (process.platform !== 'win32') fs.chmodSync(directory, 0o700);
  }
  file(name) {
    if (typeof name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) throw new Error('Invalid storage filename.');
    return path.join(this.directory, name);
  }
  limit(name) { return (name === 'chats.enc' ? 8 : 4) * 1024 * 1024; }
  available() {
    return this.crypto.isEncryptionAvailable() && !(process.platform === 'linux' && this.crypto.getSelectedStorageBackend() === 'basic_text');
  }
  read(name, fallback, encrypted = false) {
    const file = this.file(name);
    if (!fs.existsSync(file)) return fallback;
    try {
      const info = fs.lstatSync(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > this.limit(name)) throw new Error('Invalid settings file');
      const data = fs.readFileSync(file);
      return JSON.parse(encrypted ? this.crypto.decryptString(data) : data.toString('utf8'));
    } catch {
      this.report(`Could not restore ${name}. Your existing file was preserved; defaults are in use.`);
      return fallback;
    }
  }
  write(name, value, encrypted = false) {
    if (encrypted && !this.available()) throw new Error('Secure storage is unavailable. Keys and history cannot be saved on this device.');
    const target = this.file(name);
    const text = JSON.stringify(value);
    const data = encrypted ? this.crypto.encryptString(text) : Buffer.from(text, 'utf8');
    if (data.length > this.limit(name)) throw new Error('Saved data is full. Export and remove older conversations.');
    // A unique exclusive file avoids following an old temporary symlink. Flush
    // its complete contents before replacing the last successful save.
    const temporary = path.join(this.directory, `.opencluely-write-${name}-${randomUUID()}.tmp`);
    let fd;
    try {
      fd = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(fd, data);
      fs.fsyncSync(fd);
      fs.closeSync(fd); fd = undefined;
      fs.renameSync(temporary, target);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      fs.rmSync(temporary, { force: true });
    }
  }
  remove(name) {
    fs.rmSync(this.file(name), { force: true });
    // A kill during a write can leave encrypted staging files. Removing this
    // saved file removes those copies too; never read them as committed data.
    const prefix = `.opencluely-write-${name}-`;
    for (const file of fs.readdirSync(this.directory)) {
      if (file.startsWith(prefix) && /^[a-f0-9-]{36}\.tmp$/.test(file.slice(prefix.length))) {
        fs.rmSync(path.join(this.directory, file), { force: true });
      }
    }
    fs.rmSync(`${this.file(name)}.tmp`, { force: true });
  }
}
module.exports = { Store };
