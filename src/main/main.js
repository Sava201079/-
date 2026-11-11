'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeTheme, safeStorage, clipboard } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const mc = require('./minecraft');
const skins = require('./skins');
const loaders = require('./loaders');
const ely = require('./elyby');
const { createAccountStore } = require('./accounts');
const { createFriends, parseConfig, safeAvatarB64 } = require('./friends');

const isDev = process.argv.includes('--dev');
const THEMES = ['light', 'dark', 'system'];
const BG = { light: '#f6f5f2', dark: '#14161a' };

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }
app.setAppUserModelId('app.unlucky.launcher');

let win = null;
let settingsFile, skinStore, accountStore, friends;
let settings = {};
let session = null; // { ac: AbortController, child: ChildProcess|null }
let loginSession = null; // вход в аккаунт: { ac: AbortController }
let playingNow = null; // «Minecraft 1.20.1 · Fabric», пока идёт игра — это видят друзья
let myAvatar = ''; // голова игрока (PNG 8×8, base64): рисует интерфейс, отправляется друзьям

// ---------------------------------------------------------------- настройки

function defaults() {
  const totalMb = Math.floor(os.totalmem() / 1024 / 1024);
  const ram = Math.max(1024, Math.min(4096, Math.floor(totalMb / 2 / 512) * 512));
  return {
    nickname: '', version: '', loader: 'vanilla', showSnapshots: false,
    ramMb: ram, javaPath: '', gameDir: '', jvmArgs: '',
    hideOnLaunch: true, applySkin: true, gameLang: true,
    theme: 'light', // light | dark | system
    friendsOn: false, friendsHidden: false, friendsUrl: '', friendsKey: '', // друзья: выключены, пока человек сам их не включит
  };
}

function sanitize(patch, cur) {
  const out = {};
  const totalMb = Math.floor(os.totalmem() / 1024 / 1024);
  const str = (v, max) => String(v == null ? '' : v).slice(0, max);
  for (const [k, v] of Object.entries(patch || {})) {
    switch (k) {
      case 'nickname': out.nickname = str(v, 16); break;
      case 'version': out.version = str(v, 64); break;
      case 'loader': out.loader = loaders.LOADERS.includes(v) ? v : cur.loader; break;
      case 'javaPath': out.javaPath = str(v, 1024); break;
      case 'gameDir': out.gameDir = str(v, 1024); break;
      case 'jvmArgs': out.jvmArgs = str(v, 1024); break;
      case 'ramMb': out.ramMb = Math.max(512, Math.min(Math.max(1024, totalMb), parseInt(v, 10) || cur.ramMb)); break;
      case 'theme': out.theme = THEMES.includes(v) ? v : cur.theme; break;
      case 'friendsUrl': out.friendsUrl = str(v, 300).trim(); break;
      case 'friendsKey': out.friendsKey = str(v, 1000).trim(); break;
      case 'showSnapshots': case 'hideOnLaunch': case 'applySkin': case 'gameLang': case 'friendsOn': case 'friendsHidden': out[k] = !!v; break;
      default: break;
    }
  }
  return out;
}

function loadSettings() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch { /* первый запуск */ }
  const d = defaults();
  settings = Object.assign(d, sanitize(saved, d));
  if (!settings.nickname) settings.nickname = 'Player' + Math.floor(100 + Math.random() * 900);
  if (legacyGameDir && !settings.gameDir) settings.gameDir = legacyGameDir;
}

/** Тема окна. themeSource управляет и prefers-color-scheme в интерфейсе, и системными диалогами. */
function applyTheme() { nativeTheme.themeSource = settings.theme; }

/**
 * Лаунчер раньше назывался Kubik: переносим его настройки, скины и (переименованием, без копирования
 * гигабайтов) папку игры в папку Unlucky — но только при первом запуске.
 */
let legacyGameDir = null;
function migrateLegacyData() {
  try {
    const dir = app.getPath('userData');
    const old = path.join(app.getPath('appData'), 'Kubik');
    if (!fs.existsSync(old) || fs.existsSync(path.join(dir, 'settings.json'))) return;
    fs.mkdirSync(dir, { recursive: true });
    for (const name of ['settings.json', 'skins']) {
      try { fs.cpSync(path.join(old, name), path.join(dir, name), { recursive: true, force: false }); } catch { /* этого нет — не страшно */ }
    }
    const oldGame = path.join(old, 'minecraft'), newGame = path.join(dir, 'minecraft');
    if (fs.existsSync(oldGame) && !fs.existsSync(newGame)) {
      try { fs.renameSync(oldGame, newGame); } catch { legacyGameDir = oldGame; }
    }
  } catch (e) { console.error('Не удалось перенести данные Kubik', e); }
}

function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
  } catch (e) { console.error('Не удалось сохранить настройки', e); }
}

const gameRoot = () => settings.gameDir || path.join(app.getPath('userData'), 'minecraft');

// ---------------------------------------------------------------- окно

function createWindow() {
  win = new BrowserWindow({
    width: 1040, height: 660, minWidth: 940, minHeight: 600,
    frame: false, show: false, backgroundColor: nativeTheme.shouldUseDarkColors ? BG.dark : BG.light, title: 'Unlucky',
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, sandbox: true, nodeIntegration: false, devTools: isDev,
    },
  });
  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.on('maximize', () => send('win:maximized', true));
  win.on('unmaximize', () => send('win:maximized', false));
  win.on('closed', () => { win = null; });
  if (isDev) win.webContents.openDevTools({ mode: 'detach' });
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// ---------------------------------------------------------------- друзья

/** Адрес и публичный ключ проекта Supabase: из настроек (если введены), иначе вшитые в сборку (friends.config.json). */
function friendsConfig() {
  const env = process.env;
  if (env.UNLUCKY_FRIENDS_URL && env.UNLUCKY_FRIENDS_KEY) return { url: env.UNLUCKY_FRIENDS_URL, key: env.UNLUCKY_FRIENDS_KEY }; // для автотестов
  if (settings.friendsUrl && settings.friendsKey) return { url: settings.friendsUrl, key: settings.friendsKey };
  try { return require('./friends.config.json'); } catch { return { url: '', key: '' }; }
}

function friendsView() {
  return {
    ...friends.view(),
    enabled: !!settings.friendsOn, hidden: !!settings.friendsHidden,
    custom: !!(settings.friendsUrl && settings.friendsKey),
  };
}

function setPlaying(text) {
  playingNow = text;
  if (friends) friends.nudge();
}

// ---------------------------------------------------------------- запуск игры

async function startPlay({ version, loader }) {
  if (session) throw new Error('Игра уже запускается или запущена');
  if (loginSession) throw new Error('Сначала завершите вход в аккаунт');
  const accountId = accountStore.activeId();
  if (!accountId) throw new Error('Выберите аккаунт');
  if (!version) throw new Error('Выберите версию');
  loader = loaders.LOADERS.includes(loader) ? loader : 'vanilla';
  const root = gameRoot();
  fs.mkdirSync(root, { recursive: true });

  const ac = new AbortController();
  session = { ac, child: null };
  send('play:state', { state: 'preparing' });
  let secret = ''; // токен доступа: вырезаем его из журнала на случай, если игра или агент его напечатают
  const log = (line, tag) => send('play:log', { line: secret ? String(line).split(secret).join('***') : line, tag: tag || 'info' });

  try {
    // Вход в аккаунт — первым делом, чтобы не заставлять ждать скачивания, если сессия истекла.
    const launchAuth = await accountStore.prepareLaunch(accountId, {
      signal: ac.signal, log, authlibDir: path.join(app.getPath('userData'), 'authlib'),
    });
    const acc = launchAuth.account;
    const accLabel = { offline: 'оффлайн', elyby: 'Ely.by' }[acc.type];
    if (launchAuth.auth) secret = launchAuth.auth.accessToken;
    log(`Аккаунт: ${acc.name} (${accLabel})`);
    if (acc.type !== 'offline' && !accountStore.secureStorage) {
      log('Хранилище паролей системы недоступно: токены входа лежат в файле аккаунтов без шифрования (доступ к нему есть только у вашей учётной записи).', 'warn');
    }

    const common = {
      root, gameDir: root, javaPath: settings.javaPath, signal: ac.signal,
      onStage: (stage) => send('play:progress', { stage }),
      onProgress: (p) => send('play:progress', p),
    };

    // Fabric / Forge: ставим профиль загрузчика (один раз), дальше запуск такой же, как у обычной версии.
    let launchId = version;
    if (loader !== 'vanilla') {
      const have = await loaders.findInstalled(root, loader, version);
      if (have.length) launchId = have[0].id;
      else if (loader === 'fabric') {
        launchId = await loaders.installFabric({ root, mc: version, signal: ac.signal, onStage: common.onStage });
        log(`Fabric установлен: ${launchId}`);
      } else {
        // установщику Forge нужны ваниль и Java — готовим их заранее
        const base = await mc.prepare({ ...common, id: version });
        launchId = await loaders.installForge({
          root, mc: version, javaExe: base.javaExe, signal: ac.signal, onStage: common.onStage,
          onLine: (line, tag) => log(line, tag === 'err' ? 'warn' : 'info'),
        });
        log(`Forge установлен: ${launchId}`);
      }
    }

    const prep = await mc.prepare({ ...common, id: launchId });
    log(`Версия: ${launchId}${loader !== 'vanilla' ? ' (' + loaders.LABEL[loader] + ')' : ''}`);
    log(`Java: ${prep.javaExe} (${prep.javaSource})`);
    const releaseTime = prep.json._baseReleaseTime || prep.json.releaseTime;

    // Скин: ресурспак + копия клиента с подменёнными текстурами (см. skins.js). Любой из способов достаточен.
    let skinName = null, embedded = false;
    if (launchAuth.online) {
      // У онлайн-аккаунта скин берётся с сервера (Mojang или Ely.by), подмена текстур только мешала бы. Убираем наш пак.
      try { skins.applySkinPack({ gameDir: root, skin: null, enable: false, releaseTime, jarPath: prep.clientJar, gameLang: settings.gameLang }); } catch { /* пака могло и не быть */ }
      log('Скин берётся с Ely.by — его видят игроки на серверах, которые принимают аккаунты Ely.by');
      if (acc.type === 'elyby' && Date.parse(releaseTime) < Date.parse('2013-10-25')) {
        log('authlib-injector работает с версиями от 1.7.2: на этой версии вход через Ely.by может не сработать', 'warn');
      }
    } else try {
      const info = skinStore.getActive();
      const r = skins.applySkinPack({
        gameDir: root, skin: info, enable: settings.applySkin,
        releaseTime, jarPath: prep.clientJar, gameLang: settings.gameLang,
      });
      if (r.applied) {
        skinName = info.name;
        log(`Скин «${info.name}» (${info.model === 'slim' ? 'тонкие' : 'обычные'} руки): ресурспак ${skins.PACK_NAME}, pack_format ${r.packFormat}`);
        // Копию клиента со скином делаем только для чистой версии: Fabric и Forge сами собирают клиент из jar,
        // и подмена файла им ни к чему — там скин подключается ресурспаком.
        if (loader !== 'vanilla') log('Для ' + loaders.LABEL[loader] + ' скин подключается ресурспаком');
        else try {
          const pj = skins.patchClientJar({ jarPath: prep.clientJar, skin: info, releaseTime });
          if (pj.path) {
            prep.classpath = prep.classpath.map((p) => (p === prep.clientJar ? pj.path : p));
            embedded = true;
            log(pj.cached ? 'Скин встроен в клиент игры (копия из кэша)' : `Скин встроен в клиент игры (заменено текстур: ${pj.replaced})`);
          } else log('В клиенте этой версии не нашлось стандартных скинов — работает только ресурспак', 'warn');
        } catch (e) { log('Не удалось встроить скин в клиент, остаётся ресурспак: ' + e.message, 'warn'); }
      } else if (settings.applySkin && !info) log('Скин не выбран — игра использует стандартный', 'warn');
    } catch (e) { log('Не удалось подключить скин: ' + e.message, 'warn'); }

    const cmd = mc.buildCommand({
      ...prep, gameDir: root, nickname: acc.name, ramMb: settings.ramMb, jvmArgs: settings.jvmArgs, launcherVersion: app.getVersion(),
      auth: launchAuth.auth, javaAgent: launchAuth.javaAgent,
    });
    send('play:state', { state: 'launching' });
    const startedAt = Date.now();
    session.child = mc.launchGame(cmd, {
      onLine: (line, tag) => {
        log(line, tag);
        if (/Removed resource pack/i.test(line) && /(Unlucky|Kubik)Skin/.test(line)) {
          log(embedded ? 'Игра отключила ресурспак скина, но скин уже встроен в клиент — он применится.' : 'Игра отключила ресурспак скина (несовместимый формат?) — скин может не примениться.', 'warn');
        }
      },
      onExit: (code, err) => {
        const wasKilled = ac.signal.aborted;
        session = null;
        setPlaying(null);
        if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
        const ok = code === 0 || wasKilled;
        let error = null;
        if (err) error = 'Не удалось запустить Java: ' + err.message;
        else if (!ok) error = `Игра завершилась с ошибкой (код ${code}). Откройте журнал, чтобы увидеть подробности.`;
        send('play:state', { state: 'idle', error, ranMs: Date.now() - startedAt });
      },
    });
    send('play:state', { state: 'running', skin: skinName, account: acc.name, accountType: acc.type });
    setPlaying(`Minecraft ${version}${loader !== 'vanilla' ? ' · ' + loaders.LABEL[loader] : ''}`);
    if (settings.hideOnLaunch && win) win.minimize();
  } catch (e) {
    const cancelled = ac.signal.aborted;
    session = null;
    setPlaying(null);
    send('play:state', { state: 'idle', error: cancelled ? null : e.message });
    if (!cancelled) throw e;
  }
}

// ---------------------------------------------------------------- IPC

function guard(fn) {
  return async (e, ...args) => {
    const url = e.senderFrame && e.senderFrame.url;
    if (!url || !url.startsWith('file://')) throw new Error('Запрещено');
    try { return await fn(e, ...args); }
    catch (err) { throw new Error(err && err.message ? err.message : String(err)); }
  };
}
const handle = (ch, fn) => ipcMain.handle(ch, guard(fn));

function registerIpc() {
  ipcMain.on('settings:theme', (e) => {
    const url = e.senderFrame && e.senderFrame.url;
    e.returnValue = url && url.startsWith('file://') ? settings.theme : 'light';
  });
  handle('app:info', () => ({
    version: app.getVersion(), platform: process.platform,
    totalMemMb: Math.floor(os.totalmem() / 1024 / 1024), defaultGameDir: path.join(app.getPath('userData'), 'minecraft'),
  }));
  handle('settings:get', () => settings);
  handle('settings:set', (_e, patch) => {
    Object.assign(settings, sanitize(patch, settings));
    applyTheme();
    if (win && !win.isDestroyed()) win.setBackgroundColor(nativeTheme.shouldUseDarkColors ? BG.dark : BG.light);
    saveSettings();
    return settings;
  });
  handle('versions:list', (_e, opts) => {
    const refresh = !(opts && opts.refresh === false);
    const loader = opts && opts.loader;
    return loader === 'fabric' || loader === 'forge'
      ? loaders.listLoaderVersions(gameRoot(), loader, { refresh })
      : mc.listVersions(gameRoot(), { refresh });
  });

  handle('play:start', (_e, args) => startPlay(args || {}));
  handle('play:cancel', () => { if (session && !session.child) session.ac.abort(); });
  handle('play:stop', () => { if (session && session.child) { session.ac.abort(); session.child.kill(); } });

  handle('skins:list', () => skinStore.list());
  handle('skins:get', (_e, id) => skins.bufferToDataUrl(skinStore.get(id)));
  handle('skins:create', (_e, { name, model, png }) => skinStore.create({ name, model, png: png ? skins.dataUrlToBuffer(png) : null }));
  handle('skins:save', (_e, id, { name, model, png }) => skinStore.save(id, { name, model, png: png ? skins.dataUrlToBuffer(png) : null }));
  handle('skins:remove', (_e, id) => skinStore.remove(id));
  handle('skins:setActive', (_e, id) => skinStore.setActive(id));
  handle('skins:import', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Выберите скин', properties: ['openFile'], filters: [{ name: 'PNG', extensions: ['png'] }] });
    if (r.canceled || !r.filePaths[0]) return null;
    const buf = skins.normalizeSkin(fs.readFileSync(r.filePaths[0]));
    return { name: path.basename(r.filePaths[0], path.extname(r.filePaths[0])), png: skins.bufferToDataUrl(buf) };
  });
  handle('skins:export', async (_e, id) => {
    const meta = skinStore.list().skins.find(s => s.id === id);
    if (!meta) throw new Error('Скин не найден');
    const r = await dialog.showSaveDialog(win, { title: 'Сохранить скин', defaultPath: `${meta.name}.png`, filters: [{ name: 'PNG', extensions: ['png'] }] });
    if (r.canceled || !r.filePath) return false;
    fs.writeFileSync(r.filePath, skinStore.get(id));
    return true;
  });
  handle('skins:fetchNick', async (_e, nick) => {
    const s = await skins.fetchSkinByNick(nick);
    return { name: s.name, model: s.model, png: skins.bufferToDataUrl(s.png) };
  });

  // ---- аккаунты
  const accountsView = () => ({ ...accountStore.list(), secure: accountStore.secureStorage });
  const idleOnly = () => { if (session) throw new Error('Пока игра запускается или идёт, аккаунт менять нельзя'); };
  /** Аватар скачиваем недолго: если сервер медлит, он появится позже, а вход не задерживаем. */
  const withAvatar = async (id) => {
    await Promise.race([accountStore.refreshAvatar(id).catch(() => {}), new Promise((r) => setTimeout(r, 2500))]);
  };
  async function runLogin(fn) {
    if (loginSession) throw new Error('Вход уже выполняется');
    const ac = new AbortController();
    loginSession = { ac };
    try { return await fn(ac); }
    catch (e) { if (ac.signal.aborted) return null; throw e; }
    finally { loginSession = null; }
  }

  handle('accounts:list', () => accountsView());
  handle('accounts:addOffline', (_e, name) => { idleOnly(); accountStore.addOffline(name); friends.nudge(); return accountsView(); });
  handle('accounts:rename', (_e, id, name) => { idleOnly(); accountStore.renameOffline(id, name); friends.nudge(); return accountsView(); });
  handle('accounts:setActive', (_e, id) => { idleOnly(); accountStore.setActive(id); friends.nudge(); return accountsView(); });
  handle('accounts:remove', (_e, id) => { idleOnly(); accountStore.remove(id); friends.nudge(); return accountsView(); });
  handle('accounts:loginCancel', () => { if (loginSession) loginSession.ac.abort(); });

  // Пароль нигде не сохраняется: он нужен один раз, чтобы получить токен.
  handle('accounts:elyLogin', (_e, { login, password, totp } = {}) => runLogin(async (ac) => {
    idleOnly();
    try {
      const r = await ely.authenticate(String(login || '').trim(), String(password || ''), { totp: totp ? String(totp) : '', signal: ac.signal });
      const v = accountStore.upsertOnline('elyby', { name: r.name, uuid: r.uuid }, { accessToken: r.accessToken, clientToken: r.clientToken });
      await withAvatar(v.id);
      friends.nudge();
      return { ok: true, accounts: accountsView() };
    } catch (e) {
      if (e.twoFactor) return { twoFactor: true };
      throw e;
    }
  }));

  // ---- друзья
  handle('app:copy', (_e, text) => { clipboard.writeText(String(text == null ? '' : text).slice(0, 500)); return true; });
  handle('friends:get', () => friendsView());
  handle('friends:enable', (_e, on) => {
    settings.friendsOn = !!on; saveSettings();
    if (on) friends.start(); else friends.stop();
    return friendsView();
  });
  handle('friends:setConfig', (_e, { url, key } = {}) => {
    parseConfig(url, key); // бросает понятную ошибку; пустые значения = вернуть вшитый в сборку проект
    settings.friendsUrl = String(url || '').trim(); settings.friendsKey = String(key || '').trim();
    saveSettings();
    if (settings.friendsOn) friends.restart(); else send('friends:state', friendsView());
    return friendsView();
  });
  handle('friends:sync', async () => { await friends.syncNow(); return friendsView(); });
  handle('friends:request', (_e, code) => friends.request(code));
  handle('friends:accept', async (_e, id) => { await friends.accept(id); return friendsView(); });
  handle('friends:decline', async (_e, id) => { await friends.decline(id); return friendsView(); });
  handle('friends:remove', async (_e, id) => { await friends.remove(id); return friendsView(); });
  handle('friends:newCode', async () => { await friends.newCode(); return friendsView(); });
  handle('friends:setHidden', (_e, hidden) => {
    settings.friendsHidden = !!hidden; saveSettings();
    friends.syncNow().catch(() => {}); // приватность меняется сразу, а не через паузу
    return friendsView();
  });
  handle('friends:setAvatar', (_e, b64) => {
    const ok = safeAvatarB64(b64);
    if (ok && ok !== myAvatar) { myAvatar = ok; friends.nudge(); }
    return !!ok;
  });
  handle('friends:delete', async () => {
    await friends.deleteMe();
    settings.friendsOn = false; saveSettings();
    return friendsView();
  });

  // Во внешнем браузере открываем только известные адреса.
  const EXTERNAL_OK = new Set([ely.SKINS_URL, ely.REGISTER_URL]);
  handle('shell:openExternal', (_e, url) => {
    if (!EXTERNAL_OK.has(url)) throw new Error('Этот адрес открыть нельзя');
    return shell.openExternal(url);
  });

  handle('dialog:pickDir', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('dialog:pickJava', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: process.platform === 'win32' ? [{ name: 'java.exe', extensions: ['exe'] }] : [] });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('shell:openGameDir', async (_e, sub) => {
    const dir = sub === 'mods' ? path.join(gameRoot(), 'mods') : gameRoot();
    fs.mkdirSync(dir, { recursive: true });
    return shell.openPath(dir);
  });

  handle('win:minimize', () => win && win.minimize());
  handle('win:toggleMaximize', () => { if (!win) return false; if (win.isMaximized()) win.unmaximize(); else win.maximize(); return win.isMaximized(); });
  handle('win:close', () => win && win.close());
}

// ---------------------------------------------------------------- жизненный цикл

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  settingsFile = path.join(app.getPath('userData'), 'settings.json');
  migrateLegacyData();
  skinStore = skins.createSkinStore(path.join(app.getPath('userData'), 'skins'));
  skinStore.ensureDefault();
  loadSettings();
  const cipher = {
    // Синхронный API помечен в Electron устаревшим; версия Electron в package.json зафиксирована, а при его удалении токены лягут в запасной вариант.
    available: () => { try { return safeStorage.isEncryptionAvailable(); } catch { return false; } },
    encrypt: (str) => safeStorage.encryptString(str),
    decrypt: (buf) => safeStorage.decryptString(buf),
  };
  accountStore = createAccountStore({ dir: app.getPath('userData'), fallbackName: () => settings.nickname, cipher });
  friends = createFriends({
    dir: app.getPath('userData'), cipher, getConfig: friendsConfig,
    getProfile: () => {
      let name = '';
      try { name = accountStore.get(accountStore.activeId()).name; } catch { /* аккаунта нет */ }
      return { name, avatar: myAvatar, playing: playingNow, hidden: settings.friendsHidden };
    },
    onChange: (v) => send('friends:state', { ...v, enabled: !!settings.friendsOn, hidden: !!settings.friendsHidden, custom: !!(settings.friendsUrl && settings.friendsKey) }),
  });
  accountStore.ensureOne(settings.nickname); // первый запуск после обновления: ник из настроек становится оффлайн-аккаунтом
  applyTheme();
  saveSettings();
  registerIpc();
  createWindow();
  if (settings.friendsOn) friends.start();
});

app.on('window-all-closed', () => {
  if (session) { session.ac.abort(); if (session.child) { try { session.child.kill(); } catch { /* ignore */ } } }
  // Друзья должны сразу увидеть «не в сети», но не ждём сервер дольше пары секунд.
  const bye = friends ? friends.bye(1500) : Promise.resolve();
  Promise.race([bye, new Promise((r) => setTimeout(r, 1800))]).then(() => app.quit(), () => app.quit());
});
