'use strict';
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const root = path.join(__dirname, '..');
const smoke = process.argv.includes('--smoke-test');

function compileCloseFixture() {
  const windows = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  const compiler = ['Framework64', 'Framework']
    .map(directory => path.join(windows, 'Microsoft.NET', directory, 'v4.0.30319', 'csc.exe'))
    .find(file => fs.existsSync(file));
  if (!compiler) throw new Error('Windows native test setup failed: the inbox .NET Framework C# compiler (csc.exe) was not found.');
  const helper = path.join(root, '.test-output', 'normal-close-request.exe');
  fs.mkdirSync(path.dirname(helper), { recursive: true });
  const compiled = spawnSync(compiler, ['/nologo', '/target:exe', '/platform:anycpu', `/out:${helper}`, path.join(root, 'tests', 'request-close.cs')], {
    env, stdio: 'inherit', windowsHide: true, timeout: 30000
  });
  if (compiled.error || compiled.status !== 0 || !fs.existsSync(helper)) {
    throw new Error(`Windows native test setup failed: could not compile the normal-close fixture${compiled.error ? ` (${compiled.error.message})` : ` (exit ${compiled.status ?? 'unknown'})`}.`);
  }
}

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(require('electron'), args, { env, stdio: 'inherit', windowsHide: true });
    child.on('error', reject);
    child.on('exit', code => resolve(code ?? 1));
  });
}

void (async () => {
  if (smoke && process.platform === 'win32') compileCloseFixture();
  let code = await run([root, ...process.argv.slice(2)]);
  if (code === 0 && smoke) code = await run([path.join(root, 'tests', 'reopen-electron.cjs')]);
  if (code === 0 && smoke) code = await run([root, '--quit-smoke-test']);
  process.exitCode = code;
})().catch(error => { console.error(error.message); process.exitCode = 1; });
