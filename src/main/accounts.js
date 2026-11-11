'use strict';
// Аккаунты лаунчера: оффлайн (только ник) и Ely.by.
//
// Секреты (токен Ely.by) лежат в accounts.json зашифрованными:
// на Windows — через DPAPI (Electron safeStorage), то есть расшифровать их может только тот же пользователь Windows
// на этом же компьютере. Если шифрование недоступно, файл всё равно создаётся с правами 0600, а токены
// хранятся в base64 — это не шифрование, поэтому лаунчер предупреждает об этом в журнале (см. store.secureStorage).
// В интерфейс секреты не попадают никогда: наружу отдаётся только view().

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ely = require('./elyby');
const authlib = require('./authlib');
const { offlineUuid } = require('./minecraft');
const { userError } = require('./net');
const { fetchBuffer } = require('./download');
const { createSecretBox, plainCipher } = require('./secretbox');

const NICK_RE = /^[A-Za-z0-9_]{3,16}$/;
const TYPES = ['offline', 'elyby']; // записи других типов (например, Microsoft из версии 1.4.0) при чтении отбрасываются
const ID_RE = /^[a-f0-9]{12}$/;

function createAccountStore({ dir, cipher = plainCipher(), fallbackName = () => 'Player' }) {
  const file = path.join(dir, 'accounts.json');
  const avatarDir = path.join(dir, 'avatars');
  let data = { active: null, accounts: [] };
  const pending = new Set(); // фоновые задачи (аннулирование токена, загрузка аватара) — нужны тестам

  const track = (p) => { pending.add(p); p.finally(() => pending.delete(p)).catch(() => {}); return p; };

  // ------------------------------------------------ секреты

  const box = createSecretBox(cipher);
  const { seal, open } = box;

  // ------------------------------------------------ файл

  function clean(a) {
    if (!a || typeof a !== 'object' || !TYPES.includes(a.type) || !ID_RE.test(a.id || '')) return null;
    const name = String(a.name || '').replace(/[\u0000-\u001f]/g, '').slice(0, 64);
    if (!name) return null;
    const out = { id: a.id, type: a.type, name, uuid: /^[a-f0-9]{32}$/.test(a.uuid || '') ? a.uuid : offlineUuid(name), createdAt: +a.createdAt || Date.now() };
    if (a.type !== 'offline') {
      out.sec = typeof a.sec === 'string' ? a.sec : '';
      out.needsLogin = !!a.needsLogin;
    }
    return out;
  }

  function load() {
    let raw = {};
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* первый запуск */ }
    data = { active: null, accounts: (Array.isArray(raw.accounts) ? raw.accounts : []).map(clean).filter(Boolean) };
    data.active = data.accounts.find((a) => a.id === raw.active) ? raw.active : (data.accounts[0] ? data.accounts[0].id : null);
    // Записи неизвестного типа (Microsoft из версии 1.4.0) отброшены — стираем с диска и их токены, и их аватары.
    if (Array.isArray(raw.accounts) && raw.accounts.length !== data.accounts.length) {
      try { persist(); } catch { /* не страшно: отбросим снова при следующем запуске */ }
      try { for (const f of fs.readdirSync(avatarDir)) if (!data.accounts.some((a) => f === a.id + '.png')) fs.unlinkSync(path.join(avatarDir, f)); } catch { /* папки может не быть */ }
    }
  }

  function persist() {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  // ------------------------------------------------ публичный вид

  function readAvatar(id) {
    try { return 'data:image/png;base64,' + fs.readFileSync(path.join(avatarDir, id + '.png')).toString('base64'); } catch { return ''; }
  }
  function needsLogin(a) { return a.type !== 'offline' && (a.needsLogin || !open(a.sec)); }

  /** То, что видит интерфейс. Токенов здесь нет. */
  function view(a) {
    const v = { id: a.id, type: a.type, name: a.name, uuid: a.uuid, needsLogin: needsLogin(a) };
    if (a.type !== 'offline') v.avatar = readAvatar(a.id);
    return v;
  }

  function find(id) {
    const a = data.accounts.find((x) => x.id === id);
    if (!a) throw userError('Аккаунт не найден.');
    return a;
  }
  const newId = () => { let id; do { id = crypto.randomBytes(6).toString('hex'); } while (data.accounts.some((a) => a.id === id)); return id; };

  load();

  // ------------------------------------------------ операции

  const store = {
    file, pending,
    /** true, если токены шифруются средствами ОС. */
    get secureStorage() { return box.secure; },
    idle() { return Promise.allSettled([...pending]); },

    list() { return { active: data.active, accounts: data.accounts.map(view) }; },
    get(id) { return view(find(id)); },
    activeId() { return data.active; },

    /** Гарантирует, что есть хотя бы один аккаунт (оффлайн с таким ником, как раньше в настройках). */
    ensureOne(nick) {
      if (data.accounts.length) return;
      store.addOffline(NICK_RE.test(nick || '') ? nick : fallbackName());
    },

    addOffline(name) {
      name = String(name || '').trim();
      if (!NICK_RE.test(name)) throw userError('Ник: 3–16 символов, латиница, цифры и _');
      let a = data.accounts.find((x) => x.type === 'offline' && x.name.toLowerCase() === name.toLowerCase());
      if (!a) {
        a = { id: newId(), type: 'offline', name, uuid: offlineUuid(name), createdAt: Date.now() };
        data.accounts.push(a);
      }
      data.active = a.id;
      persist();
      return view(a);
    },

    renameOffline(id, name) {
      const a = find(id);
      if (a.type !== 'offline') throw userError('Ник можно менять только у оффлайн-аккаунта.');
      name = String(name || '').trim();
      if (!NICK_RE.test(name)) throw userError('Ник: 3–16 символов, латиница, цифры и _');
      if (data.accounts.some((x) => x.id !== id && x.type === 'offline' && x.name.toLowerCase() === name.toLowerCase())) throw userError('Оффлайн-аккаунт с таким ником уже есть.');
      a.name = name; a.uuid = offlineUuid(name);
      persist();
      return view(a);
    },

    /** Добавляет или обновляет (тот же игрок — тот же аккаунт) аккаунт Ely.by и делает его активным. */
    upsertOnline(type, fields, secrets) {
      if (type !== 'elyby') throw new Error('Неизвестный тип аккаунта');
      let a = data.accounts.find((x) => x.type === type && x.uuid === fields.uuid);
      if (!a) { a = { id: newId(), type, createdAt: Date.now() }; data.accounts.push(a); }
      Object.assign(a, { name: fields.name, uuid: fields.uuid, needsLogin: false, sec: seal(secrets) });
      data.active = a.id;
      persist();
      return view(a);
    },

    setActive(id) { find(id); data.active = id; persist(); return store.list(); },

    remove(id) {
      const a = find(id);
      if (a.type === 'elyby') {
        const s = open(a.sec);
        if (s && s.accessToken) track(ely.invalidate(s.accessToken, s.clientToken));
      }
      data.accounts = data.accounts.filter((x) => x.id !== id);
      try { fs.unlinkSync(path.join(avatarDir, id + '.png')); } catch { /* нет аватара */ }
      if (data.active === id) data.active = data.accounts[0] ? data.accounts[0].id : null;
      store.ensureOne();
      persist();
      return store.list();
    },

    /** Обновляет поля и секреты уже существующего аккаунта Ely.by (после refresh). */
    update(id, fields, secrets) {
      const a = find(id);
      if (fields) {
        if (fields.name) a.name = fields.name;
        if (fields.uuid) a.uuid = fields.uuid;
      }
      if (secrets) { a.sec = seal({ ...(open(a.sec) || {}), ...secrets }); a.needsLogin = false; }
      persist();
      return view(a);
    },

    markNeedsLogin(id) { const a = find(id); a.needsLogin = true; persist(); },

    // ------------------------------------------------ сессии

    /**
     * Свежие данные для входа в игру. Для Ely.by проверяет токен (при необходимости обновляет)
     * и подготавливает authlib-injector.
     * → { online, account (view), auth | null, javaAgent | null }
     */
    async prepareLaunch(id, { signal, log = () => {}, authlibDir } = {}) {
      const a = find(id);
      if (a.type === 'offline') return { online: false, account: view(a), auth: null, javaAgent: null };

      const sec = await store.session(id, { signal, log });
      const jar = await authlib.ensure(authlibDir, { signal });
      return { online: true, account: view(a), auth: { username: a.name, uuid: a.uuid, accessToken: sec.accessToken, userType: 'mojang' }, javaAgent: { jar, api: ely.agentApi() } };
    },

    /** Действующая сессия аккаунта Ely.by: расшифрованные секреты, обновлённые при необходимости. */
    async session(id, { signal, log = () => {}, force = false } = {}) {
      const a = find(id);
      if (a.type === 'offline') throw new Error('У оффлайн-аккаунта нет сессии');
      let sec = open(a.sec);
      if (!sec || a.needsLogin) throw userError(`Войдите в аккаунт «${a.name}» заново.`, { relogin: true });
      try {
        const fresh = force ? await ely.refresh(sec.accessToken, sec.clientToken, { signal }) : await ely.ensureValid(sec, { signal });
        if (fresh) {
          store.update(id, { name: fresh.name, uuid: fresh.uuid }, { accessToken: fresh.accessToken, clientToken: fresh.clientToken });
          sec = open(find(id).sec);
        }
      } catch (e) {
        if (signal && signal.aborted) throw e;
        if (e.relogin) { store.markNeedsLogin(id); throw e; }
        // Сеть недоступна или сервер ответил странно: одиночная игра от этого не пострадает, поэтому не блокируем запуск.
        log(`Не удалось обновить вход в «${a.name}»: ${e.message} Игра запустится, но вход на серверы может не сработать.`, 'warn');
      }
      return sec;
    },

    // ------------------------------------------------ аватар

    /** Скачивает текстуру скина аккаунта для показа аватара. Ошибки не важны. */
    async refreshAvatar(id, { signal } = {}) {
      const a = find(id);
      if (a.type !== 'elyby') return;
      const url = ely.skinUrlFor(a.name);
      const buf = await fetchBuffer(url, { signal, retries: 1, timeout: 10000 });
      if (buf.length < 100 || buf.length > 1024 * 1024 || buf.readUInt32BE(0) !== 0x89504e47) return;
      fs.mkdirSync(avatarDir, { recursive: true });
      fs.writeFileSync(path.join(avatarDir, id + '.png'), buf);
    },
  };
  return store;
}

module.exports = { createAccountStore, plainCipher, NICK_RE };
