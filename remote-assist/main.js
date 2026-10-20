const rtcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
const $ = (id) => document.getElementById(id);
let peer = null;
let screenStream = null;
let fileChannel = null;
let incomingFile = null;
let selectedFile = null;
let sessionCode = null;
let answerPoll = null;
let answerPollBusy = false;
let isHost = false;
let answerApplied = false;
let deviceIdentity = null;
let activeDeviceSessionId = null;
let guestDeviceSession = null;
let controlScopes = new Set();
let controlRequestPending = false;
const pressedRemoteButtons = new Set();
const pressedRemoteKeys = new Set();
let lastRemoteMoveAt = 0;
const maxFileSize = 100 * 1024 * 1024;
const settingDefaults = { quality: 'balanced', fps: '30', fit: 'fit', dark: false, language: 'ar', signalOrigin: '' };
let settings = { ...settingDefaults };
let signalOriginReady = Promise.resolve();

try {
  settings = { ...settingDefaults, ...JSON.parse(localStorage.getItem('sanad-settings') || '{}') };
  if (!['economy', 'balanced', 'high'].includes(settings.quality)) settings.quality = settingDefaults.quality;
  if (!['15', '30', '60'].includes(String(settings.fps))) settings.fps = settingDefaults.fps;
  if (!['fit', 'fill', 'native'].includes(settings.fit)) settings.fit = settingDefaults.fit;
  settings.dark = Boolean(settings.dark);
  settings.language = settings.language === 'fr' ? 'fr' : 'ar';
  settings.signalOrigin = typeof settings.signalOrigin === 'string' ? settings.signalOrigin : '';
} catch { settings = { ...settingDefaults }; }

function saveSettings() {
  try { localStorage.setItem('sanad-settings', JSON.stringify(settings)); } catch { /* Desktop preferences are saved by the main process. */ }
  if (window.sanadDesktop?.isDesktop) void window.sanadDesktop.savePreferences(settings).catch(() => {});
}

function captureConstraints() {
  const dimensions = settings.quality === 'economy' ? [1280, 720] : settings.quality === 'high' ? [2560, 1440] : [1920, 1080];
  const fps = Number(settings.fps);
  return { width: { ideal: dimensions[0] }, height: { ideal: dimensions[1] }, frameRate: { ideal: fps, max: fps } };
}

async function applyCaptureSettings() {
  const track = screenStream?.getVideoTracks()[0];
  if (!track?.applyConstraints) return;
  try { await track.applyConstraints(captureConstraints()); }
  catch { $('host-status').textContent = 'النظام ما قدرش يطبق هاد الجودة؛ مستمر بالجودة المتاحة.'; }
}

function applyViewSettings() {
  $('fit-select').value = settings.fit;
  $('video-wrap').classList.remove('fit-mode', 'fill-mode', 'native-mode');
  $('video-wrap').classList.add(`${settings.fit}-mode`);
  document.body.classList.toggle('dark-mode', settings.dark);
  $('quality-select').value = settings.quality;
  $('fps-select').value = String(settings.fps);
  $('dark-mode').checked = settings.dark;
  $('signal-origin').value = settings.signalOrigin;
  $('language-select').value = settings.language;
  applyLanguage();
  $('.signal-origin-setting').hidden = !window.sanadDesktop?.isDesktop;
  $('signal-origin-status').hidden = !window.sanadDesktop?.isDesktop;
}

const frenchText = new Map([
  ['اتصل وساعد عن بُعد', 'Assistance à distance'], ['أداة مستقلة ومجانية', 'Outil indépendant et gratuit'],
  ['الإعدادات', 'Paramètres'], ['غير متصل', 'Hors ligne'], ['مشاركة الشاشة بموافقتك', 'Partage d’écran avec votre accord'],
  ['خلي المساعدة توصل ليك،', 'Laissez-nous vous aider,'], ['فينما كنت.', 'où que vous soyez.'],
  ['ابدأ جلسة جديدة', 'Démarrer une session'], ['كيف تريد الاتصال؟', 'Comment souhaitez-vous vous connecter ?'],
  ['أنت تقدم المساعدة', 'Vous aidez quelqu’un'], ['شارك شاشتك', 'Partager votre écran'],
  ['ابدأ مشاركة الشاشة', 'Démarrer le partage d’écran'], ['أنت تتلقى المساعدة', 'Vous recevez de l’aide'],
  ['انضم إلى جلسة', 'Rejoindre une session'], ['رمز الجلسة', 'Code de session'],
  ['انضم للجلسة', 'Rejoindre la session'], ['معاينة الشاشة', 'Aperçu de l’écran'],
  ['نقل الملفات', 'Transfert de fichiers'], ['جودة الصورة', 'Qualité d’image'], ['معدل الإطارات', 'Fréquence d’images'],
  ['خادم الاتصال', 'Serveur de connexion'], ['المظهر الداكن', 'Mode sombre'], ['إعدادات الجلسة', 'Paramètres de session'],
  ['تم', 'Terminé'], ['التحكم في الجهاز', 'Contrôle de l’appareil'], ['طلب التحكم', 'Demander le contrôle'],
]);
function applyLanguage() {
  const isFrench = settings.language === 'fr';
  document.documentElement.lang = isFrench ? 'fr' : 'ar';
  document.documentElement.dir = isFrench ? 'ltr' : 'rtl';
  document.querySelectorAll('[data-ar]').forEach((element) => {
    const text = isFrench ? element.dataset.fr : element.dataset.ar;
    if (text) element.textContent = text;
  });
  if (isFrench) {
    for (const element of document.querySelectorAll('h1,h2,h3,.eyebrow,.card-kicker,button,label,summary,.nav-item,.sidebar-note strong')) {
      const original = element.dataset.ar || element.textContent.trim();
      if (!element.dataset.ar) element.dataset.ar = original;
      if (frenchText.has(original)) element.textContent = frenchText.get(original);
    }
  } else {
    for (const element of document.querySelectorAll('[data-ar]')) element.textContent = element.dataset.ar;
  }
}

function setStatus(message, connected = false) {
  $('connection-label').textContent = message;
  $('host-status').textContent = message;
  $('join-status').textContent = message;
  document.querySelector('.status-dot').style.background = connected ? '#45bf8a' : '#aeb8c6';
  $('live-label').textContent = connected ? 'اتصال نشط' : 'بانتظار المشاركة';
  document.querySelector('.live-badge').classList.toggle('is-live', connected);
}

function addTransfer(name, size, url, direction) {
  const row = document.createElement('div');
  row.className = 'file-row';
  const title = document.createElement('span');
  title.textContent = `${direction} · ${name}`;
  const meta = document.createElement('small');
  meta.textContent = formatBytes(size);
  row.append(title, meta);
  if (url) {
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.textContent = 'تنزيل';
    row.append(link);
  }
  const empty = document.querySelector('.empty-transfer');
  empty?.remove();
  $('transfer-list').prepend(row);
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} بايت`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} ك.ب`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} م.ب`;
}

function updateControlUi(scopes = [], message = '') {
  controlScopes = new Set(scopes);
  if (scopes.length || message) controlRequestPending = false;
  if (window.sanadDesktop?.isDesktop) {
    $('host-controls').hidden = false;
    $('host-control-status').textContent = scopes.length
      ? `مسموح للطرف الآخر: ${scopes.map((scope) => scope === 'mouse' ? 'الفأرة' : 'لوحة المفاتيح').join(' و')}.`
      : (message || 'التحكم غير مسموح.');
    $('revoke-control').hidden = scopes.length === 0;
  }
  if (!isHost) {
    $('viewer-controls').hidden = false;
    $('viewer-control-status').textContent = scopes.length
      ? `تم منح: ${scopes.map((scope) => scope === 'mouse' ? 'الفأرة' : 'لوحة المفاتيح').join(' و')}. اضغط على الشاشة البعيدة لإرسال الإدخال.`
      : (message || 'طلب الإذن من صاحب الجهاز لتبدأ.');
    $('request-control').disabled = scopes.length > 0 || controlRequestPending || !fileChannel || fileChannel.readyState !== 'open';
    $('request-control').textContent = scopes.length ? 'التحكم مفعّل' : controlRequestPending ? 'بانتظار موافقة صاحب الجهاز…' : 'طلب التحكم';
    $('remote-video').classList.toggle('remote-control-ready', scopes.includes('mouse') || scopes.includes('keyboard'));
  }
}

async function handleControlRequest(requestedScopes) {
  if (!window.sanadDesktop?.isDesktop) {
    fileChannel?.send(JSON.stringify({ type: 'control-status', scopes: [], reason: 'desktop-app-required' }));
    $('host-status').textContent = 'التحكم يحتاج إلى تطبيق سطح المكتب على الجهاز المضيف.';
    return;
  }
  $('host-control-status').textContent = 'بانتظار اختيارك للصلاحيات في نافذة التأكيد…';
  try {
    const result = await window.sanadDesktop.requestControl(requestedScopes);
    updateControlUi(result.scopes || [], result.reason === 'input-unavailable' ? 'محرك التحكم غير متاح على هذا الجهاز.' : 'التحكم غير مسموح.');
    fileChannel?.send(JSON.stringify({ type: 'control-status', scopes: result.scopes || [], reason: result.reason }));
  } catch {
    fileChannel?.send(JSON.stringify({ type: 'control-status', scopes: [], reason: 'input-unavailable' }));
  }
}

async function handleControlMessage(message) {
  if (message.type === 'control-request' && isHost) {
    await handleControlRequest(message.scopes);
  } else if (message.type === 'control-status' && !isHost) {
    if (message.reason === 'desktop-app-required') updateControlUi([], 'يلزم تطبيق سند لسطح المكتب على الجهاز المضيف.');
    else if (message.reason === 'input-unavailable') updateControlUi([], 'التحكم غير متاح على هذا الجهاز.');
    else updateControlUi(message.scopes || [], message.scopes?.length ? '' : 'لم يمنح صاحب الجهاز الصلاحية.');
  } else if (message.type === 'control-release' && isHost) {
    await window.sanadDesktop?.releaseInput();
  } else if (message.type === 'input' && isHost) {
    const result = await window.sanadDesktop?.applyInput(message.command);
    if (result?.reason === 'permission-denied') updateControlUi([], 'انتهت صلاحية التحكم.');
  }
}

function bindDataChannel(channel) {
  fileChannel = channel;
  fileChannel.binaryType = 'arraybuffer';
  fileChannel.onopen = () => {
    $('send-file').disabled = false;
    setStatus('متصل وجاهز لنقل الملفات', true);
    if (!isHost) updateControlUi([], 'يمكنك طلب إذن التحكم من صاحب الجهاز.');
  };
  fileChannel.onclose = () => {
    $('send-file').disabled = true;
    if (isHost) {
      void window.sanadDesktop?.revokeControl();
      if (activeDeviceSessionId) {
        void window.sanadDesktop?.unregisterDeviceSession();
        activeDeviceSessionId = null;
      }
      updateControlUi([], 'انتهت الجلسة وأُلغيت صلاحيات التحكم.');
    } else updateControlUi([], 'انتهت الجلسة.');
  };
  fileChannel.onmessage = async (event) => {
    if (typeof event.data === 'string') {
      try {
        const message = JSON.parse(event.data);
        if (message.type === 'file-start' && typeof message.name === 'string' && message.name.length <= 255 && Number.isSafeInteger(message.size) && message.size >= 0 && message.size <= maxFileSize) {
          incomingFile = { name: message.name, size: message.size, mime: message.mime, chunks: [], received: 0 };
          if (incomingFile.size === 0) finishIncomingFile();
        } else if (['control-request', 'control-status', 'control-release', 'input'].includes(message.type)) {
          await handleControlMessage(message);
        } else incomingFile = null;
      } catch { /* Ignore malformed peer data. */ }
      return;
    }
    if (!incomingFile) return;
    const chunk = event.data instanceof Blob ? event.data : new Blob([event.data]);
    incomingFile.chunks.push(chunk);
    incomingFile.received += chunk.size;
    if (incomingFile.received > incomingFile.size) { incomingFile = null; return; }
    if (incomingFile.received >= incomingFile.size) finishIncomingFile();
  };
}

function finishIncomingFile() {
  if (!incomingFile) return;
  const file = new Blob(incomingFile.chunks, { type: incomingFile.mime });
  const url = URL.createObjectURL(file);
  addTransfer(incomingFile.name, incomingFile.size, url, 'وصل');
  incomingFile = null;
}

function makePeer() {
  peer?.close();
  peer = new RTCPeerConnection(rtcConfig);
  peer.onconnectionstatechange = () => {
    const state = peer?.connectionState;
    if (state === 'connected') setStatus('اتصال نشط', true);
    else if (state === 'failed') setStatus('تعذر الاتصال. قد تحتاج الشبكة إلى خادم TURN.');
    else if (state === 'disconnected' || state === 'closed') setStatus('انقطع الاتصال.');
  };
  peer.ontrack = (event) => {
    const video = $('remote-video');
    video.srcObject = event.streams[0];
    video.classList.add('visible');
    $('video-placeholder').hidden = true;
    $('preview-title').textContent = 'الشاشة المشتركة';
    $('live-label').textContent = 'يصل البث';
    document.querySelector('.live-badge').classList.add('is-live');
    if (!isHost) {
      $('viewer-controls').hidden = false;
      updateControlUi([], 'يمكنك طلب إذن التحكم من صاحب الجهاز.');
    }
  };
  peer.ondatachannel = (event) => bindDataChannel(event.channel);
  return peer;
}

function waitForIce(pc) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(done, 10000);
    function done() {
      clearTimeout(timeout);
      pc.removeEventListener('icegatheringstatechange', check);
      resolve();
    }
    function check() { if (pc.iceGatheringState === 'complete') done(); }
    pc.addEventListener('icegatheringstatechange', check);
  });
}

function sendInput(command, scope) {
  if (isHost || !controlScopes.has(scope) || fileChannel?.readyState !== 'open') return false;
  fileChannel.send(JSON.stringify({ type: 'input', command }));
  return true;
}

function getVideoPoint(event) {
  const video = $('remote-video');
  const rect = video.getBoundingClientRect();
  if (!video.videoWidth || !video.videoHeight) return null;
  const scale = settings.fit === 'fill'
    ? Math.max(rect.width / video.videoWidth, rect.height / video.videoHeight)
    : Math.min(rect.width / video.videoWidth, rect.height / video.videoHeight);
  const width = video.videoWidth * scale;
  const height = video.videoHeight * scale;
  const left = rect.left + (rect.width - width) / 2;
  const top = rect.top + (rect.height - height) / 2;
  return {
    x: Math.max(0, Math.min(1, (event.clientX - left) / width)),
    y: Math.max(0, Math.min(1, (event.clientY - top) / height)),
  };
}

function nativeKeyForCode(code) {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return `Num${code.slice(5)}`;
  if (/^Numpad[0-9]$/.test(code)) return `NumPad${code.slice(6)}`;
  const map = {
    Escape: 'Escape', F1: 'F1', F2: 'F2', F3: 'F3', F4: 'F4', F5: 'F5', F6: 'F6', F7: 'F7', F8: 'F8', F9: 'F9', F10: 'F10', F11: 'F11', F12: 'F12',
    Backspace: 'Backspace', Insert: 'Insert', Home: 'Home', PageUp: 'PageUp', Delete: 'Delete', End: 'End', PageDown: 'PageDown', Tab: 'Tab', Enter: 'Return',
    CapsLock: 'CapsLock', ShiftLeft: 'LeftShift', ShiftRight: 'RightShift', ControlLeft: 'LeftControl', ControlRight: 'RightControl', AltLeft: 'LeftAlt', AltRight: 'RightAlt',
    MetaLeft: window.sanadDesktop?.platform === 'darwin' ? 'LeftCmd' : 'LeftWin', MetaRight: window.sanadDesktop?.platform === 'darwin' ? 'RightCmd' : 'RightWin',
    Space: 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
    Backquote: 'Grave', Minus: 'Minus', Equal: 'Equal', BracketLeft: 'LeftBracket', BracketRight: 'RightBracket', Backslash: 'Backslash',
    Semicolon: 'Semicolon', Quote: 'Quote', Comma: 'Comma', Period: 'Period', Slash: 'Slash',
  };
  return map[code] || null;
}

function requestPointerControl() {
  if (!fileChannel || fileChannel.readyState !== 'open') return;
  const scopes = [];
  if ($('request-mouse').checked) scopes.push('mouse');
  if ($('request-keyboard').checked) scopes.push('keyboard');
  if (!scopes.length) { updateControlUi([], 'اختر الفأرة أو لوحة المفاتيح أولًا.'); return; }
  controlRequestPending = true;
  updateControlUi([], 'تم إرسال الطلب. اختر الصلاحيات من الجهاز المضيف.');
  $('request-control').disabled = true;
  $('request-control').textContent = 'بانتظار موافقة صاحب الجهاز…';
  fileChannel.send(JSON.stringify({ type: 'control-request', scopes }));
}

async function api(path, options = {}) {
  if (window.sanadDesktop?.isDesktop) {
    await signalOriginReady;
    await window.sanadDesktop.setSignalOrigin(settings.signalOrigin).catch(() => {});
  }
  const response = await fetch(path, { cache: 'no-store', ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'تعذر إكمال طلب الاتصال.');
  return result;
}

function splitSessionCode(value) {
  const match = value.trim().match(/^([a-f0-9]{10})\.([A-Za-z0-9_-]{20,40})$/);
  if (!match) throw new Error('رمز الجلسة غير صالح. انسخه كاملًا من الجهاز المضيف.');
  return { id: match[1], secret: match[2] };
}

async function pollForAnswer() {
  if ((!sessionCode && !activeDeviceSessionId) || answerPollBusy || answerApplied) return;
  answerPollBusy = true;
  try {
    if (activeDeviceSessionId) {
      const result = await window.sanadDesktop.getDeviceAnswer();
      if (!result.ok) throw new Error(result.error || 'تعذر فحص طلب الاتصال.');
      if (result.answer && peer) {
        await peer.setRemoteDescription(result.answer);
        answerApplied = true;
        clearInterval(answerPoll);
        answerPoll = null;
        $('host-status').textContent = 'تم قبول الطرف الآخر. جارٍ الاتصال…';
      }
      return;
    }
    const { id, secret } = splitSessionCode(sessionCode);
    const result = await api(`/api/sessions/${id}/answer`, { headers: { 'X-Session-Key': secret } });
    if (result.answer && peer) {
      await peer.setRemoteDescription(result.answer);
      answerApplied = true;
      clearInterval(answerPoll);
      answerPoll = null;
      $('host-status').textContent = 'تم قبول الطرف الآخر. جارٍ الاتصال…';
    }
  } catch (error) {
    $('host-status').textContent = error.message;
    clearInterval(answerPoll);
    answerPoll = null;
  } finally {
    answerPollBusy = false;
  }
}
async function copyText(text, statusId) {
  try { await navigator.clipboard.writeText(text); $(statusId).textContent = 'تم نسخ الرمز. أرسله للطرف الآخر.'; }
  catch { $(statusId).textContent = 'تعذر النسخ تلقائيًا؛ حدّد الرمز وانسخه يدويًا.'; }
}

$('settings-open').addEventListener('click', () => $('settings-dialog').showModal());
$('quality-select').addEventListener('change', () => {
  settings.quality = $('quality-select').value;
  saveSettings();
  void applyCaptureSettings();
});
$('fps-select').addEventListener('change', () => {
  settings.fps = $('fps-select').value;
  saveSettings();
  void applyCaptureSettings();
});
$('fit-select').addEventListener('change', () => {
  settings.fit = $('fit-select').value;
  saveSettings();
  applyViewSettings();
});
$('dark-mode').addEventListener('change', () => {
  settings.dark = $('dark-mode').checked;
  saveSettings();
  applyViewSettings();
});
$('language-select').addEventListener('change', () => {
  settings.language = $('language-select').value === 'fr' ? 'fr' : 'ar';
  saveSettings();
  applyLanguage();
});
$('signal-origin').addEventListener('change', async () => {
  const value = $('signal-origin').value.trim();
  if (!value) {
    settings.signalOrigin = '';
    await window.sanadDesktop?.setSignalOrigin('');
    $('signal-origin-status').textContent = 'خليه فارغ للتشغيل المحلي.';
    saveSettings();
    return;
  }
  try {
    const parsed = new URL(value);
    const allowedPath = ['', '/', '/remote-assist', '/remote-assist/'].includes(parsed.pathname);
    if (!allowedPath || parsed.search || parsed.hash || parsed.username || parsed.password || !['https:', 'http:'].includes(parsed.protocol)) throw new Error('invalid-origin');
    if (parsed.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(parsed.hostname)) throw new Error('https-required');
    settings.signalOrigin = parsed.origin;
    $('signal-origin').value = settings.signalOrigin;
    const saved = await window.sanadDesktop?.setSignalOrigin(settings.signalOrigin);
    if (window.sanadDesktop?.isDesktop && !saved?.ok) throw new Error('save-failed');
    $('signal-origin-status').textContent = settings.signalOrigin ? `الخادم المشترك: ${settings.signalOrigin}` : 'خليه فارغ للتشغيل المحلي.';
    saveSettings();
  } catch {
    $('signal-origin-status').textContent = 'دخل رابط الموقع HTTPS، مع أو بلا /remote-assist/. المحلي مسموح للتجربة.';
  }
});
$('fullscreen-button').addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await $('video-wrap').requestFullscreen();
  } catch { $('join-status').textContent = 'تعذر تفعيل ملء الشاشة في هاد البيئة.'; }
});
document.addEventListener('fullscreenchange', () => {
  $('fullscreen-button').textContent = document.fullscreenElement ? '⤢ الخروج من ملء الشاشة' : '⛶ ملء الشاشة';
});
$('floating-window-button').disabled = !('pictureInPictureEnabled' in document) || !document.pictureInPictureEnabled;
$('remote-video').addEventListener('enterpictureinpicture', () => { $('floating-window-button').textContent = 'إغلاق النافذة العائمة'; });
$('remote-video').addEventListener('leavepictureinpicture', () => { $('floating-window-button').textContent = '▣ نافذة عائمة'; });
$('floating-window-button').addEventListener('click', async () => {
  const video = $('remote-video');
  try {
    if (document.pictureInPictureElement) await document.exitPictureInPicture();
    else if (video.readyState >= HTMLMediaElement.HAVE_METADATA) await video.requestPictureInPicture();
    else $('join-status').textContent = 'خاص الشاشة توصل قبل ما تفتح النافذة العائمة.';
  } catch { $('join-status').textContent = 'هاد النظام ما سمحش بفتح نافذة الشاشة العائمة.'; }
});
applyViewSettings();
if (window.sanadDesktop?.isDesktop) {
  signalOriginReady = Promise.all([window.sanadDesktop.getSignalOrigin(), window.sanadDesktop.getPreferences()]).then(([origin, preferences]) => {
    const localOrigin = settings.signalOrigin;
    settings = { ...settings, ...(preferences || {}) };
    settings.signalOrigin = origin || preferences?.signalOrigin || localOrigin || 'https://sanad.abouiba93.workers.dev';
    if (!origin && settings.signalOrigin) return window.sanadDesktop.setSignalOrigin(settings.signalOrigin).then(() => {
      saveSettings(); applyViewSettings();
      $('signal-origin-status').textContent = `الخادم المشترك: ${settings.signalOrigin}`;
    });
    saveSettings();
    applyViewSettings();
    $('signal-origin-status').textContent = origin ? `الخادم المشترك: ${origin}` : 'خليه فارغ للتشغيل المحلي.';
  }).catch(() => {});
  void window.sanadDesktop.getDeviceIdentity().then((identity) => {
    if (!identity?.ok) return;
    deviceIdentity = identity;
    $('device-id-output').value = identity.id;
    $('device-password-output').value = identity.password;
    $('device-session-block').hidden = false;
    $('host-status').textContent = 'المعرّف ثابت لهذا الجهاز. شغّل مشاركة الشاشة، ثم أعطِ المعرّف وكلمة المرور للشخص الموثوق.';
  }).catch(() => {});
}

$('start-session').addEventListener('click', async () => {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    setStatus('مشاركة الشاشة غير مدعومة هنا. افتح التطبيق في متصفح يدعمها عبر HTTPS أو localhost.');
    return;
  }
  try {
    $('start-session').disabled = true;
    setStatus('اختر الشاشة أو النافذة التي تريد مشاركتها…');
    screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    await applyCaptureSettings();
    $('remote-video').srcObject = screenStream;
    $('remote-video').classList.add('visible');
    $('video-placeholder').hidden = true;
    $('preview-title').textContent = 'معاينة شاشتك';
    const pc = makePeer();
    screenStream.getTracks().forEach((track) => {
      pc.addTrack(track, screenStream);
      track.addEventListener('ended', () => setStatus('أوقفت مشاركة الشاشة.'));
    });
    bindDataChannel(pc.createDataChannel('files'));
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIce(pc);
    isHost = true;
    answerApplied = false;
    if (window.sanadDesktop?.isDesktop) {
      if (!deviceIdentity) {
        deviceIdentity = await window.sanadDesktop.getDeviceIdentity();
        if (deviceIdentity?.ok) {
          $('device-id-output').value = deviceIdentity.id;
          $('device-password-output').value = deviceIdentity.password;
        }
      }
      if (!deviceIdentity?.ok) throw new Error(deviceIdentity?.error || 'تعذر تحميل معرّف هذا الجهاز. أعد تشغيل تطبيق سند.');
      const registration = await window.sanadDesktop.registerDeviceSession(pc.localDescription);
      if (!registration?.ok) throw new Error(registration?.error || 'تعذر تشغيل الاتصال بهذا الجهاز.');
      activeDeviceSessionId = registration.id;
      $('device-session-block').hidden = false;
      setStatus('مشاركة الشاشة تعمل. الجهاز ينتظر اتصال الطرف الآخر باستعمال المعرّف وكلمة المرور.');
    } else {
      const session = await api('/api/sessions', {
        method: 'POST',
        body: JSON.stringify({ offer: pc.localDescription }),
      });
      sessionCode = session.code;
      $('session-code-output').value = sessionCode;
      $('session-block').hidden = false;
    }
    $('end-session').hidden = false;
    if (!activeDeviceSessionId) setStatus('أرسل رمز الجلسة للطرف الآخر وانتظر الاتصال.');
    answerPoll = setInterval(pollForAnswer, 1200);
  } catch (error) {
    setStatus(error.name === 'NotAllowedError' ? 'ألغيت مشاركة الشاشة.' : `تعذر بدء المشاركة: ${error.message}`);
    peer?.close();
    peer = null;
    if (activeDeviceSessionId) await window.sanadDesktop?.unregisterDeviceSession().catch(() => {});
    activeDeviceSessionId = null;
    isHost = false;
    screenStream?.getTracks().forEach((track) => track.stop());
    screenStream = null;
    $('start-session').disabled = false;
  }
});

$('join-session').addEventListener('click', async () => {
  try {
    const { id, secret } = splitSessionCode($('session-code-input').value);
    sessionCode = $('session-code-input').value.trim();
    isHost = false;
    const pc = makePeer();
    $('join-session').disabled = true;
    $('join-status').textContent = 'جارٍ الاتصال بخدمة الإشارات…';
    const session = await api(`/api/sessions/${id}/offer`, { headers: { 'X-Session-Key': secret } });
    await pc.setRemoteDescription(session.offer);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await waitForIce(pc);
    await api(`/api/sessions/${id}/answer`, {
      method: 'POST',
      body: JSON.stringify({ secret, answer: pc.localDescription }),
    });
    $('end-session').hidden = false;
    $('join-status').textContent = 'أُرسل الرد. جارٍ إنشاء الاتصال المباشر…';
    $('preview-title').textContent = 'شاشة الطرف الآخر';
  } catch (error) {
    $('join-status').textContent = error.message || 'تعذر الانضمام إلى الجلسة.';
    peer?.close();
    peer = null;
    $('join-session').disabled = false;
  }
});

$('join-device-session').addEventListener('click', async () => {
  const id = $('device-id-input').value.trim().toLowerCase();
  const password = $('device-password-input').value;
  $('join-device-session').disabled = true;
  try {
    if (!/^[a-f0-9]{16}$/.test(id)) throw new Error('معرّف الجهاز خاصو يكون 16 رقم أو حرف سداسي عشري.');
    if (!password) throw new Error('دخل كلمة مرور الجهاز.');
    isHost = false;
    const connection = await api(`/api/devices/${id}/connect`, {
      method: 'POST',
      body: JSON.stringify({ password }),
    });
    guestDeviceSession = { id, secret: connection.secret };
    const pc = makePeer();
    $('device-join-status').textContent = 'تم التحقق من كلمة المرور. جارٍ إنشاء الاتصال…';
    await pc.setRemoteDescription(connection.offer);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await waitForIce(pc);
    await api(`/api/devices/${id}/answer`, {
      method: 'POST',
      body: JSON.stringify({ secret: connection.secret, answer: pc.localDescription }),
    });
    $('end-session').hidden = false;
    $('device-join-status').textContent = 'أُرسل الرد. انتظر اكتمال الاتصال مع الجهاز.';
    $('preview-title').textContent = 'شاشة الجهاز';
  } catch (error) {
    if (guestDeviceSession) {
      await api(`/api/devices/${guestDeviceSession.id}/connect`, {
        method: 'DELETE',
        headers: { 'X-Device-Session-Key': guestDeviceSession.secret },
      }).catch(() => {});
    }
    guestDeviceSession = null;
    $('device-join-status').textContent = error.message || 'تعذر الاتصال بهذا الجهاز.';
    peer?.close();
    peer = null;
    $('join-device-session').disabled = false;
  }
});

$('copy-session').addEventListener('click', () => copyText(sessionCode || '', 'host-status'));
$('copy-device-id').addEventListener('click', () => copyText(deviceIdentity?.id || $('device-id-output').value, 'host-status'));
$('copy-device-password').addEventListener('click', () => copyText(deviceIdentity?.password || $('device-password-output').value, 'host-status'));
$('device-password-toggle').addEventListener('click', () => {
  const field = $('device-password-output');
  field.type = field.type === 'password' ? 'text' : 'password';
  $('device-password-toggle').textContent = field.type === 'password' ? 'إظهار' : 'إخفاء';
});
$('request-control').addEventListener('click', requestPointerControl);
$('revoke-control').addEventListener('click', async () => {
  const result = await window.sanadDesktop?.revokeControl();
  updateControlUi(result?.scopes || [], 'أوقفتَ صلاحيات التحكم.');
  if (fileChannel?.readyState === 'open') fileChannel.send(JSON.stringify({ type: 'control-status', scopes: [], reason: 'revoked' }));
});

$('end-session').addEventListener('click', async () => {
  const priorCode = sessionCode;
  if (answerPoll) clearInterval(answerPoll);
  answerPoll = null;
  if (isHost) await window.sanadDesktop?.revokeControl();
  else if (fileChannel?.readyState === 'open') fileChannel.send(JSON.stringify({ type: 'control-release' }));
  if (isHost && activeDeviceSessionId) {
    await window.sanadDesktop?.unregisterDeviceSession();
  } else if (isHost && priorCode) {
    try {
      const { id, secret } = splitSessionCode(priorCode);
      await api(`/api/sessions/${id}`, { method: 'DELETE', headers: { 'X-Session-Key': secret } });
    } catch { /* The session may already have expired. */ }
  }
  if (guestDeviceSession) {
    await api(`/api/devices/${guestDeviceSession.id}/connect`, {
      method: 'DELETE',
      headers: { 'X-Device-Session-Key': guestDeviceSession.secret },
    }).catch(() => {});
    guestDeviceSession = null;
  }
  activeDeviceSessionId = null;
  peer?.close();
  peer = null;
  fileChannel = null;
  sessionCode = null;
  isHost = false;
  answerApplied = false;
  screenStream?.getTracks().forEach((track) => track.stop());
  if (document.pictureInPictureElement) await document.exitPictureInPicture().catch(() => {});
  screenStream = null;
  $('remote-video').srcObject = null;
  $('remote-video').classList.remove('visible');
  $('video-placeholder').hidden = false;
  $('preview-title').textContent = 'معاينة الشاشة';
  $('session-block').hidden = true;
  $('device-session-block').hidden = true;
  $('viewer-controls').hidden = true;
  $('host-controls').hidden = !window.sanadDesktop?.isDesktop;
  $('end-session').hidden = true;
  $('start-session').disabled = false;
  $('join-session').disabled = false;
  $('join-device-session').disabled = false;
  $('send-file').disabled = true;
  updateControlUi([], 'انتهت الجلسة.');
  setStatus('تم إنهاء الجلسة.');
});
$('file-input').addEventListener('change', (event) => {
  selectedFile = event.target.files?.[0] || null;
  $('send-file').textContent = selectedFile ? `إرسال ${selectedFile.name} ←` : 'إرسال الملف ←';
  $('send-file').disabled = !selectedFile || fileChannel?.readyState !== 'open';
});
$('send-file').addEventListener('click', async () => {
  if (!selectedFile || fileChannel?.readyState !== 'open') return;
  const file = selectedFile;
  if (file.size > maxFileSize) {
    setStatus(`الحد الأقصى لحجم الملف هو ${formatBytes(maxFileSize)}.`);
    return;
  }
  fileChannel.send(JSON.stringify({ type: 'file-start', name: file.name, size: file.size, mime: file.type || 'application/octet-stream' }));
  const chunkSize = 48 * 1024;
  for (let offset = 0; offset < file.size; offset += chunkSize) {
    while (fileChannel.bufferedAmount > 1024 * 1024) await new Promise((resolve) => setTimeout(resolve, 60));
    fileChannel.send(await file.slice(offset, offset + chunkSize).arrayBuffer());
  }
  addTransfer(file.name, file.size, null, 'أُرسل');
  selectedFile = null;
  $('file-input').value = '';
  $('send-file').textContent = 'إرسال الملف ←';
  $('send-file').disabled = true;
});

function mouseButtonName(button) { return button === 0 ? 'LEFT' : button === 1 ? 'MIDDLE' : button === 2 ? 'RIGHT' : null; }

$('remote-video').addEventListener('pointermove', (event) => {
  if (!controlScopes.has('mouse')) return;
  const now = performance.now();
  if (now - lastRemoteMoveAt < 24) return;
  lastRemoteMoveAt = now;
  const point = getVideoPoint(event);
  if (point) sendInput({ action: 'move', ...point }, 'mouse');
});
$('remote-video').addEventListener('pointerdown', (event) => {
  if (!controlScopes.has('mouse')) return;
  const button = mouseButtonName(event.button);
  if (!button) return;
  event.preventDefault();
  $('remote-video').focus();
  $('remote-video').setPointerCapture?.(event.pointerId);
  pressedRemoteButtons.add(button);
  const point = getVideoPoint(event);
  if (point) sendInput({ action: 'move', ...point }, 'mouse');
  sendInput({ action: 'button-down', button }, 'mouse');
});
window.addEventListener('pointerup', (event) => {
  const button = mouseButtonName(event.button);
  if (!button || !pressedRemoteButtons.has(button)) return;
  pressedRemoteButtons.delete(button);
  sendInput({ action: 'button-up', button }, 'mouse');
});
$('remote-video').addEventListener('contextmenu', (event) => {
  if (controlScopes.has('mouse')) event.preventDefault();
});
$('remote-video').addEventListener('wheel', (event) => {
  if (!controlScopes.has('mouse')) return;
  event.preventDefault();
  sendInput({ action: 'wheel', deltaY: Math.max(-500, Math.min(500, event.deltaY)) }, 'mouse');
}, { passive: false });
$('remote-video').addEventListener('keydown', (event) => {
  if (!controlScopes.has('keyboard')) return;
  if (event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) {
    event.preventDefault();
    sendInput({ action: 'text', value: event.key }, 'keyboard');
    return;
  }
  const key = nativeKeyForCode(event.code);
  if (!key || pressedRemoteKeys.has(key)) return;
  event.preventDefault();
  pressedRemoteKeys.add(key);
  sendInput({ action: 'key-down', key }, 'keyboard');
});
$('remote-video').addEventListener('keyup', (event) => {
  const key = nativeKeyForCode(event.code);
  if (!key || !pressedRemoteKeys.has(key)) return;
  event.preventDefault();
  pressedRemoteKeys.delete(key);
  sendInput({ action: 'key-up', key }, 'keyboard');
});
window.addEventListener('blur', () => {
  for (const key of pressedRemoteKeys) sendInput({ action: 'key-up', key }, 'keyboard');
  for (const button of pressedRemoteButtons) sendInput({ action: 'button-up', button }, 'mouse');
  pressedRemoteKeys.clear();
  pressedRemoteButtons.clear();
});

if (window.sanadDesktop?.isDesktop) {
  $('host-controls').hidden = false;
  $('.share-picker-note').hidden = true;
  $('host-control-status').textContent = 'التحكم غير مسموح. أي طلب سيظهر كتأكيد على هذا الجهاز.';
}

window.addEventListener('beforeunload', () => {
  if (answerPoll) clearInterval(answerPoll);
  if (isHost) void window.sanadDesktop?.revokeControl();
  else if (fileChannel?.readyState === 'open') fileChannel.send(JSON.stringify({ type: 'control-release' }));
  screenStream?.getTracks().forEach((track) => track.stop());
  peer?.close();
});
