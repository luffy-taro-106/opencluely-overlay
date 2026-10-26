'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Build only: this script never starts a supervisor, registers a task or writes
// user profile settings. .NET Framework 4.x is included with Windows 10/11.
if (process.platform !== 'win32') {
  console.log('Windows recovery helper: skipped on this platform.');
  process.exit(0);
}
const root = path.join(__dirname, '..');
const compiler = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
if (!fs.existsSync(compiler)) {
  console.error('Windows .NET Framework 4.x C# compiler was not found.');
  process.exit(1);
}
const outputDirectory = path.join(root, 'overlay', 'native', 'bin');
fs.mkdirSync(outputDirectory, { recursive: true });
const output = path.join(outputDirectory, 'recovery-helper-win32-x64.exe');
const temporary = path.join(outputDirectory, `recovery-helper-${process.pid}.tmp.exe`);
const result = spawnSync(compiler, ['/nologo', '/optimize+', '/target:winexe', '/platform:x64',
  '/reference:System.Windows.Forms.dll', '/reference:System.Web.Extensions.dll',
  `/out:${temporary}`, path.join(root, 'overlay', 'native', 'recovery-helper.cs')], {
  encoding: 'utf8', windowsHide: true, timeout: 60000
});
if (result.error || result.status !== 0) {
  fs.rmSync(temporary, { force: true });
  console.error(result.error?.message || result.stdout || result.stderr || 'Recovery helper compilation failed.');
  process.exit(result.status || 1);
}
fs.renameSync(temporary, output);
console.log('Built Windows recovery helper (x64).');
