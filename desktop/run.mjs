import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const localUrl = 'http://127.0.0.1:3000/remote-assist/';
let server = null;

async function isServerReady() {
  try {
    const response = await fetch(localUrl, { signal: AbortSignal.timeout(700) });
    return response.ok;
  } catch { return false; }
}

if (!await isServerReady()) {
  server = spawn(process.execPath, ['server.mjs'], { cwd: root, stdio: 'inherit', windowsHide: true });
  let ready = false;
  for (let i = 0; i < 60; i++) {
    if (server.exitCode !== null) throw new Error(`Local server exited with code ${server.exitCode}`);
    if (await isServerReady()) { ready = true; break; }
    await delay(250);
  }
  if (!ready) { server.kill(); throw new Error('Could not start the local app server on 127.0.0.1:3000.'); }
}

const electronBinary = require('electron');
const app = spawn(electronBinary, [path.join(root, 'desktop', 'main.cjs')], { cwd: root, stdio: 'inherit', windowsHide: false });
const closeServer = () => { if (server && server.exitCode === null) server.kill(); };
process.once('SIGINT', () => { app.kill(); closeServer(); });
process.once('SIGTERM', () => { app.kill(); closeServer(); });
app.once('exit', (code, signal) => {
  closeServer();
  process.exitCode = code ?? (signal ? 1 : 0);
});
