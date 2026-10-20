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
const settingDefaults = { quality: 'balanced', fps: '30', fit: 'fit', dark: false, language: 'fr', signalOrigin: '' };
let settings = { ...settingDefaults };
let signalOriginReady = Promise.resolve();
const originalTextNodes = new WeakMap();
let languageObserver;
let detachedViewerWindow = null;
let detachedViewerReturnParent = null;
let detachedViewerReturnSibling = null;
let knownDevices = [];
let chatAllowed = false;
let chatEnabled = false;
const chatHistory = [];
const chatMessageTimes = [];

try {
  settings = { ...settingDefaults, ...JSON.parse(localStorage.getItem('sanad-settings') || '{}') };
  if (!['economy', 'balanced', 'high'].includes(settings.quality)) settings.quality = settingDefaults.quality;
  if (!['15', '30', '60'].includes(String(settings.fps))) settings.fps = settingDefaults.fps;
  if (!['fit', 'fill', 'native'].includes(settings.fit)) settings.fit = settingDefaults.fit;
  settings.dark = Boolean(settings.dark);
  const explicitLanguage = localStorage.getItem('sanad-language-choice');
  settings.language = ['fr', 'en', 'ar'].includes(explicitLanguage) ? explicitLanguage : 'fr';
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

const phraseTranslations = {
  'Téléassistance': ['Remote assistance', 'المساعدة عن بُعد'], 'Assistance à distance': ['Remote support', 'المساعدة عن بُعد'],
  'Cet appareil': ['This device', 'هذا الجهاز'], 'Transfert de fichiers': ['File transfer', 'نقل الملفات'],
  'Connexion sécurisée': ['Secure connection', 'اتصال آمن'], 'Le partage d’écran et le contrôle nécessitent votre autorisation.': ['Screen sharing and control require your permission.', 'مشاركة الشاشة والتحكم تتطلب موافقتك.'],
  'Version': ['Version', 'الإصدار'], 'Rechercher un appareil ou une session': ['Search for a device or session', 'ابحث عن جهاز أو جلسة'],
  'Déconnecté': ['Disconnected', 'غير متصل'], 'Paramètres': ['Settings', 'الإعدادات'], 'Assistance à distance simple, gratuite et sécurisée': ['Simple, free and secure remote support', 'مساعدة عن بُعد سهلة ومجانية وآمنة'],
  'Sanad · logiciel indépendant': ['Sanad · independent software', 'سند · برنامج مستقل'], 'ID et mot de passe': ['ID and password', 'المعرّف وكلمة المرور'], 'Code de session': ['Session code', 'رمز الجلسة'],
  'Autoriser le contrôle à distance': ['Allow remote control', 'السماح بالتحكم عن بُعد'], 'Partagez les informations de cet appareil avec une personne de confiance.': ['Share this device’s details with someone you trust.', 'شارك معلومات هذا الجهاز مع شخص تثق به.'],
  'Votre ID Sanad': ['Your Sanad ID', 'معرّف سند ديالك'], 'Mot de passe permanent': ['Permanent password', 'كلمة المرور الثابتة'],
  'Gardez Sanad ouvert. La connexion démarre quand vous autorisez le partage de votre écran.': ['Keep Sanad open. The connection starts when you allow screen sharing.', 'خلي سند خدام. الاتصال كيبدا ملي كتسمح بمشاركة الشاشة.'],
  'L’ID permanent est disponible dans l’application Sanad pour ordinateur.': ['A permanent ID is available in the Sanad desktop app.', 'المعرّف الثابت متوفر فتطبيق سند للحاسوب.'],
  'Partager cet écran': ['Share this screen', 'شارك هاد الشاشة'], 'Dans le navigateur, sélectionnez l’écran entier dans la fenêtre de partage pour éviter la barre du navigateur.': ['In your browser, select the entire screen in the sharing dialog to hide the browser bar.', 'فالمتصفح اختار الشاشة كاملة من نافذة المشاركة باش مايبانش شريط المتصفح.'],
  'Prêt à partager votre écran.': ['Ready to share your screen.', 'واجد تشارك الشاشة ديالك.'], 'Code de session à envoyer': ['Session code to send', 'رمز الجلسة للإرسال'],
  'Contrôler un appareil à distance': ['Control a remote device', 'التحكم فجهاز عن بُعد'], 'Saisissez l’ID et le mot de passe fournis par l’autre personne.': ['Enter the ID and password provided by the other person.', 'دخل المعرّف وكلمة المرور اللي عطاك الطرف الآخر.'],
  'ID de l’appareil': ['Device ID', 'معرّف الجهاز'], 'Mot de passe': ['Password', 'كلمة المرور'], 'Saisir l’ID Sanad': ['Enter the Sanad ID', 'دخل معرّف سند'], 'Saisir le mot de passe': ['Enter the password', 'دخل كلمة المرور'],
  'Se connecter': ['Connect', 'اتصل'], 'L’appareil distant doit être allumé et prêt à partager son écran.': ['The remote device must be on and ready to share its screen.', 'خاص الجهاز الآخر يكون خدام ومستعد يشارك الشاشة.'],
  'Rejoindre la session': ['Join session', 'انضم للجلسة'], 'Saisissez le code complet reçu de votre correspondant.': ['Enter the full code you received.', 'دخل الرمز الكامل اللي توصّلتي به.'],
  'Session en direct': ['Live session', 'جلسة مباشرة'], 'Aperçu de l’écran': ['Screen preview', 'معاينة الشاشة'], 'En attente': ['Waiting', 'في انتظار المشاركة'],
  'Terminer la session': ['End session', 'إنهاء الجلسة'], 'Affichage': ['Display', 'العرض'], 'Adapter à la fenêtre': ['Fit to window', 'ملاءمة النافذة'], 'Remplir la fenêtre': ['Fill window', 'ملء النافذة'], 'Taille réelle': ['Actual size', 'الحجم الأصلي'],
  'Fenêtre flottante': ['Separate window', 'نافذة مستقلة'], 'Fenêtre indépendante': ['Separate window', 'نافذة مستقلة'], '▣ Fenêtre indépendante': ['▣ Separate window', '▣ نافذة مستقلة'], '⛶ Plein écran': ['⛶ Full screen', '⛶ ملء الشاشة'], 'L’écran distant s’affichera ici': ['The remote screen will appear here', 'الشاشة البعيدة غادي تبان هنا'],
  'Démarrez un partage ou rejoignez une session active': ['Start sharing or join an active session', 'بدا المشاركة أو انضم لجلسة خدامة'], 'Autorisations de contrôle': ['Control permissions', 'صلاحيات التحكم'], 'Demandez l’autorisation à la personne devant l’appareil.': ['Ask the person at the device for permission.', 'طلب الإذن من الشخص اللي قدام الجهاز.'],
  'Souris': ['Mouse', 'الفأرة'], 'Clavier': ['Keyboard', 'لوحة المفاتيح'], 'Demander le contrôle': ['Request control', 'طلب التحكم'], 'Autorisations accordées': ['Granted permissions', 'الصلاحيات المسموحة'], 'Le contrôle est désactivé.': ['Control is disabled.', 'التحكم متوقف.'], 'Révoquer l’accès': ['Revoke access', 'إلغاء الصلاحية'],
  'Connexion directe chiffrée': ['Encrypted direct connection', 'اتصال مباشر ومشفّر'], 'Envoyez un fichier à l’appareil connecté. Taille maximale : 100 Mo.': ['Send a file to the connected device. Maximum size: 100 MB.', 'صيفط ملف للجهاز المتصل. الحجم الأقصى: 100 ميغا.'], 'Choisir un fichier': ['Choose a file', 'اختار ملف'], 'Envoyer le fichier': ['Send file', 'إرسال الملف'], 'Aucun fichier transféré': ['No files transferred', 'مازال ما تنقل حتى ملف'], '⇅ Aucun fichier transféré': ['⇅ No files transferred', '⇅ مازال ما تنقل حتى ملف'],
  'Sanad est un logiciel indépendant.': ['Sanad is independent software.', 'سند برنامج مستقل.'], 'Ne communiquez vos codes qu’aux personnes de confiance.': ['Share your codes only with people you trust.', 'شارك الرموز غير مع الناس اللي كتق فيهم.'], 'Préférences Sanad': ['Sanad preferences', 'إعدادات سند'],
  'Ces réglages sont enregistrés sur cet appareil.': ['These settings are saved on this device.', 'هاد الإعدادات كتتحفظ فهاد الجهاز.'], 'Langue': ['Language', 'اللغة'], 'Choisissez la langue de l’application.': ['Choose the application language.', 'اختار لغة التطبيق.'], 'Qualité d’image': ['Image quality', 'جودة الصورة'], 'Une qualité supérieure utilise plus de données.': ['Higher quality uses more data.', 'الجودة العالية كتستهلك إنترنت أكثر.'], 'Équilibrée · recommandée': ['Balanced · recommended', 'متوازنة · موصى بها'], 'Élevée': ['High', 'عالية'], 'Économique': ['Economy', 'اقتصادية'], 'Fréquence d’images': ['Frame rate', 'معدل الإطارات'], '15 images/s': ['15 frames/s', '15 إطار/ث'], '30 images/s': ['30 frames/s', '30 إطار/ث'], '60 images/s': ['60 frames/s', '60 إطار/ث'], 'Une fréquence élevée rend les mouvements plus fluides.': ['A higher frame rate makes motion smoother.', 'المعدل العالي كيعطي حركة أنعم.'], 'Serveur de connexion': ['Connection server', 'خادم الاتصال'], 'Collez l’adresse du site, avec ou sans /remote-assist/.': ['Paste the site address, with or without /remote-assist/.', 'لصق رابط الموقع مع أو بلا /remote-assist/.'], 'Le serveur par défaut est utilisé.': ['The default server is in use.', 'الخادم الافتراضي هو المستعمل.'], 'Mode sombre': ['Dark mode', 'الوضع الداكن'], 'Modifier l’apparence de l’application.': ['Change the app appearance.', 'بدل مظهر التطبيق.'], 'Le partage d’écran et le contrôle restent soumis à l’autorisation de la personne devant l’appareil.': ['Screen sharing and control still require approval from the person at the device.', 'مشاركة الشاشة والتحكم باقيين بموافقة صاحب الجهاز.'], 'Terminé': ['Done', 'تم'], 'Afficher le mot de passe': ['Show password', 'إظهار كلمة المرور'], 'Masquer le mot de passe': ['Hide password', 'إخفاء كلمة المرور'], 'Afficher': ['Show', 'إظهار'], 'Masquer': ['Hide', 'إخفاء'],
  'Appareils connus': ['Known devices', 'الأجهزة المعروفة'],
  'Retrouvez vos appareils récents. Les mots de passe ne sont jamais enregistrés ici.': ['Find your recent devices. Passwords are never saved here.', 'لقا الأجهزة اللي استعملتي مؤخراً. كلمات السر ما كتتحفظش هنا.'],
  'Nom de l’appareil': ['Device name', 'اسم الجهاز'], 'Nom (ex. : Bureau)': ['Name (e.g. Office)', 'الاسم (مثال: المكتب)'],
  'Enregistrer l’ID saisi': ['Save entered ID', 'حفظ المعرّف المدخل'], 'Aucun appareil enregistré pour le moment.': ['No devices saved yet.', 'مازال ما تسجل حتى جهاز.'],
  'Récemment utilisé': ['Recently used', 'استُعمل مؤخراً'], 'Favori': ['Favorite', 'مفضّل'], 'Utiliser': ['Use', 'استعمال'], 'Supprimer': ['Remove', 'حذف'],
  'Saisissez d’abord un ID d’appareil valide.': ['Enter a valid device ID first.', 'دخل معرّف جهاز صحيح أولا.'],
  'Appareil enregistré. Le mot de passe reste uniquement dans votre saisie.': ['Device saved. The password stays only in your input.', 'تسجل الجهاز. كلمة السر كتبقى غير فخانة الإدخال.'],
  'ID ajouté aux appareils récents.': ['ID added to recent devices.', 'تزاد المعرّف للأجهزة الأخيرة.'],
  'Conversation de session': ['Session conversation', 'محادثة الجلسة'], 'Discussion': ['Chat', 'الدردشة'],
  'La discussion attend l’autorisation de l’hôte.': ['Chat is waiting for the host’s permission.', 'الدردشة كتسنى موافقة المضيف.'],
  'Autoriser la discussion': ['Allow chat', 'السماح بالدردشة'], 'Désactiver la discussion': ['Disable chat', 'إيقاف الدردشة'],
  'Votre message': ['Your message', 'رسالتك'], 'Écrire un message…': ['Write a message…', 'كتب رسالة…'], 'Envoyer': ['Send', 'إرسال'],
  'L’hôte a autorisé la discussion.': ['The host enabled chat.', 'المضيف سمح بالدردشة.'],
  'L’hôte a désactivé la discussion.': ['The host disabled chat.', 'المضيف وقف الدردشة.'],
  'Vous': ['You', 'أنت'], 'Correspondant': ['Partner', 'الطرف الآخر'],
};

const runtimeTranslations = {
  'تم تغيير كلمة المرور. أرسل الجديدة للشخص الموثوق فقط.': ['Mot de passe changé. Communiquez le nouveau mot de passe uniquement à une personne de confiance.', 'Password changed. Share the new password only with someone you trust.'],
  'تعذر تغيير كلمة المرور.': ['Impossible de changer le mot de passe.', 'Could not change the password.'],
  'أوقف مشاركة الشاشة قبل تغيير كلمة المرور.': ['Arrêtez le partage d’écran avant de changer le mot de passe.', 'Stop screen sharing before changing the password.'],
  'اتصال نشط': ['Connecté', 'Connected'], 'بانتظار المشاركة': ['En attente', 'Waiting'], 'متصل وجاهز لنقل الملفات': ['Connecté, prêt au transfert de fichiers', 'Connected and ready to transfer files'],
  'النظام ما قدرش يطبق هاد الجودة؛ مستمر بالجودة المتاحة.': ['Impossible d’appliquer cette qualité ; la qualité disponible est conservée.', 'Could not apply this quality; continuing with the available quality.'],
  'التحكم يحتاج إلى تطبيق سطح المكتب على الجهاز المضيف.': ['Le contrôle nécessite l’application Sanad sur l’appareil hôte.', 'Control requires the Sanad desktop app on the host device.'], 'بانتظار اختيارك للصلاحيات في نافذة التأكيد…': ['En attente de votre choix dans la fenêtre d’autorisation…', 'Waiting for your choice in the permission dialog…'], 'الشاشة المشتركة': ['Écran partagé', 'Shared screen'], 'يصل البث': ['Flux en cours de réception', 'Stream arriving'],
  'التحكم مفعّل': ['Contrôle activé', 'Control enabled'], 'بانتظار موافقة صاحب الجهاز…': ['En attente de l’autorisation du propriétaire…', 'Waiting for the device owner’s approval…'], 'طلب التحكم': ['Demander le contrôle', 'Request control'], 'تم قبول الطرف الآخر. جارٍ الاتصال…': ['Demande acceptée. Connexion en cours…', 'Request accepted. Connecting…'], 'تم نسخ الرمز. أرسله للطرف الآخر.': ['Code copié. Envoyez-le à votre correspondant.', 'Code copied. Send it to the other person.'], 'تعذر النسخ تلقائيًا؛ حدّد الرمز وانسخه يدويًا.': ['Copie automatique impossible ; sélectionnez et copiez le code.', 'Could not copy automatically; select and copy the code.'],
  'خليه فارغ للتشغيل المحلي.': ['Laissez vide pour une utilisation locale.', 'Leave blank for local use.'], 'تعذر تفعيل ملء الشاشة في هاد البيئة.': ['Le plein écran n’est pas disponible dans cet environnement.', 'Full screen is unavailable in this environment.'], 'خاص الشاشة توصل قبل ما تفتح النافذة العائمة.': ['Attendez la réception de l’écran avant d’ouvrir la fenêtre flottante.', 'Wait for the screen before opening the floating window.'], 'هاد النظام ما سمحش بفتح نافذة الشاشة العائمة.': ['Ce système ne permet pas la fenêtre flottante.', 'This system does not allow a floating window.'], 'التحكم غير مسموح. أي طلب سيظهر كتأكيد على هذا الجهاز.': ['Le contrôle est désactivé. Toute demande devra être confirmée sur cet appareil.', 'Control is disabled. Requests must be approved on this device.'],
  'المعرّف ثابت لهذا الجهاز. شغّل مشاركة الشاشة، ثم أعطِ المعرّف وكلمة المرور للشخص الموثوق.': ['Cet ID est permanent. Démarrez le partage d’écran, puis communiquez l’ID et le mot de passe à une personne de confiance.', 'This ID is permanent. Start screen sharing, then give the ID and password to someone you trust.'],
  'اختر الشاشة أو النافذة التي تريد مشاركتها…': ['Choisissez l’écran ou la fenêtre à partager…', 'Choose the screen or window to share…'], 'أرسل رمز الجلسة للطرف الآخر وانتظر الاتصال.': ['Envoyez le code de session et attendez la connexion.', 'Send the session code and wait for the connection.'], 'تم إنهاء الجلسة.': ['Session terminée.', 'Session ended.'], 'أوقفت مشاركة الشاشة.': ['Vous avez arrêté le partage d’écran.', 'You stopped screen sharing.'], 'أُرسل الرد. جارٍ إنشاء الاتصال المباشر…': ['Réponse envoyée. Connexion directe en cours…', 'Reply sent. Establishing direct connection…'], 'جارٍ الاتصال بخدمة الإشارات…': ['Connexion au service de signalisation…', 'Connecting to the signaling service…'], 'أُرسل الرد. انتظر اكتمال الاتصال مع الجهاز.': ['Réponse envoyée. Attendez la connexion à l’appareil.', 'Reply sent. Waiting for the device connection.'], 'تم التحقق من كلمة المرور. جارٍ إنشاء الاتصال…': ['Mot de passe vérifié. Connexion en cours…', 'Password verified. Connecting…'],
  'التحكم غير مسموح.': ['Le contrôle n’est pas autorisé.', 'Control is not allowed.'], 'إيقاف التحكم': ['Arrêter le contrôle', 'Stop control'], 'تنزيل': ['Télécharger', 'Download'], 'أُرسل': ['Envoyé', 'Sent'], 'استُقبل': ['Reçu', 'Received'],
  'تعذر الاتصال. قد تحتاج الشبكة إلى خادم TURN.': ['Connexion impossible. Le réseau peut nécessiter un serveur TURN.', 'Could not connect. The network may require a TURN server.'], 'انقطع الاتصال.': ['Connexion interrompue.', 'Connection lost.'], 'رمز الجلسة غير صالح. انسخه كاملًا من الجهاز المضيف.': ['Code de session invalide. Copiez-le en entier depuis l’appareil hôte.', 'Invalid session code. Copy the full code from the host device.'],
  'تعذر تفعيل ملء الشاشة في هاد البيئة.': ['Le plein écran n’est pas disponible dans cet environnement.', 'Full screen is unavailable in this environment.'], 'تعذر الانضمام إلى الجلسة.': ['Impossible de rejoindre la session.', 'Could not join the session.'], 'معرّف الجهاز خاصو يكون 16 رقم أو حرف سداسي عشري.': ['L’ID de l’appareil doit contenir 16 caractères hexadécimaux.', 'The device ID must contain 16 hexadecimal characters.'], 'دخل كلمة مرور الجهاز.': ['Saisissez le mot de passe de l’appareil.', 'Enter the device password.'],
};

function translatePhrase(source, language) {
  if (!source) return source;
  if (runtimeTranslations[source]) {
    if (language === 'fr') return runtimeTranslations[source][0];
    if (language === 'en') return runtimeTranslations[source][1];
    return source;
  }
  if (language === 'fr') return source;
  return phraseTranslations[source]?.[language === 'en' ? 0 : 1] || source;
}

function applyLanguage() {
  const language = settings.language;
  document.documentElement.lang = language;
  document.documentElement.dir = language === 'ar' ? 'rtl' : 'ltr';
  const translateNode = (node) => {
    if (!originalTextNodes.has(node)) originalTextNodes.set(node, node.nodeValue);
    const source = originalTextNodes.get(node);
    const clean = source.trim();
    if (!clean) return;
    const translated = translatePhrase(clean, language);
    const value = source.replace(clean, translated);
    if (node.nodeValue !== value) node.nodeValue = value;
  };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) translateNode(walker.currentNode);
  languageObserver?.disconnect();
  languageObserver = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'characterData') translateNode(record.target);
      for (const node of record.addedNodes || []) {
        if (node.nodeType === Node.TEXT_NODE) translateNode(node);
        else if (node.nodeType === Node.ELEMENT_NODE) {
          const childWalker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
          while (childWalker.nextNode()) translateNode(childWalker.currentNode);
        }
      }
    }
  });
  languageObserver.observe(document.body, { subtree: true, childList: true, characterData: true });
  const placeholders = { fr: 'Ex. : a1b2c3d4.ABCD…', en: 'Example: a1b2c3d4.ABCD…', ar: 'مثال: a1b2c3d4.ABCD…' };
  $('session-code-input').placeholder = placeholders[language];
  $('known-device-alias').placeholder = localized('Nom (ex. : Bureau)', 'Name (e.g. Office)', 'الاسم (مثال: المكتب)');
  $('chat-input').placeholder = localized('Écrire un message…', 'Write a message…', 'كتب رسالة…');
  $('workspace-search').placeholder = translatePhrase('Rechercher un appareil ou une session', language);
  $('workspace-search').setAttribute('aria-label', $('workspace-search').placeholder);
  const attributeLabels = {
    'settings-open': { 'aria-label': ['Paramètres', 'Settings', 'الإعدادات'], title: ['Paramètres', 'Settings', 'الإعدادات'] },
    'device-id-output': { 'aria-label': ['ID Sanad de cet appareil', 'Sanad ID for this device', 'معرّف سند لهذا الجهاز'] },
    'device-password-output': { 'aria-label': ['Mot de passe permanent', 'Permanent password', 'كلمة المرور الثابتة'] },
    'copy-device-id': { 'aria-label': ['Copier l’ID', 'Copy ID', 'نسخ المعرّف'], title: ['Copier l’ID', 'Copy ID', 'نسخ المعرّف'] },
    'copy-device-password': { 'aria-label': ['Copier le mot de passe', 'Copy password', 'نسخ كلمة المرور'], title: ['Copier le mot de passe', 'Copy password', 'نسخ كلمة المرور'] },
    'regenerate-device-password': { 'aria-label': ['Régénérer le mot de passe', 'Regenerate password', 'تغيير كلمة المرور'], title: ['Régénérer le mot de passe', 'Regenerate password', 'تغيير كلمة المرور'] },
    'copy-session': { 'aria-label': ['Copier le code de session', 'Copy session code', 'نسخ رمز الجلسة'] },
  };
  const languageIndex = { fr: 0, en: 1, ar: 2 }[language];
  for (const [id, attributes] of Object.entries(attributeLabels)) {
    for (const [attribute, values] of Object.entries(attributes)) $(id).setAttribute(attribute, values[languageIndex]);
  }
  refreshDetachedViewerLabels();
  renderKnownDevices();
  updateChatUi();
  renderChatHistory();
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
    $('send-file').disabled = !selectedFile;
    $('chat-panel').hidden = false;
    $('chat-permission-toggle').hidden = !isHost;
    chatAllowed = false;
    chatEnabled = false;
    chatHistory.length = 0;
    chatMessageTimes.length = 0;
    $('chat-messages').replaceChildren();
    $('chat-status').textContent = localized('La discussion attend l’autorisation de l’hôte.', 'Chat is waiting for the host’s permission.', 'الدردشة كتسنى موافقة المضيف.');
    updateChatUi();
    setStatus('متصل وجاهز لنقل الملفات', true);
    if (!isHost) updateControlUi([], 'يمكنك طلب إذن التحكم من صاحب الجهاز.');
  };
  fileChannel.onclose = () => {
    $('send-file').disabled = true;
    $('chat-panel').hidden = true;
    chatAllowed = false;
    chatEnabled = false;
    chatHistory.length = 0;
    chatMessageTimes.length = 0;
    $('chat-messages').replaceChildren();
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
        } else if (message.type === 'chat-status' && !isHost && typeof message.enabled === 'boolean') {
          chatEnabled = message.enabled;
          $('chat-status').textContent = localized(message.enabled ? 'L’hôte a autorisé la discussion.' : 'L’hôte a désactivé la discussion.', message.enabled ? 'The host enabled chat.' : 'The host disabled chat.', message.enabled ? 'المضيف سمح بالدردشة.' : 'المضيف وقف الدردشة.');
          updateChatUi();
        } else if (message.type === 'chat' && typeof message.text === 'string' && message.text.length > 0 && message.text.length <= 1000) {
          if (((isHost && chatAllowed) || (!isHost && chatEnabled)) && acceptChatMessage()) appendChatMessage(message.text, false);
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
    if (state === 'connected') {
      setStatus('اتصال نشط', true);
      if (!isHost && guestDeviceSession?.id) rememberDevice(guestDeviceSession.id, { used: true });
    }
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
  settings.language = ['fr', 'en', 'ar'].includes($('language-select').value) ? $('language-select').value : 'fr';
  try { localStorage.setItem('sanad-language-choice', settings.language); } catch { /* Desktop preferences are saved by the main process. */ }
  saveSettings();
  applyLanguage();
});
document.querySelectorAll('[data-connection-mode]').forEach((tab) => {
  tab.addEventListener('click', () => {
    const mode = tab.dataset.connectionMode;
    document.querySelectorAll('[data-connection-mode]').forEach((item) => {
      const active = item === tab;
      item.classList.toggle('active', active);
      item.setAttribute('aria-selected', String(active));
    });
    document.querySelectorAll('[data-mode-section]').forEach((section) => {
      section.hidden = section.dataset.modeSection !== mode;
    });
  });
});
$('workspace-search').addEventListener('input', () => {
  const value = $('workspace-search').value.trim();
  if (!value) return;
  const isSession = value.includes('.') || /[^a-f\d]/i.test(value);
  const tab = document.querySelector(`[data-connection-mode="${isSession ? 'session' : 'device'}"]`);
  tab?.click();
  $(isSession ? 'session-code-input' : 'device-id-input').value = value;
});
$('workspace-search').addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  const isSession = $('workspace-search').value.includes('.');
  $(isSession ? 'join-session' : 'join-device-session').click();
});
for (const [fieldId, buttonId] of [['session-code-input', 'join-session'], ['device-id-input', 'join-device-session'], ['device-password-input', 'join-device-session']]) {
  $(fieldId).addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); $(buttonId).click(); }
  });
}
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
function localized(fr, en, ar) { return ({ fr, en, ar })[settings.language] || fr; }

function loadKnownDevices() {
  try {
    const stored = JSON.parse(localStorage.getItem('sanad-known-devices') || '[]');
    if (!Array.isArray(stored)) return [];
    return stored.filter((item) => item && typeof item.id === 'string' && /^[a-f0-9]{16}$/.test(item.id)
      && (typeof item.alias === 'string' || item.alias === '') && typeof item.favorite === 'boolean')
      .map((item) => ({ id: item.id, alias: (item.alias || item.id).slice(0, 48), favorite: item.favorite, lastUsed: Number.isFinite(item.lastUsed) ? item.lastUsed : 0 }))
      .slice(0, 16);
  } catch { return []; }
}

function persistKnownDevices() {
  try { localStorage.setItem('sanad-known-devices', JSON.stringify(knownDevices.slice(0, 16))); }
  catch { /* The list is a convenience; connection still works when storage is unavailable. */ }
}

function rememberDevice(id, { alias, favorite, used = false } = {}) {
  if (typeof id !== 'string' || !/^[a-f0-9]{16}$/.test(id)) return;
  const existing = knownDevices.find((device) => device.id === id);
  const next = {
    id,
    alias: typeof alias === 'string' && alias.trim() ? alias.trim().slice(0, 48) : existing?.alias || id,
    favorite: typeof favorite === 'boolean' ? favorite : existing?.favorite || false,
    lastUsed: used ? Date.now() : existing?.lastUsed || 0,
  };
  knownDevices = [next, ...knownDevices.filter((device) => device.id !== id)];
  while (knownDevices.length > 16) {
    const candidates = knownDevices.some((device) => !device.favorite)
      ? knownDevices.filter((device) => !device.favorite)
      : knownDevices;
    const oldest = [...candidates].sort((a, b) => a.lastUsed - b.lastUsed)[0];
    knownDevices = knownDevices.filter((device) => device.id !== oldest.id);
  }
  persistKnownDevices();
  renderKnownDevices();
}

function renderKnownDevices() {
  const list = $('known-device-list');
  if (!list) return;
  const ordered = [...knownDevices].sort((a, b) => Number(b.favorite) - Number(a.favorite) || b.lastUsed - a.lastUsed);
  $('known-device-count').textContent = String(ordered.length);
  list.replaceChildren();
  if (!ordered.length) {
    const empty = document.createElement('p');
    empty.className = 'known-device-empty';
    empty.textContent = localized('Aucun appareil enregistré pour le moment.', 'No devices saved yet.', 'مازال ما تسجل حتى جهاز.');
    list.append(empty);
    return;
  }
  for (const device of ordered) {
    const row = document.createElement('div');
    row.className = 'known-device-row';
    const identity = document.createElement('div');
    identity.className = 'known-device-identity';
    const name = document.createElement('strong');
    name.textContent = device.alias || device.id;
    const identifier = document.createElement('small');
    identifier.textContent = device.id;
    identity.append(name, identifier);

    const actions = document.createElement('div');
    actions.className = 'known-device-actions';
    const use = document.createElement('button');
    use.type = 'button';
    use.className = 'known-device-use';
    use.dataset.knownAction = 'use';
    use.dataset.deviceId = device.id;
    use.textContent = localized('Utiliser', 'Use', 'استعمال');
    const favoriteButton = document.createElement('button');
    favoriteButton.type = 'button';
    favoriteButton.className = 'known-device-icon';
    favoriteButton.dataset.knownAction = 'favorite';
    favoriteButton.dataset.deviceId = device.id;
    favoriteButton.setAttribute('aria-pressed', String(device.favorite));
    favoriteButton.setAttribute('aria-label', device.favorite ? localized('Retirer des favoris', 'Remove from favorites', 'حيد من المفضّلة') : localized('Ajouter aux favoris', 'Add to favorites', 'زيد للمفضّلة'));
    favoriteButton.title = favoriteButton.getAttribute('aria-label');
    favoriteButton.textContent = device.favorite ? '★' : '☆';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'known-device-icon';
    remove.dataset.knownAction = 'remove';
    remove.dataset.deviceId = device.id;
    remove.setAttribute('aria-label', localized('Supprimer', 'Remove', 'حذف'));
    remove.title = remove.getAttribute('aria-label');
    remove.textContent = '×';
    actions.append(use, favoriteButton, remove);
    row.append(identity, actions);
    list.append(row);
  }
}

function updateChatUi() {
  const allowed = isHost ? chatAllowed : chatEnabled;
  $('chat-input').disabled = !allowed;
  $('chat-send').disabled = !allowed;
  $('chat-permission-toggle').setAttribute('aria-pressed', String(chatAllowed));
  $('chat-permission-toggle').textContent = chatAllowed
    ? localized('Désactiver la discussion', 'Disable chat', 'إيقاف الدردشة')
    : localized('Autoriser la discussion', 'Allow chat', 'السماح بالدردشة');
  $('chat-status').textContent = isHost
    ? localized(chatAllowed ? 'Discussion activée.' : 'La discussion attend l’autorisation de l’hôte.', chatAllowed ? 'Chat enabled.' : 'Chat is waiting for the host’s permission.', chatAllowed ? 'الدردشة مفعّلة.' : 'الدردشة كتسنى موافقة المضيف.')
    : localized(chatEnabled ? 'L’hôte a autorisé la discussion.' : 'La discussion attend l’autorisation de l’hôte.', chatEnabled ? 'The host enabled chat.' : 'Chat is waiting for the host’s permission.', chatEnabled ? 'المضيف سمح بالدردشة.' : 'الدردشة كتسنى موافقة المضيف.');
}

function renderChatHistory() {
  const list = $('chat-messages');
  list.replaceChildren();
  for (const message of chatHistory) {
    const entry = document.createElement('article');
    entry.className = `chat-message ${message.sentByLocalUser ? 'is-local' : 'is-remote'}`;
    const author = document.createElement('strong');
    author.textContent = localized(message.sentByLocalUser ? 'Vous' : 'Correspondant', message.sentByLocalUser ? 'You' : 'Partner', message.sentByLocalUser ? 'أنت' : 'الطرف الآخر');
    const body = document.createElement('p');
    body.textContent = message.text;
    entry.append(author, body);
    list.append(entry);
  }
  list.scrollTop = list.scrollHeight;
}

function appendChatMessage(text, sentByLocalUser) {
  const value = text.trim().slice(0, 1000);
  if (!value) return;
  chatHistory.push({ text: value, sentByLocalUser });
  if (chatHistory.length > 100) chatHistory.shift();
  renderChatHistory();
}

function acceptChatMessage() {
  const now = Date.now();
  while (chatMessageTimes.length && now - chatMessageTimes[0] >= 5000) chatMessageTimes.shift();
  if (chatMessageTimes.length >= 30) return false;
  chatMessageTimes.push(now);
  return true;
}

function refreshDetachedViewerLabels() {
  if (!detachedViewerWindow || detachedViewerWindow.closed) return;
  const viewerDocument = detachedViewerWindow.document;
  const title = viewerDocument.getElementById('detached-viewer-title');
  const fullscreen = viewerDocument.getElementById('detached-viewer-fullscreen');
  if (title) title.textContent = localized('Écran partagé · Sanad', 'Shared screen · Sanad', 'الشاشة المشتركة · سند');
  if (fullscreen) fullscreen.textContent = viewerDocument.fullscreenElement
    ? localized('⤢ Quitter le plein écran', '⤢ Exit full screen', '⤢ الخروج من ملء الشاشة')
    : localized('⛶ Plein écran', '⛶ Full screen', '⛶ ملء الشاشة');
}

function restoreDetachedViewer() {
  const videoWrap = $('video-wrap');
  if (detachedViewerReturnParent && videoWrap.parentElement !== detachedViewerReturnParent) {
    const sibling = detachedViewerReturnSibling?.parentElement === detachedViewerReturnParent ? detachedViewerReturnSibling : null;
    detachedViewerReturnParent.insertBefore(videoWrap, sibling);
  }
  videoWrap.classList.remove('detached-mode');
  detachedViewerWindow = null;
  detachedViewerReturnParent = null;
  detachedViewerReturnSibling = null;
  $('floating-window-button').textContent = localized('▣ Fenêtre indépendante', '▣ Separate window', '▣ نافذة مستقلة');
}

async function toggleDetachedViewerFullscreen(viewerDocument) {
  if (viewerDocument.fullscreenElement) await viewerDocument.exitFullscreen();
  else await viewerDocument.documentElement.requestFullscreen();
}

async function openDetachedViewer() {
  if (detachedViewerWindow && !detachedViewerWindow.closed) {
    detachedViewerWindow.focus();
    return;
  }

  const video = $('remote-video');
  if (!video.srcObject || !video.classList.contains('visible')) {
    $('join-status').textContent = 'خاص الشاشة توصل قبل ما تفتح النافذة العائمة.';
    return;
  }

  try {
    if (window.documentPictureInPicture?.requestWindow) {
      const viewer = await window.documentPictureInPicture.requestWindow({ width: 1280, height: 800 });
      detachedViewerWindow = viewer;
      const videoWrap = $('video-wrap');
      detachedViewerReturnParent = videoWrap.parentElement;
      detachedViewerReturnSibling = videoWrap.nextSibling;

      const stylesheet = viewer.document.createElement('link');
      stylesheet.rel = 'stylesheet';
      stylesheet.href = document.querySelector('link[rel="stylesheet"]').href;
      viewer.document.head.append(stylesheet);
      viewer.document.title = localized('Sanad — écran distant', 'Sanad — remote screen', 'سند — الشاشة البعيدة');
      viewer.document.documentElement.lang = settings.language;
      viewer.document.documentElement.dir = settings.language === 'ar' ? 'rtl' : 'ltr';

      const viewerStyle = viewer.document.createElement('style');
      viewerStyle.textContent = `
        html, body { width:100%; height:100%; margin:0; overflow:hidden; background:#11182b; }
        body { display:flex; flex-direction:column; }
        .detached-viewer-toolbar { height:46px; flex:0 0 46px; display:flex; align-items:center; gap:12px; padding:0 15px; background:#fff; color:#20243a; border-bottom:1px solid #e7e9f1; font:600 13px "Segoe UI",Arial,sans-serif; }
        .detached-viewer-toolbar span { flex:1; }
        .detached-viewer-toolbar button { border:1px solid #e3e6ef; border-radius:7px; background:#f3f5fa; color:#58627d; padding:7px 11px; font:600 12px "Segoe UI",Arial,sans-serif; cursor:pointer; }
        .video-wrap.detached-mode { width:100%; height:auto; min-height:0; flex:1; border-radius:0; }
        .video-wrap.detached-mode video { width:100%; height:100%; object-fit:contain; }
        .video-wrap.detached-mode.fill-mode video { object-fit:cover; }
        .video-wrap.detached-mode.native-mode { height:auto; flex:1; }
        .video-wrap.detached-mode:fullscreen { width:100vw; height:100vh; flex:1; }
        .video-wrap.detached-mode:fullscreen video { max-height:100vh; }
        html:fullscreen .detached-viewer-toolbar { display:none; }
      `;
      viewer.document.head.append(viewerStyle);

      const toolbar = viewer.document.createElement('header');
      toolbar.className = 'detached-viewer-toolbar';
      const title = viewer.document.createElement('span');
      title.id = 'detached-viewer-title';
      title.textContent = localized('Écran partagé · Sanad', 'Shared screen · Sanad', 'الشاشة المشتركة · سند');
      const fullscreen = viewer.document.createElement('button');
      fullscreen.id = 'detached-viewer-fullscreen';
      fullscreen.type = 'button';
      fullscreen.textContent = localized('⛶ Plein écran', '⛶ Full screen', '⛶ ملء الشاشة');
      fullscreen.addEventListener('click', () => toggleDetachedViewerFullscreen(viewer.document).catch(() => {}));
      viewer.document.addEventListener('fullscreenchange', () => {
        refreshDetachedViewerLabels();
        $('fullscreen-button').textContent = viewer.document.fullscreenElement
          ? localized('⤢ Quitter le plein écran', '⤢ Exit full screen', '⤢ الخروج من ملء الشاشة')
          : localized('⛶ Plein écran', '⛶ Full screen', '⛶ ملء الشاشة');
      });
      toolbar.append(title, fullscreen);
      viewer.document.body.append(toolbar, videoWrap);
      videoWrap.classList.add('detached-mode');
      viewer.addEventListener('pagehide', restoreDetachedViewer, { once: true });
      $('floating-window-button').textContent = localized('Fermer la fenêtre', 'Close window', 'إغلاق النافذة');
      viewer.focus();
      return;
    }

    if (video.readyState >= HTMLMediaElement.HAVE_METADATA && video.requestPictureInPicture) {
      await video.requestPictureInPicture();
      return;
    }
    $('join-status').textContent = 'هاد النظام ما سمحش بفتح نافذة الشاشة العائمة.';
  } catch {
    restoreDetachedViewer();
    if (video.readyState >= HTMLMediaElement.HAVE_METADATA && video.requestPictureInPicture && !document.pictureInPictureElement) {
      await video.requestPictureInPicture().catch(() => {});
      if (document.pictureInPictureElement) return;
    }
    $('join-status').textContent = 'هاد النظام ما سمحش بفتح نافذة الشاشة العائمة.';
  }
}

$('fullscreen-button').addEventListener('click', async () => {
  try {
    if (detachedViewerWindow && !detachedViewerWindow.closed) await toggleDetachedViewerFullscreen(detachedViewerWindow.document);
    else if (document.pictureInPictureElement) {
      await document.exitPictureInPicture();
      await $('video-wrap').requestFullscreen();
    }
    else if (document.fullscreenElement) await document.exitFullscreen();
    else await $('video-wrap').requestFullscreen();
  } catch { $('join-status').textContent = 'تعذر تفعيل ملء الشاشة في هاد البيئة.'; }
});
document.addEventListener('fullscreenchange', () => {
  $('fullscreen-button').textContent = document.fullscreenElement
    ? localized('⤢ Quitter le plein écran', '⤢ Exit full screen', '⤢ الخروج من ملء الشاشة')
    : localized('⛶ Plein écran', '⛶ Full screen', '⛶ ملء الشاشة');
});
$('remote-video').addEventListener('enterpictureinpicture', () => { $('floating-window-button').textContent = localized('Fermer la fenêtre', 'Close window', 'إغلاق النافذة'); });
$('remote-video').addEventListener('leavepictureinpicture', () => { $('floating-window-button').textContent = localized('▣ Fenêtre indépendante', '▣ Separate window', '▣ نافذة مستقلة'); });
$('floating-window-button').addEventListener('click', async () => {
  if ((detachedViewerWindow && !detachedViewerWindow.closed) || document.pictureInPictureElement) {
    if (detachedViewerWindow && !detachedViewerWindow.closed) detachedViewerWindow.close();
    else await document.exitPictureInPicture().catch(() => {});
    restoreDetachedViewer();
    return;
  }
  await openDetachedViewer();
});
knownDevices = loadKnownDevices();
applyViewSettings();
if (window.sanadDesktop?.isDesktop) {
  void window.sanadDesktop.getAppVersion().then((version) => {
    if (/^\d+\.\d+\.\d+$/.test(version)) $('app-version').textContent = version;
  }).catch(() => {});
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
    $('.browser-identity-note').hidden = true;
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
    $('regenerate-device-password').disabled = true;
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
      track.addEventListener('ended', () => {
        void window.sanadDesktop?.clearSharedDisplay();
        setStatus('أوقفت مشاركة الشاشة.');
      }, { once: true });
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
          $('.browser-identity-note').hidden = true;
        }
      }
      if (!deviceIdentity?.ok) throw new Error(deviceIdentity?.error || 'تعذر تحميل معرّف هذا الجهاز. أعد تشغيل تطبيق سند.');
      const registration = await window.sanadDesktop.registerDeviceSession(pc.localDescription);
      if (!registration?.ok) throw new Error(registration?.error || 'تعذر تشغيل الاتصال بهذا الجهاز.');
      activeDeviceSessionId = registration.id;
      $('regenerate-device-password').disabled = true;
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
    $('regenerate-device-password').disabled = false;
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

$('save-known-device').addEventListener('click', () => {
  const id = $('device-id-input').value.trim().toLowerCase();
  if (!/^[a-f0-9]{16}$/.test(id)) {
    $('device-join-status').textContent = localized('Saisissez d’abord un ID d’appareil valide.', 'Enter a valid device ID first.', 'دخل معرّف جهاز صحيح أولا.');
    return;
  }
  rememberDevice(id, { alias: $('known-device-alias').value, favorite: true });
  $('known-device-alias').value = '';
  $('device-join-status').textContent = localized('Appareil enregistré. Le mot de passe reste uniquement dans votre saisie.', 'Device saved. The password stays only in your input.', 'تسجل الجهاز. كلمة السر كتبقى غير فخانة الإدخال.');
});

$('known-device-list').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-known-action]');
  if (!button) return;
  const { deviceId, knownAction } = button.dataset;
  const device = knownDevices.find((item) => item.id === deviceId);
  if (!device) return;
  if (knownAction === 'use') {
    $('device-id-input').value = device.id;
    $('device-password-input').value = '';
    $('device-password-input').focus();
  } else if (knownAction === 'favorite') {
    rememberDevice(device.id, { alias: device.alias, favorite: !device.favorite });
  } else if (knownAction === 'remove') {
    knownDevices = knownDevices.filter((item) => item.id !== device.id);
    persistKnownDevices();
    renderKnownDevices();
  }
});

$('chat-permission-toggle').addEventListener('click', () => {
  if (!isHost || fileChannel?.readyState !== 'open') return;
  chatAllowed = !chatAllowed;
  fileChannel.send(JSON.stringify({ type: 'chat-status', enabled: chatAllowed }));
  $('chat-status').textContent = localized(chatAllowed ? 'Discussion activée.' : 'Discussion désactivée.', chatAllowed ? 'Chat enabled.' : 'Chat disabled.', chatAllowed ? 'الدردشة مفعّلة.' : 'الدردشة متوقفة.');
  updateChatUi();
});

$('chat-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const text = $('chat-input').value.trim();
  const allowed = isHost ? chatAllowed : chatEnabled;
  if (!text || text.length > 1000 || !allowed || fileChannel?.readyState !== 'open') return;
  fileChannel.send(JSON.stringify({ type: 'chat', text }));
  appendChatMessage(text, true);
  $('chat-input').value = '';
});

$('copy-session').addEventListener('click', () => copyText(sessionCode || '', 'host-status'));
$('copy-device-id').addEventListener('click', () => copyText(deviceIdentity?.id || $('device-id-output').value, 'host-status'));
$('copy-device-password').addEventListener('click', () => copyText(deviceIdentity?.password || $('device-password-output').value, 'host-status'));
$('regenerate-device-password').addEventListener('click', async () => {
  if (!window.sanadDesktop?.isDesktop || activeDeviceSessionId || screenStream) return;
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const password = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  const button = $('regenerate-device-password');
  button.disabled = true;
  try {
    const result = await window.sanadDesktop.setDevicePassword(password);
    if (!result?.ok) throw new Error(result?.error || 'تعذر تغيير كلمة المرور.');
    if (deviceIdentity) deviceIdentity.password = password;
    $('device-password-output').value = password;
    $('host-status').textContent = 'تم تغيير كلمة المرور. أرسل الجديدة للشخص الموثوق فقط.';
  } catch (error) {
    $('host-status').textContent = error.message || 'تعذر تغيير كلمة المرور.';
  } finally {
    button.disabled = Boolean(activeDeviceSessionId);
  }
});
$('device-password-toggle').addEventListener('click', () => {
  const field = $('device-password-output');
  field.type = field.type === 'password' ? 'text' : 'password';
  const labels = { fr: ['Afficher', 'Masquer'], en: ['Show', 'Hide'], ar: ['إظهار', 'إخفاء'] }[settings.language];
  $('device-password-toggle').textContent = field.type === 'password' ? labels[0] : labels[1];
});
$('request-control').addEventListener('click', requestPointerControl);
$('revoke-control').addEventListener('click', async () => {
  const result = await window.sanadDesktop?.revokeControl();
  updateControlUi(result?.scopes || [], 'أوقفتَ صلاحيات التحكم.');
  if (fileChannel?.readyState === 'open') fileChannel.send(JSON.stringify({ type: 'control-status', scopes: [], reason: 'revoked' }));
});

$('end-session').addEventListener('click', async () => {
  const priorCode = sessionCode;
  await window.sanadDesktop?.clearSharedDisplay();
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
  if (detachedViewerWindow && !detachedViewerWindow.closed) detachedViewerWindow.close();
  restoreDetachedViewer();
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
  $('regenerate-device-password').disabled = false;
  $('start-session').disabled = false;
  $('join-session').disabled = false;
  $('join-device-session').disabled = false;
  $('send-file').disabled = true;
  updateControlUi([], 'انتهت الجلسة.');
  setStatus('تم إنهاء الجلسة.');
});
$('file-input').addEventListener('change', (event) => {
  selectedFile = event.target.files?.[0] || null;
  const sendButton = $('send-file');
  sendButton.replaceChildren(document.createTextNode(selectedFile ? `${settings.language === 'fr' ? 'Envoyer' : settings.language === 'en' ? 'Send' : 'إرسال'} ${selectedFile.name} ` : `${settings.language === 'fr' ? 'Envoyer le fichier' : settings.language === 'en' ? 'Send file' : 'إرسال الملف'} `));
  const arrow = document.createElement('b'); arrow.textContent = '→'; sendButton.append(arrow);
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
  $('send-file').replaceChildren(document.createTextNode(`${settings.language === 'fr' ? 'Envoyer le fichier' : settings.language === 'en' ? 'Send file' : 'إرسال الملف'} `));
  const arrow = document.createElement('b'); arrow.textContent = '→'; $('send-file').append(arrow);
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
