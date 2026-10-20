const path = require('node:path');
const { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } = require('node:fs');
const { createServer } = require('node:http');
const { extname, resolve, sep } = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, desktopCapturer, dialog, ipcMain, safeStorage, screen, session, shell } = require('electron');
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
let sharedDisplayId = null;
let savedPreferences = {};
const defaultSignalOrigin = 'https://sanad.abouiba93.workers.dev';
let lastNotifiedUpdate = '';

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
  // Earlier app builds stored Arabic as the implicit default. Upgrade those
  // installs to French; the user can still choose Arabic or English afterward.
  if (savedPreferences.language === 'ar') savedPreferences.language = 'fr';
  savedPreferences = { quality: 'balanced', fps: '30', fit: 'fit', dark: false, language: 'fr', ...savedPreferences, signalOrigin: remoteSignalOrigin };
}

function savePreferences(value) {
  const next = {
    quality: ['economy', 'balanced', 'high'].includes(value?.quality) ? value.quality : 'balanced',
    fps: ['15', '30', '60'].includes(String(value?.fps)) ? String(value.fps) : '30',
    fit: ['fit', 'fill', 'native'].includes(value?.fit) ? value.fit : 'fit',
    dark: Boolean(value?.dark),
    language: ['fr', 'en', 'ar'].includes(value?.language) ? value.language : 'fr',
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
  'NumPad0', 'NumPad1', 'NumPad2', 'NumPad3', 'NumPad4', 'NumPad5', 'NumPad6', 'NumPad7', 'NumPad8', 'NumPad9',
  'NumPadEqual', 'NumLock', 'Grave', 'Minus', 'Equal', 'LeftBracket', 'RightBracket', 'Backslash',
  'Semicolon', 'Quote', 'Comma', 'Period', 'Slash',
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
    title: 'Sanad — Assistance à distance',
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

async function checkForUpdates() {
  if (!app.isPackaged) return;
  try {
    const response = await fetch('https://sanad.abouiba93.workers.dev/remote-assist/update.json', { signal: AbortSignal.timeout(5000), cache: 'no-store' });
    if (!response.ok) return;
    const update = await response.json();
    const parseVersion = (value) => typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value) ? value.split('.').map(Number) : null;
    const current = parseVersion(app.getVersion());
    const latest = parseVersion(update.version);
    if (!current || !latest || latest.every((part, index) => part === current[index])) return;
    const isNewer = latest.some((part, index) => part > current[index] && latest.slice(0, index).every((previous, previousIndex) => previous === current[previousIndex]));
    const validUrl = typeof update.url === 'string' && /^https:\/\/github\.com\/bouibaabdo\/sanad\/releases\/download\/v\d+\.\d+\.\d+\/Sanad-Setup-\d+\.\d+\.\d+\.exe$/.test(update.url);
    if (!isNewer || lastNotifiedUpdate === update.version || !validUrl) return;
    lastNotifiedUpdate = update.version;
    const language = savedPreferences.language || 'fr';
    const title = { fr: 'Mise à jour de Sanad disponible', en: 'Sanad update available', ar: 'تحديث جديد لسند' }[language];
    const message = { fr: `La version ${update.version} de Sanad est disponible.`, en: `Sanad ${update.version} is available.`, ar: `كاينة نسخة جديدة من سند (${update.version}).` }[language];
    const detail = {
      fr: 'Téléchargez puis installez la mise à jour. Vos préférences et l’identifiant de votre appareil seront conservés.',
      en: 'Download and install the update. Your preferences and device ID will be kept.',
      ar: 'نزّل وثبّت التحديث. الإعدادات ومعرّف الجهاز غيبقاو محفوظين.',
    }[language];
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title, message, detail,
      buttons: { fr: ['Télécharger', 'Plus tard'], en: ['Download', 'Later'], ar: ['تنزيل التحديث', 'لاحقًا'] }[language],
      defaultId: 0, cancelId: 1, noLink: true,
    });
    if (result.response === 0) await shell.openExternal(update.url);
  } catch { /* Updates are optional; offline startup should remain immediate. */ }
}

function registerControlHandlers() {
  ipcMain.handle('app:get-version', (event) => isTrustedWindow(event) ? app.getVersion() : '');
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
  ipcMain.handle('display:clear-selection', (event) => {
    if (!isTrustedWindow(event)) return false;
    sharedDisplayId = null;
    return true;
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
      choices.push({ label: { fr: 'Souris et clavier', en: 'Mouse and keyboard', ar: 'الفأرة ولوحة المفاتيح' }[savedPreferences.language || 'fr'], scopes: ['mouse', 'keyboard'] });
    }
    if (requested.includes('mouse')) choices.push({ label: { fr: 'Souris uniquement', en: 'Mouse only', ar: 'الفأرة فقط' }[savedPreferences.language || 'fr'], scopes: ['mouse'] });
    if (requested.includes('keyboard')) choices.push({ label: { fr: 'Clavier uniquement', en: 'Keyboard only', ar: 'لوحة المفاتيح فقط' }[savedPreferences.language || 'fr'], scopes: ['keyboard'] });
    choices.forEach((choice) => options.push(choice.label));
    const denyIndex = options.length;
    options.push({ fr: 'Refuser', en: 'Decline', ar: 'رفض' }[savedPreferences.language || 'fr']);
    approvalDialogOpen = true;
    let result;
    try {
      result = await dialog.showMessageBox(mainWindow, {
        type: 'question',
        title: { fr: 'Demande de contrôle à distance', en: 'Remote control request', ar: 'طلب صلاحية التحكم' }[savedPreferences.language || 'fr'],
        message: { fr: 'La personne connectée demande le contrôle de cet appareil.', en: 'The connected person is requesting control of this device.', ar: 'الطرف المتصل يطلب التحكم في هذا الجهاز.' }[savedPreferences.language || 'fr'],
        detail: { fr: 'Choisissez les autorisations à accorder. Vous pouvez les révoquer à tout moment.', en: 'Choose which permissions to allow. You can revoke them at any time.', ar: 'اختار الصلاحيات اللي تسمح بها. تقدر توقفها فأي وقت.' }[savedPreferences.language || 'fr'],
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
        const display = screen.getAllDisplays().find((item) => String(item.id) === sharedDisplayId) || screen.getPrimaryDisplay();
        const x = Math.round((display.bounds.x + packet.x * Math.max(0, display.bounds.width - 1)) * display.scaleFactor);
        const y = Math.round((display.bounds.y + packet.y * Math.max(0, display.bounds.height - 1)) * display.scaleFactor);
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
      const language = savedPreferences.language || 'fr';
      const labels = {
        fr: { title: 'Partage d’écran', message: 'Choisissez l’écran que vous voulez partager avec la personne connectée.', detail: 'L’écran choisi ne sera visible qu’après votre accord. Arrêtez le partage depuis l’application ou avec le bouton de fin de session.', decline: 'Refuser', screen: 'Écran' },
        en: { title: 'Screen sharing', message: 'Choose which screen to share with the connected person.', detail: 'The selected screen is visible only after you approve. Stop sharing in the app or with the end session button.', decline: 'Decline', screen: 'Screen' },
        ar: { title: 'مشاركة الشاشة', message: 'اختار الشاشة اللي بغيتي تشارك مع الطرف المتصل.', detail: 'الشاشة المختارة غتبان غير من بعد الموافقة. تقدر توقف المشاركة من التطبيق أو زر إنهاء الجلسة.', decline: 'رفض', screen: 'شاشة' },
      }[language] || { title: 'Screen sharing', message: 'Choose which screen to share with the connected person.', detail: 'The selected screen is visible only after you approve. Stop sharing in the app or with the end session button.', decline: 'Decline', screen: 'Screen' };
      const screenButtons = sources.map((source, index) => `${index + 1}. ${source.name || `${labels.screen} ${index + 1}`}`);
      const declineIndex = screenButtons.length;
      const answer = await dialog.showMessageBox(mainWindow, {
        type: 'question',
        title: labels.title,
        message: labels.message,
        detail: labels.detail,
        buttons: [...screenButtons, labels.decline],
        defaultId: declineIndex,
        cancelId: declineIndex,
        noLink: true,
      });
      const selectedSource = answer.response >= 0 && answer.response < sources.length ? sources[answer.response] : null;
      if (!selectedSource) {
        sharedDisplayId = null;
        callback({});
        return;
      }
      sharedDisplayId = selectedSource.display_id || String(screen.getAllDisplays()[answer.response]?.id || '') || null;
      callback({ video: selectedSource, audio: 'none' });
    } catch { callback({}); }
  });

  registerControlHandlers();
  createWindow();
  setTimeout(() => void checkForUpdates(), 2500);
  setInterval(() => void checkForUpdates(), 6 * 60 * 60 * 1000);
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { void revokeControl(); if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { localServer?.close(); });
