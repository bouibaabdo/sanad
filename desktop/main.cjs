const path = require('node:path');
const { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } = require('node:fs');
const { createServer } = require('node:http');
const { extname, resolve, sep } = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, desktopCapturer, dialog, ipcMain, safeStorage, screen, session } = require('electron');
const { randomBytes } = require('node:crypto');

let mainWindow;
let mouse;
let keyboard;
let Point;
let Key;
let Button;
let inputReady = false;
let grants = new Set();
let heldKeys = new Set();
let heldButtons = new Set();
let commandTimes = [];
let commandQueue = Promise.resolve();
let approvalDialogOpen = false;
let localServer;
let localPort = 3000;
let remoteSignalOrigin = '';
let deviceIdentity = null;
let deviceIdentityError = '';
let deviceSessionActive = false;
let savedPreferences = {};
const defaultSignalOrigin = 'https://sanad.abouiba93.workers.dev';

function preferencesPath() { return path.join(app.getPath('userData'), 'preferences.json'); }

function loadPreferences() {
  try {
    savedPreferences = JSON.parse(readFileSync(preferencesPath(), 'utf8'));
    if (!savedPreferences || typeof savedPreferences !== 'object' || Array.isArray(savedPreferences)) savedPreferences = {};
  } catch { savedPreferences = {}; }
  if (typeof savedPreferences.signalOrigin === 'string' && isAllowedSignalOrigin(savedPreferences.signalOrigin)) {
    remoteSignalOrigin = savedPreferences.signalOrigin;
  }
  if (!remoteSignalOrigin) {
    try {
      const legacy = JSON.parse(readFileSync(path.join(app.getPath('userData'), 'signal-server.json'), 'utf8')).origin;
      if (typeof legacy === 'string' && isAllowedSignalOrigin(legacy)) remoteSignalOrigin = legacy;
    } catch { /* No server has been saved yet. */ }
  }
  if (!remoteSignalOrigin) remoteSignalOrigin = defaultSignalOrigin;
  savedPreferences = { quality: 'balanced', fps: '30', fit: 'fit', dark: false, ...savedPreferences, signalOrigin: remoteSignalOrigin };
}

function savePreferences(value) {
  const next = {
    quality: ['economy', 'balanced', 'high'].includes(value?.quality) ? value.quality : 'balanced',
    fps: ['15', '30', '60'].includes(String(value?.fps)) ? String(value.fps) : '30',
    fit: ['fit', 'fill', 'native'].includes(value?.fit) ? value.fit : 'fit',
    dark: Boolean(value?.dark),
    signalOrigin: typeof value?.signalOrigin === 'string' && isAllowedSignalOrigin(value.signalOrigin) ? value.signalOrigin : '',
  };
  mkdirSync(path.dirname(preferencesPath()), { recursive: true });
  writeFileSync(preferencesPath(), JSON.stringify(next), 'utf8');
  savedPreferences = next;
  remoteSignalOrigin = next.signalOrigin;
  return next;
}

function saveDeviceIdentity() {
  if (!deviceIdentity || !safeStorage.isEncryptionAvailable()) throw new Error('التخزين الآمن لكلمة مرور الجهاز غير متاح.');
  const identityPath = path.join(app.getPath('userData'), 'device-identity.json');
  mkdirSync(path.dirname(identityPath), { recursive: true });
  writeFileSync(identityPath, JSON.stringify({
    id: deviceIdentity.id,
    ownerKey: safeStorage.encryptString(deviceIdentity.ownerKey).toString('base64'),
    password: safeStorage.encryptString(deviceIdentity.password).toString('base64'),
  }), 'utf8');
}

function loadDeviceIdentity() {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('التخزين الآمن لكلمة مرور الجهاز غير متاح على هذا النظام.');
  const identityPath = path.join(app.getPath('userData'), 'device-identity.json');
  if (existsSync(identityPath)) {
    const saved = JSON.parse(readFileSync(identityPath, 'utf8'));
    if (!/^[a-f0-9]{16}$/.test(saved.id) || typeof saved.ownerKey !== 'string' || typeof saved.password !== 'string') throw new Error('ملف هوية الجهاز غير صالح.');
    deviceIdentity = {
      id: saved.id,
      ownerKey: safeStorage.decryptString(Buffer.from(saved.ownerKey, 'base64')),
      password: safeStorage.decryptString(Buffer.from(saved.password, 'base64')),
    };
    return;
  }
  deviceIdentity = {
    id: randomBytes(8).toString('hex'),
    ownerKey: randomBytes(32).toString('base64url'),
    password: randomBytes(20).toString('base64url'),
  };
  saveDeviceIdentity();
}

async function localApi(pathname, options = {}) {
  const response = await fetch(`http://127.0.0.1:${localPort}${pathname}`, options);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'تعذر الاتصال بخادم الإشارات.');
  return result;
}

function isAllowedSignalOrigin(value) {
  try {
    const parsed = new URL(value);
    return parsed.origin === value && (parsed.protocol === 'https:' || (parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsed.hostname)));
  } catch { return false; }
}

async function forwardSignalRequest(request, response, requestUrl, fallback) {
  if (!remoteSignalOrigin) return fallback(request, response, () => { if (!response.writableEnded) response.writeHead(404).end(); });
  try {
    const headers = {};
    for (const [name, value] of Object.entries(request.headers)) {
      if (['host', 'connection', 'content-length', 'transfer-encoding', 'origin'].includes(name)) continue;
      headers[name] = value;
    }
    let body;
    if (!['GET', 'HEAD'].includes(request.method)) {
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 256 * 1024) { response.writeHead(413).end('Request too large.'); return; }
        chunks.push(chunk);
      }
      body = Buffer.concat(chunks);
    }
    const upstream = await fetch(new URL(requestUrl.pathname + requestUrl.search, remoteSignalOrigin), {
      method: request.method,
      headers,
      body,
      signal: AbortSignal.timeout(20_000),
    });
    response.writeHead(upstream.status, {
      'Content-Type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    response.end(Buffer.from(await upstream.arrayBuffer()));
  } catch {
    if (!response.headersSent) response.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ error: 'تعذر الاتصال بخادم الإشارات المشترك.' }));
  }
}

async function startPackagedServer() {
  const appRoot = app.getAppPath();
  const distDir = resolve(appRoot, 'dist');
  const { createSignalingMiddleware } = await import(pathToFileURL(resolve(appRoot, 'remote-assist/signaling.js')).href);
  const signaling = createSignalingMiddleware();
  const mimeTypes = new Map([
    ['.css', 'text/css; charset=utf-8'], ['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'],
    ['.json', 'application/json; charset=utf-8'], ['.svg', 'image/svg+xml'], ['.woff2', 'font/woff2'],
  ]);
  localServer = createServer(async (request, response) => {
    const requestUrl = new URL(request.url || '/', 'http://127.0.0.1');
    if (requestUrl.pathname.startsWith('/api/')) {
      await forwardSignalRequest(request, response, requestUrl, signaling);
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405, { Allow: 'GET, HEAD' }).end(); return; }
    if (requestUrl.pathname === '/') { response.writeHead(302, { Location: '/remote-assist/' }).end(); return; }
    let requestPath;
    try { requestPath = decodeURIComponent(requestUrl.pathname); }
    catch { response.writeHead(400).end('Invalid path.'); return; }
    if (requestPath === '/remote-assist/') requestPath = '/remote-assist/index.html';
    const filePath = resolve(distDir, `.${requestPath}`);
    const relativePath = filePath.slice(distDir.length);
    if (relativePath.startsWith(sep + '..') || relativePath === '..' || !existsSync(filePath) || !statSync(filePath).isFile()) {
      response.writeHead(404).end('Not found.'); return;
    }
    response.writeHead(200, {
      'Content-Type': mimeTypes.get(extname(filePath).toLowerCase()) || 'application/octet-stream',
      'Cache-Control': filePath.endsWith('.html') ? 'no-store' : 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
    });
    if (request.method === 'HEAD') { response.end(); return; }
    createReadStream(filePath).on('error', () => response.destroy()).pipe(response);
  });
  await new Promise((resolveListen, reject) => {
    localServer.once('error', reject);
    localServer.listen(0, '127.0.0.1', () => {
      localServer.removeListener('error', reject);
      localPort = localServer.address().port;
      resolveListen();
    });
  });
}

function appUrl() { return `http://127.0.0.1:${localPort}/remote-assist/`; }

const safeKeys = new Set([
  'Escape', 'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
  'Backspace', 'Insert', 'Home', 'PageUp', 'Delete', 'End', 'PageDown', 'Tab', 'Return', 'Enter',
  'CapsLock', 'LeftShift', 'RightShift', 'LeftControl', 'RightControl', 'LeftAlt', 'RightAlt',
  'LeftSuper', 'LeftWin', 'LeftCmd', 'RightSuper', 'RightWin', 'RightCmd', 'Space', 'Up', 'Down', 'Left', 'Right',
  'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z',
  'Num0', 'Num1', 'Num2', 'Num3', 'Num4', 'Num5', 'Num6', 'Num7', 'Num8', 'Num9',
]);

function isTrustedWindow(event) {
  if (!mainWindow || event.sender.id !== mainWindow.webContents.id) return false;
  try {
    const source = new URL(event.senderFrame.url);
    return source.hostname === '127.0.0.1' && source.port === String(localPort) && source.pathname.startsWith('/remote-assist/');
  } catch { return false; }
}

async function releaseHeldInput() {
  if (!inputReady) return;
  for (const button of heldButtons) {
    try { await mouse.releaseButton(button); } catch { /* The platform may have lost focus. */ }
  }
  for (const key of heldKeys) {
    try { await keyboard.releaseKey(key); } catch { /* The platform may have lost focus. */ }
  }
  heldButtons.clear();
  heldKeys.clear();
}

async function revokeControl() {
  grants.clear();
  commandTimes = [];
  await releaseInput();
  return { scopes: [] };
}

function enqueueInput(command) {
  commandQueue = commandQueue.then(async () => { await command(); return true; }).catch((error) => {
    mainWindow?.webContents.send('control:error', error.message || 'تعذر تنفيذ إدخال النظام.');
    return false;
  });
  return commandQueue;
}

function validNormalized(value) { return Number.isFinite(value) && value >= 0 && value <= 1; }
function releaseInput() { return enqueueInput(releaseHeldInput); }

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 900,
    minHeight: 680,
    backgroundColor: '#f4f7fb',
    title: 'سند — مساعدة عن بُعد',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, target) => {
    if (target !== appUrl() && !target.startsWith(appUrl())) event.preventDefault();
  });
  mainWindow.on('closed', () => { void revokeControl(); mainWindow = null; });
  mainWindow.loadURL(appUrl());
}

function registerControlHandlers() {
  ipcMain.handle('device:get', (event) => {
    if (!isTrustedWindow(event)) return { ok: false };
    return deviceIdentity ? { ok: true, id: deviceIdentity.id, password: deviceIdentity.password } : { ok: false, error: deviceIdentityError || 'هوية الجهاز غير متاحة.' };
  });
  ipcMain.handle('device:set-password', (event, password) => {
    if (!isTrustedWindow(event) || !deviceIdentity || deviceSessionActive) return { ok: false, error: 'أوقف مشاركة الشاشة قبل تغيير كلمة المرور.' };
    if (typeof password !== 'string' || password.length < 12 || password.length > 128) return { ok: false, error: 'كلمة المرور خاصها تكون بين 12 و128 حرف.' };
    deviceIdentity.password = password;
    try { saveDeviceIdentity(); return { ok: true }; }
    catch (error) { return { ok: false, error: error.message }; }
  });
  ipcMain.handle('device:register', async (event, offer) => {
    if (!isTrustedWindow(event) || !deviceIdentity || !offer || typeof offer.sdp !== 'string') return { ok: false, error: 'هوية الجهاز أو العرض غير متاح.' };
    try {
      await localApi(`/api/devices/${deviceIdentity.id}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ offer, ownerKey: deviceIdentity.ownerKey, password: deviceIdentity.password }),
      });
      deviceSessionActive = true;
      return { ok: true, id: deviceIdentity.id, password: deviceIdentity.password };
    } catch (error) { return { ok: false, error: error.message }; }
  });
  ipcMain.handle('device:answer', async (event) => {
    if (!isTrustedWindow(event) || !deviceIdentity) return { ok: false, error: 'هوية الجهاز غير متاحة.' };
    try {
      const result = await localApi(`/api/devices/${deviceIdentity.id}/answer`, { headers: { 'X-Device-Key': deviceIdentity.ownerKey } });
      return { ok: true, answer: result.answer };
    } catch (error) { return { ok: false, error: error.message }; }
  });
  ipcMain.handle('device:unregister', async (event) => {
    if (!isTrustedWindow(event) || !deviceIdentity) return { ok: false };
    try {
      await localApi(`/api/devices/${deviceIdentity.id}/register`, { method: 'DELETE', headers: { 'X-Device-Key': deviceIdentity.ownerKey } });
      deviceSessionActive = false;
      return { ok: true };
    } catch (error) {
      deviceSessionActive = false;
      return { ok: false, error: error.message };
    }
  });
  ipcMain.handle('signal:get-origin', (event) => isTrustedWindow(event) ? remoteSignalOrigin : '');
  ipcMain.handle('signal:set-origin', (event, origin) => {
    if (!isTrustedWindow(event) || (origin !== '' && !isAllowedSignalOrigin(origin))) return { ok: false };
    savePreferences({ ...savedPreferences, signalOrigin: origin });
    return { ok: true, origin };
  });
  ipcMain.handle('settings:get', (event) => isTrustedWindow(event) ? savedPreferences : null);
  ipcMain.handle('settings:save', (event, value) => {
    if (!isTrustedWindow(event) || !value || typeof value !== 'object' || Array.isArray(value)) return { ok: false };
    if (value.signalOrigin && !isAllowedSignalOrigin(value.signalOrigin)) return { ok: false, error: 'رابط خادم الاتصال غير صالح.' };
    return { ok: true, settings: savePreferences(value) };
  });
  ipcMain.handle('control:request', async (event, requestedScopes) => {
    if (!isTrustedWindow(event) || !inputReady) return { granted: false, scopes: [], reason: 'input-unavailable' };
    if (approvalDialogOpen) return { granted: false, scopes: [], reason: 'approval-pending' };
    const requested = [...new Set((Array.isArray(requestedScopes) ? requestedScopes : []).filter((scope) => ['mouse', 'keyboard'].includes(scope)))];
    if (!requested.length) return { granted: false, scopes: [], reason: 'empty-request' };
    const choices = [];
    const options = [];
    if (requested.includes('mouse') && requested.includes('keyboard')) {
      choices.push({ label: 'الفأرة ولوحة المفاتيح', scopes: ['mouse', 'keyboard'] });
    }
    if (requested.includes('mouse')) choices.push({ label: 'الفأرة فقط', scopes: ['mouse'] });
    if (requested.includes('keyboard')) choices.push({ label: 'لوحة المفاتيح فقط', scopes: ['keyboard'] });
    choices.forEach((choice) => options.push(choice.label));
    const denyIndex = options.length;
    options.push('رفض');
    approvalDialogOpen = true;
    let result;
    try {
      result = await dialog.showMessageBox(mainWindow, {
        type: 'question',
        title: 'طلب صلاحية التحكم',
        message: 'الطرف المتصل يطلب التحكم في هذا الجهاز.',
        detail: 'اختر الصلاحيات التي تسمح بها. يمكنك إيقافها من التطبيق في أي وقت.',
        buttons: options,
        defaultId: denyIndex,
        cancelId: denyIndex,
        noLink: true,
      });
    } finally { approvalDialogOpen = false; }
    grants = result.response < choices.length ? new Set(choices[result.response].scopes) : new Set();
    return { granted: grants.size > 0, scopes: [...grants] };
  });

  ipcMain.handle('control:revoke', async (event) => {
    if (!isTrustedWindow(event)) return { scopes: [] };
    return revokeControl();
  });

  ipcMain.handle('control:release', async (event) => {
    if (!isTrustedWindow(event)) return { ok: false };
    return { ok: await releaseInput() };
  });

  ipcMain.handle('control:input', async (event, packet) => {
    if (!isTrustedWindow(event) || !packet || typeof packet !== 'object') return { ok: false };
    if (typeof packet.action !== 'string') return { ok: false };
    const kind = packet.action.startsWith('key-') || packet.action === 'text' ? 'keyboard' : 'mouse';
    if (!grants.has(kind)) return { ok: false, reason: 'permission-denied' };
    const now = Date.now();
    commandTimes = commandTimes.filter((time) => now - time < 1000);
    const isRelease = packet.action === 'button-up' || packet.action === 'key-up';
    if (!isRelease && commandTimes.length >= 120) return { ok: false, reason: 'rate-limited' };
    if (!isRelease) commandTimes.push(now);

    const ok = await enqueueInput(async () => {
      if (!grants.has(kind) || !inputReady) return;
      if (packet.action === 'move' && validNormalized(packet.x) && validNormalized(packet.y)) {
        const display = screen.getPrimaryDisplay();
        const x = Math.round(packet.x * Math.max(0, display.size.width * display.scaleFactor - 1));
        const y = Math.round(packet.y * Math.max(0, display.size.height * display.scaleFactor - 1));
        await mouse.setPosition(new Point(x, y));
      } else if ((packet.action === 'button-down' || packet.action === 'button-up') && ['LEFT', 'MIDDLE', 'RIGHT'].includes(packet.button)) {
        const button = Button[packet.button];
        if (packet.action === 'button-down') { await mouse.pressButton(button); heldButtons.add(button); }
        else { await mouse.releaseButton(button); heldButtons.delete(button); }
      } else if (packet.action === 'wheel' && Number.isFinite(packet.deltaY)) {
        const steps = Math.min(5, Math.max(1, Math.round(Math.abs(packet.deltaY) / 100)));
        if (packet.deltaY > 0) await mouse.scrollDown(steps);
        else if (packet.deltaY < 0) await mouse.scrollUp(steps);
      } else if (packet.action === 'text' && typeof packet.value === 'string' && packet.value.length <= 32) {
        await keyboard.type(packet.value);
      } else if ((packet.action === 'key-down' || packet.action === 'key-up') && safeKeys.has(packet.key)) {
        const key = Key[packet.key];
        if (typeof key !== 'number') return;
        if (packet.action === 'key-down') { await keyboard.pressKey(key); heldKeys.add(key); }
        else { await keyboard.releaseKey(key); heldKeys.delete(key); }
      }
    });
    return { ok };
  });
}

app.whenReady().then(async () => {
  loadPreferences();
  try { loadDeviceIdentity(); }
  catch (error) { deviceIdentityError = error.message || 'تعذر إنشاء هوية هذا الجهاز.'; }
  if (app.isPackaged) await startPackagedServer();
  try {
    if (process.platform === 'linux' && process.env.XDG_SESSION_TYPE === 'wayland') throw new Error('Wayland input is not supported by this driver.');
    ({ mouse, keyboard, Point, Key, Button } = await import('@nut-tree-fork/nut-js'));
    inputReady = true;
  } catch (error) {
    console.error('Native mouse/keyboard input is unavailable:', error);
  }

  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'] });
      if (!sources.length) { callback({}); return; }
      const answer = await dialog.showMessageBox(mainWindow, {
        type: 'question',
        title: 'مشاركة الشاشة',
        message: 'طلب الطرف الآخر مشاهدة الشاشة الرئيسية لهذا الجهاز.',
        detail: 'ستظهر الشاشة فقط بعد موافقتك. يمكنك إيقاف المشاركة من شريط التطبيق أو زر إنهاء الجلسة.',
        buttons: ['مشاركة الشاشة', 'رفض'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      });
      const primaryDisplay = screen.getPrimaryDisplay();
      const primarySource = sources.find((source) => source.display_id === String(primaryDisplay.id)) || sources[0];
      callback(answer.response === 0 ? { video: primarySource, audio: 'none' } : {});
    } catch { callback({}); }
  });

  registerControlHandlers();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { void revokeControl(); if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { localServer?.close(); });
