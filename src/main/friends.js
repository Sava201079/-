'use strict';
// Друзья лаунчера. Лаунчер общается напрямую с проектом Supabase (адрес и публичный ключ — в friends.config.json
// или в настройках). Своего сервера нет: схема и вся логика — в friends/friends.sql.
//
// Как это работает:
//  * вход анонимный (Supabase Auth, signup без почты): у каждой установки свой идентификатор и свой код друга;
//  * сессия (токены) лежит в friends.json в зашифрованном виде (см. secretbox.js);
//  * раз в ~45 секунд вызывается friends_sync: «я здесь» + ник, аватар и статус, а в ответ приходит всё,
//    что нужно показать: свой код, друзья (в сети / играют), входящие и исходящие заявки;
//  * всё, что приходит с сервера, считается недоверенным: имена, аватары и статусы проверяются перед показом.

const fs = require('fs');
const path = require('path');
const { request, userError } = require('./net');
const { createSecretBox } = require('./secretbox');

const SYNC_MS = 45000;
const MAX_BACKOFF_MS = 5 * 60000;
const CODE_RE = /^[A-HJ-NP-Z2-9]{8}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_LIST = 250;

const prettyCode = (c) => (CODE_RE.test(c) ? `UNL-${c.slice(0, 4)}-${c.slice(4)}` : '');

// ---------------------------------------------------------------- проверка настроек

/**
 * Адрес и ключ проекта Supabase → { url, key } или null, если оба пусты. Бросает понятную ошибку, если что-то не так.
 * Ключ попадает в лаунчер, который получают все друзья, поэтому секретные ключи (service_role, sb_secret_) отвергаются.
 */
function parseConfig(url, key) {
  url = String(url || '').trim(); key = String(key || '').trim();
  if (!url && !key) return null;
  if (!url) throw userError('Укажите адрес проекта Supabase (вида https://xxxx.supabase.co).');
  if (!key) throw userError('Укажите публичный ключ проекта Supabase (anon или publishable).');
  let u;
  try { u = new URL(/^[a-z]+:\/\//i.test(url) ? url : 'https://' + url); } catch { throw userError('Адрес проекта выглядит неправильно. Нужен вид https://xxxx.supabase.co'); }
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw userError('Адрес проекта должен начинаться с https://');
  if (u.username || u.password) throw userError('В адресе не должно быть логина и пароля.');
  if (/^sb_secret_/i.test(key)) throw userError('Это секретный ключ (secret). Его нельзя вставлять в лаунчер: возьмите публичный — anon или publishable.');
  if (!/^[A-Za-z0-9._-]{20,1000}$/.test(key)) throw userError('Ключ выглядит неправильно: он должен быть одной длинной строкой без пробелов.');
  const parts = key.split('.');
  if (parts.length === 3) {
    let role = '';
    try { role = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')).role; } catch { /* не JWT — пусть решит сервер */ }
    if (role === 'service_role') throw userError('Это секретный ключ (service_role). Его нельзя вставлять в лаунчер: возьмите публичный — anon.');
  }
  return { url: u.origin, key };
}

// ---------------------------------------------------------------- проверка данных с сервера

const safeName = (v) => { const s = String(v == null ? '' : v); return /^[A-Za-z0-9_.-]{3,16}$/.test(s) ? s : ''; };
const safePlaying = (v) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 64);

/** Аватар — PNG 8×8 в base64. Всё остальное отбрасываем: ничего, кроме маленькой картинки, в интерфейс не попадёт. */
function safeAvatarB64(v) {
  if (typeof v !== 'string' || !v || v.length > 2000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(v)) return '';
  const b = Buffer.from(v, 'base64');
  if (b.length < 33 || b.length > 1500 || b.readUInt32BE(0) !== 0x89504e47 || b.readUInt32BE(4) !== 0x0d0a1a0a) return '';
  if (b.toString('latin1', 12, 16) !== 'IHDR') return '';
  const w = b.readUInt32BE(16), h = b.readUInt32BE(20);
  return w >= 1 && h >= 1 && w <= 64 && h <= 64 ? v : '';
}
const avatarUrl = (b64) => (safeAvatarB64(b64) ? 'data:image/png;base64,' + b64 : '');

/** Имя для сервера: допустимые символы, 3–16 знаков. */
function serverName(name) {
  let s = String(name || '').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 16);
  while (s.length < 3) s += '_';
  return s;
}

function cleanState(raw) {
  const list = (arr, full) => (Array.isArray(arr) ? arr : []).slice(0, MAX_LIST).map((p) => {
    if (!p || typeof p !== 'object' || !UUID_RE.test(p.id || '') || !safeName(p.name)) return null;
    const o = { id: String(p.id).toLowerCase(), name: p.name, avatar: avatarUrl(p.avatar) };
    if (full) { o.online = p.online === true; o.playing = o.online ? safePlaying(p.playing) : ''; }
    return o;
  }).filter(Boolean);
  const me = raw && raw.me && CODE_RE.test(raw.me.code || '') ? { code: raw.me.code, pretty: prettyCode(raw.me.code), name: safeName(raw.me.name) } : null;
  return { me, friends: list(raw && raw.friends, true), incoming: list(raw && raw.incoming), outgoing: list(raw && raw.outgoing) };
}

// ---------------------------------------------------------------- ошибки сервера

const msgOf = (r) => String((r.data && (r.data.message || r.data.msg || r.data.error_description || r.data.error)) || r.text || '').slice(0, 200);

function authError(r) {
  const code = r.data && (r.data.error_code || r.data.code);
  const msg = msgOf(r);
  if (code === 'anonymous_provider_disabled' || /anonymous sign-?ins? (are|is) disabled/i.test(msg)) {
    return userError('В проекте Supabase выключен анонимный вход. Включите его: Authentication → Sign In / Providers → «Allow anonymous sign-ins».');
  }
  if (r.status === 429 || code === 'over_request_rate_limit') return userError('Supabase просит подождать: с этого адреса слишком много входов. Попробуйте через некоторое время.');
  if (r.status === 401 || r.status === 403 || /api key|apikey/i.test(msg)) return userError('Supabase не принял ключ проекта. Проверьте, что вставлен публичный ключ (anon или publishable) именно от этого проекта.');
  if (r.status === 404) return userError('Проект Supabase по этому адресу не найден. Проверьте адрес.');
  if (r.status >= 500) return paused(r.status);
  return userError(`Supabase ответил ошибкой ${r.status}${msg ? ': ' + msg : ''}`);
}
const paused = (status) => userError(`Сервер друзей сейчас недоступен (код ${status}). Если проект давно не использовали, Supabase мог его приостановить — откройте панель проекта и нажмите Restore.`);

function rpcError(r) {
  const code = r.data && r.data.code;
  const msg = msgOf(r);
  if (code === 'P0001') return userError(msg || 'Сервер друзей отказал.');
  if (r.status === 404 || code === 'PGRST202') return userError('На сервере нет схемы друзей. Выполните файл friends.sql в Supabase (SQL Editor): инструкция в friends/SETUP.md.');
  if (r.status === 403 || code === '42501') return userError('У лаунчера нет прав на сервере друзей. Выполните friends.sql целиком, без изменений.');
  if (r.status === 401) return userError('Сервер друзей не принял вход. Попробуйте ещё раз.');
  if (r.status >= 500) return paused(r.status);
  return userError(`Сервер друзей ответил ошибкой ${r.status}${msg ? ': ' + msg : ''}`);
}

// ---------------------------------------------------------------- хранилище

function createFriends({ dir, cipher, getConfig, getProfile, onChange = () => {}, intervalMs = SYNC_MS, now = Date.now }) {
  const file = path.join(dir, 'friends.json');
  const box = createSecretBox(cipher);

  let sess = null;            // { url, access, refresh, exp, uid }
  let sessLoaded = false;
  let lastAvatar = '';        // аватар, который уже отправлен на сервер
  let running = false, timer = null, nudgeTimer = null, failures = 0, queue = Promise.resolve();
  let renewals = 0;
  const view = { status: 'off', error: '', me: null, friends: [], incoming: [], outgoing: [] };

  // ------------------------------------------------ настройки

  /** → { url, key } | null; ошибка настроек не бросается, а показывается в состоянии. */
  function config() {
    try { const c = getConfig() || {}; return parseConfig(c.url, c.key); }
    catch (e) { return { error: e.message }; }
  }
  const cfgOrThrow = () => {
    const c = config();
    if (!c) throw userError('Друзья не настроены: укажите адрес и ключ проекта Supabase.');
    if (c.error) throw userError(c.error);
    return c;
  };

  function publicView() {
    const c = config();
    return {
      configured: !!c && !c.error, configError: c && c.error ? c.error : '',
      host: c && c.url ? new URL(c.url).host : '',
      status: view.status, error: view.error, renewals,
      me: view.me, friends: view.friends, incoming: view.incoming, outgoing: view.outgoing,
      secure: box.secure,
    };
  }
  const emit = () => { try { onChange(publicView()); } catch { /* интерфейс мог закрыться */ } };

  // ------------------------------------------------ сессия

  function loadSession() {
    if (sessLoaded) return;
    sessLoaded = true;
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      const s = box.open(raw.sec);
      if (s && typeof raw.url === 'string' && typeof s.access === 'string' && typeof s.refresh === 'string') sess = { url: raw.url, access: s.access, refresh: s.refresh, exp: +s.exp || 0, uid: s.uid || '' };
    } catch { /* нет файла или он повреждён: войдём заново */ }
  }
  function saveSession() {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ url: sess.url, sec: box.seal({ access: sess.access, refresh: sess.refresh, exp: sess.exp, uid: sess.uid }) }), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }
  function forgetSession() {
    sess = null; sessLoaded = true; lastAvatar = '';
    try { fs.unlinkSync(file); } catch { /* файла могло не быть */ }
  }

  function fromTokens(cfg, d) {
    if (!d || typeof d.access_token !== 'string' || typeof d.refresh_token !== 'string') throw userError('Supabase вернул неожиданный ответ при входе. Проверьте адрес проекта.');
    const ttl = Math.max(30, +d.expires_in || 3600);
    return { url: cfg.url, access: d.access_token, refresh: d.refresh_token, exp: now() + ttl * 1000, uid: (d.user && d.user.id) || '' };
  }

  async function ensureSession(cfg, signal, force) {
    loadSession();
    if (sess && sess.url !== cfg.url) { forgetSession(); } // сменили проект: старая сессия там не действует
    if (sess && !force && sess.exp - now() > 60000) return sess;
    const had = !!sess;
    if (sess) {
      const r = await request(`${cfg.url}/auth/v1/token?grant_type=refresh_token`, { method: 'POST', headers: { apikey: cfg.key }, json: { refresh_token: sess.refresh }, signal });
      if (r.ok) {
        sess = fromTokens(cfg, r.data);
        saveSession(); // сразу: токен обновления одноразовый
        return sess;
      }
      if (r.status === 400 || r.status === 401 || r.status === 403) forgetSession(); // сессия отозвана или устарела
      else throw authError(r);
    }
    const r = await request(`${cfg.url}/auth/v1/signup`, { method: 'POST', headers: { apikey: cfg.key }, json: {}, signal });
    if (!r.ok) throw authError(r);
    sess = fromTokens(cfg, r.data);
    saveSession();
    if (had) { renewals++; } // прежний вход потерян — друзей придётся добавить заново
    return sess;
  }

  async function rpc(fn, args, { signal } = {}) {
    const cfg = cfgOrThrow();
    let s = await ensureSession(cfg, signal);
    for (let attempt = 0; ; attempt++) {
      const r = await request(`${cfg.url}/rest/v1/rpc/${fn}`, { method: 'POST', headers: { apikey: cfg.key, Authorization: 'Bearer ' + s.access }, json: args || {}, signal });
      if (r.ok) return r.data;
      const code = r.data && r.data.code;
      if (attempt === 0 && r.status === 401) { s = await ensureSession(cfg, signal, true); continue; }
      if (attempt === 0 && code === '23503') { forgetSession(); renewals++; s = await ensureSession(cfg, signal); continue; } // пользователя удалили на сервере
      throw rpcError(r);
    }
  }

  // ------------------------------------------------ очередь, синхронизация

  const enqueue = (fn) => { const p = queue.then(fn); queue = p.catch(() => {}); return p; };

  function apply(raw) {
    const s = cleanState(raw);
    view.me = s.me; view.friends = s.friends; view.incoming = s.incoming; view.outgoing = s.outgoing;
    view.status = 'ok'; view.error = '';
    failures = 0;
    emit();
  }

  async function doSync() {
    const p = getProfile() || {};
    if (!p.name) throw userError('Нет аккаунта для друзей.');
    const avatar = safeAvatarB64(p.avatar);
    const sendAvatar = avatar && avatar !== lastAvatar;
    const raw = await rpc('friends_sync', { p_name: serverName(p.name), p_avatar: sendAvatar ? avatar : null, p_playing: p.playing ? safePlaying(p.playing) : null, p_hidden: !!p.hidden });
    if (sendAvatar) lastAvatar = avatar;
    apply(raw);
  }

  function syncNow() {
    return enqueue(async () => {
      if (!running) return;
      if (view.status !== 'ok') { view.status = 'connecting'; emit(); }
      try { await doSync(); }
      catch (e) { failures++; view.status = 'error'; view.error = e.message; emit(); throw e; }
    });
  }

  function schedule() {
    clearTimeout(timer);
    if (!running) return;
    const delay = failures ? Math.min(MAX_BACKOFF_MS, intervalMs * 2 ** Math.min(failures, 4)) : intervalMs;
    timer = setTimeout(async () => { try { await syncNow(); } catch { /* показано в состоянии */ } schedule(); }, delay);
    if (timer.unref) timer.unref();
  }

  // ------------------------------------------------ управление

  const api = {
    file, parseConfig,
    get secure() { return box.secure; },
    view: publicView,
    hasSession() { loadSession(); return !!sess; },

    /** Запустить обмен с сервером (если друзья настроены). */
    start() {
      const c = config();
      if (!c || c.error) { view.status = 'off'; view.error = ''; emit(); return; }
      running = true; failures = 0;
      syncNow().catch(() => {});
      schedule();
    },
    /** Остановить обмен (интерфейс остаётся с последними данными). */
    stop() { running = false; clearTimeout(timer); clearTimeout(nudgeTimer); view.status = 'off'; emit(); },
    /** Адрес или ключ изменились: начать заново. */
    restart() { api.stop(); view.me = null; view.friends = []; view.incoming = []; view.outgoing = []; view.error = ''; emit(); api.start(); },

    syncNow,
    /** Отправить статус чуть позже (ник, аватар или «играет» изменились). */
    nudge() {
      if (!running) return;
      clearTimeout(nudgeTimer);
      nudgeTimer = setTimeout(() => { syncNow().catch(() => {}); }, 600);
      if (nudgeTimer.unref) nudgeTimer.unref();
    },

    async request(code) {
      return enqueue(async () => {
        if (!running) throw userError('Друзья выключены.');
        if (!view.me) await doSync();
        const r = await rpc('friends_request', { p_code: String(code || '').slice(0, 40) });
        if (r && r.error) throw userError(String(r.error).slice(0, 200));
        apply(r.state);
        return { note: String(r.note || 'sent'), target: safeName(r.target) };
      });
    },
    accept: (id) => act('friends_accept', id),
    decline: (id) => act('friends_decline', id),
    remove: (id) => act('friends_remove', id),
    newCode() {
      return enqueue(async () => { if (!running) throw userError('Друзья выключены.'); apply(await rpc('friends_new_code')); return publicView(); });
    },

    /** Удалить себя с сервера и забыть вход. */
    deleteMe() {
      return enqueue(async () => {
        const c = config();
        if (c && !c.error && api.hasSession()) await rpc('friends_delete_me');
        running = false; clearTimeout(timer); clearTimeout(nudgeTimer);
        forgetSession();
        Object.assign(view, { status: 'off', error: '', me: null, friends: [], incoming: [], outgoing: [] });
        emit();
      });
    },

    /** Лаунчер закрывается: показаться друзьям «не в сети». Не бросает ошибок и не ждёт дольше ms. */
    async bye(ms = 1500) {
      if (!running || !sess) return;
      running = false; clearTimeout(timer);
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), ms);
      try { await rpc('friends_bye', {}, { signal: ac.signal }); } catch { /* не страшно: статус и так устареет через пару минут */ }
      clearTimeout(t);
    },
  };

  function act(fn, id) {
    return enqueue(async () => {
      if (!running) throw userError('Друзья выключены.');
      if (!UUID_RE.test(String(id || ''))) throw userError('Игрок не найден.');
      apply(await rpc(fn, { p_id: String(id).toLowerCase() }));
      return publicView();
    });
  }

  return api;
}

module.exports = { createFriends, parseConfig, safeAvatarB64, serverName, prettyCode, cleanState, CODE_RE };
