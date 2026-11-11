(function () {
  'use strict';

  const api = window.api;
  const SL = window.SkinLayout;
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const NICK_RE = /^[A-Za-z0-9_]{3,16}$/;

  const state = {
    settings: null, info: null,
    versions: [], latest: null, offline: false, selected: '', loader: 'vanilla',
    play: 'idle', stage: '', prog: null,
    skins: [], activeId: null, curId: null, thumbs: {},
    acc: { active: null, accounts: [], secure: true }, stageAccount: null,
    fr: null,
    view: 'play',
  };

  // ------------------------------------------------------------------ утилиты

  const debounce = (fn, ms) => { let t; const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; d.flush = (...a) => { clearTimeout(t); return fn(...a); }; d.cancel = () => clearTimeout(t); return d; };
  const fmtBytes = (n) => (n >= 1073741824 ? (n / 1073741824).toFixed(2).replace('.', ',') + ' ГБ' : n >= 1048576 ? Math.round(n / 1048576) + ' МБ' : Math.max(1, Math.round(n / 1024)) + ' КБ');
  const fmtNum = (n) => n.toLocaleString('ru-RU');
  const fmtGb = (mb) => (mb / 1024).toLocaleString('ru-RU', { maximumFractionDigits: 1 }) + ' ГБ';
  const errText = (e) => String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

  function toast(text, kind, ms) {
    const box = $('#toasts');
    const el = document.createElement('div');
    el.className = 'toast' + (kind === 'bad' ? ' bad' : '');
    el.textContent = text;
    box.appendChild(el);
    const life = ms || (kind === 'bad' ? 7000 : 3200);
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, life);
    while (box.children.length > 3) box.firstChild.remove();
  }

  function confirmDialog({ title, text, ok }) {
    return new Promise((resolve) => {
      const dlg = $('#dlg-confirm');
      $('#dlg-confirm-title').textContent = title;
      $('#dlg-confirm-text').textContent = text;
      $('#dlg-confirm-ok').textContent = ok || 'Удалить';
      dlg.returnValue = 'cancel';
      dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true });
      dlg.showModal();
    });
  }

  // ------------------------------------------------------------------ окно и вкладки

  $$('[data-win]').forEach((b) => b.addEventListener('click', () => {
    const k = b.dataset.win;
    api.win[k === 'maximize' ? 'toggleMaximize' : k]();
  }));

  function showView(name) {
    state.view = name;
    $$('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.view === name)));
    $$('.view').forEach((v) => { v.hidden = v.id !== 'view-' + name; });
    if (name !== 'skins') flushSave();
    if (name === 'friends' && state.fr && state.fr.enabled) api.friends.sync().catch(() => {});
  }
  $$('.tab').forEach((t) => t.addEventListener('click', () => showView(t.dataset.view)));
  $('#play-edit-skin').addEventListener('click', () => showView('skins'));

  // ------------------------------------------------------------------ журнал

  const logEl = $('#log');
  const logLines = [];
  function addLog(line, tag) {
    logLines.push(line);
    const span = document.createElement('span');
    span.className = tag === 'err' ? 'err' : tag === 'warn' ? 'warn' : tag === 'info' ? 'info' : '';
    span.textContent = line + '\n';
    const stick = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 30;
    logEl.appendChild(span);
    if (logLines.length > 3000) { logLines.shift(); logEl.firstChild.remove(); }
    if (stick) logEl.scrollTop = logEl.scrollHeight;
  }
  function setDrawer(open) {
    const d = $('#drawer');
    d.classList.toggle('open', open);
    d.setAttribute('aria-hidden', String(!open));
    $('#btn-log').setAttribute('aria-pressed', String(open));
    if (open) logEl.scrollTop = logEl.scrollHeight;
  }
  $('#btn-log').addEventListener('click', () => setDrawer(!$('#drawer').classList.contains('open')));
  $('#log-close').addEventListener('click', () => setDrawer(false));
  $('#log-clear').addEventListener('click', () => { logLines.length = 0; logEl.textContent = ''; });
  $('#log-copy').addEventListener('click', async () => {
    const text = logLines.join('\n');
    try { await navigator.clipboard.writeText(text); }
    catch {
      const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
    }
    toast('Журнал скопирован');
  });

  // ------------------------------------------------------------------ настройки

  const settingsSaved = debounce((patch) => api.setSettings(patch).then((s) => { state.settings = s; }), 250);
  function setSetting(patch) { Object.assign(state.settings, patch); return settingsSaved(patch); }

  function initSettingsView() {
    const s = state.settings, info = state.info;
    const ram = $('#s-ram');
    const maxMb = Math.max(2048, Math.min(16384, Math.floor(info.totalMemMb / 512) * 512));
    ram.max = String(maxMb);
    ram.value = String(Math.min(s.ramMb, maxMb));
    const showRam = () => { $('#s-ram-out').textContent = fmtGb(parseInt(ram.value, 10)); };
    showRam();
    ram.addEventListener('input', () => { showRam(); setSetting({ ramMb: parseInt(ram.value, 10) }); });

    const setJavaMode = (mode) => {
      $$('#s-java-mode .seg-btn').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.java === mode)));
      $('#s-java-row').hidden = mode !== 'custom';
      $('#s-java-hint').textContent = mode === 'auto' ? 'Лаунчер сам скачает нужную версию Java.' : 'Игра запустится с указанной вами Java. Для новых версий нужна Java 17 или 21.';
    };
    $('#s-java').value = s.javaPath || '';
    setJavaMode(s.javaPath ? 'custom' : 'auto');
    $$('#s-java-mode .seg-btn').forEach((b) => b.addEventListener('click', () => {
      setJavaMode(b.dataset.java);
      if (b.dataset.java === 'auto') { $('#s-java').value = ''; setSetting({ javaPath: '' }); } else $('#s-java').focus();
    }));
    $('#s-java').addEventListener('input', (e) => setSetting({ javaPath: e.target.value.trim() }));
    $('#s-java-pick').addEventListener('click', async () => {
      const p = await api.pickJava();
      if (p) { $('#s-java').value = p; setSetting({ javaPath: p }); }
    });

    const showDir = () => { $('#s-dir').textContent = state.settings.gameDir || info.defaultGameDir; };
    showDir();
    $('#s-dir-open').addEventListener('click', () => api.openGameDir());
    $('#s-mods-open').addEventListener('click', () => api.openGameDir('mods'));
    $('#s-dir-pick').addEventListener('click', async () => {
      const p = await api.pickDir();
      if (!p) return;
      await setSetting({ gameDir: p });
      showDir();
      await loadVersions(false);
      toast('Папка игры изменена');
    });

    // Тема применяется сразу: главный процесс меняет nativeTheme, а CSS и canvas подхватывают prefers-color-scheme.
    const showTheme = (t) => $$('#s-theme .seg-btn').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.theme === t)));
    showTheme(s.theme || 'light');
    $$('#s-theme .seg-btn').forEach((b) => b.addEventListener('click', async () => {
      const t = b.dataset.theme;
      showTheme(t);
      if (window.Theme) window.Theme.set(t); // сразу, не дожидаясь сохранения
      try { state.settings = await api.setSettings({ theme: t }); } catch (e) { toast(errText(e), 'bad'); }
    }));

    const bindSwitch = (id, key) => {
      const el = $(id); el.checked = !!s[key];
      el.addEventListener('change', () => setSetting({ [key]: el.checked }));
    };
    bindSwitch('#s-skin', 'applySkin'); bindSwitch('#s-lang', 'gameLang'); bindSwitch('#s-hide', 'hideOnLaunch');
    $('#s-jvm').value = s.jvmArgs || '';
    $('#s-jvm').addEventListener('input', (e) => setSetting({ jvmArgs: e.target.value }));
    $('#about').textContent = `Unlucky ${info.version} — неофициальный лаунчер. Файлы игры скачиваются с серверов Mojang. Minecraft — торговая марка Mojang AB.`;
  }

  // ------------------------------------------------------------------ аккаунты

  const TYPE_NAME = { offline: 'оффлайн', elyby: 'Ely.by' };
  const ELY_SKINS_URL = 'https://ely.by/skins';
  const ELY_REGISTER_URL = 'https://account.ely.by/register';
  const accBtn = $('#acc-btn'), accPop = $('#acc-pop'), accList = $('#acc-list');
  const activeAccount = () => state.acc.accounts.find((a) => a.id === state.acc.active) || null;
  const fieldErr = (el, msg) => { el.textContent = msg || ''; el.classList.toggle('bad', !!msg); };
  const openExternal = (url) => api.openExternal(url).catch((e) => toast(errText(e), 'bad'));

  const imageCache = new Map();
  function loadImage(url) {
    if (!imageCache.has(url)) {
      imageCache.set(url, new Promise((resolve) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = () => resolve(null); i.src = url; }));
      if (imageCache.size > 40) imageCache.delete(imageCache.keys().next().value);
    }
    return imageCache.get(url);
  }

  /** Текстура 64×64 из PNG: старый формат 64×32 достраивается так же, как это делает игра. */
  async function textureFromDataUrl(url) {
    const img = await loadImage(url);
    if (!img) return null;
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const x = c.getContext('2d', { willReadFrequently: true });
    if (img.height === 32) {
      x.drawImage(img, 0, 0);
      x.putImageData(new ImageData(SL.upgradeLegacy(x.getImageData(0, 0, 64, 32).data), 64, 64), 0, 0);
    } else x.drawImage(img, 0, 0, 64, 64);
    return c;
  }

  /** Голова игрока 8×8: у оффлайн-аккаунта — из выбранного скина, у онлайн-аккаунта — из скина профиля. */
  async function paintAvatar(canvas, a) {
    const t = canvas._t = (canvas._t || 0) + 1;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, 8, 8);
    const url = !a ? '' : (a.type === 'offline' ? (state.thumbs[state.activeId] || '') : (a.avatar || ''));
    if (!url) return;
    const img = await loadImage(url);
    if (!img || canvas._t !== t) return;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, 8, 8);
    if (a.type === 'offline') ctx.drawImage(img, 0, 0, 8, 8);
    else { ctx.drawImage(img, 8, 8, 8, 8, 0, 0, 8, 8); ctx.drawImage(img, 40, 8, 8, 8, 0, 0, 8, 8); }
  }

  function accountHint(a) {
    if (!a) return ['Добавьте аккаунт', true];
    if (a.needsLogin) return ['Нужно войти заново', true];
    return [{ offline: 'Скин виден только вам', elyby: 'Скин с Ely.by — на серверах с Ely.by' }[a.type], false];
  }

  function renderAccountButton() {
    const a = activeAccount();
    $('#acc-current').textContent = a ? a.name : 'Нет аккаунта';
    $('#acc-meta').textContent = a ? TYPE_NAME[a.type] : '';
    const [text, bad] = accountHint(a);
    const h = $('#acc-hint'); h.textContent = text; h.classList.toggle('bad', bad);
    paintAvatar($('#acc-avatar'), a);
    pushMyAvatar();
  }

  /** Голова активного аккаунта (PNG 8×8) уходит в главный процесс: оттуда её получают друзья. */
  const pushMyAvatar = debounce(async () => {
    const a = activeAccount(); if (!a) return;
    const c = document.createElement('canvas'); c.width = c.height = 8;
    await paintAvatar(c, a);
    const px = c.getContext('2d').getImageData(0, 0, 8, 8).data;
    if (!px.some((v, i) => i % 4 === 3 && v > 0)) return; // пока пусто (скин ещё грузится)
    const url = c.toDataURL('image/png');
    api.friends.setAvatar(url.slice(url.indexOf(',') + 1)).catch(() => {});
  }, 500);

  function iconButton(icon, title, act, danger) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'pi-btn' + (danger ? ' danger' : ''); b.dataset.act = act; b.title = title; b.setAttribute('aria-label', title);
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg'); svg.setAttribute('viewBox', '0 0 24 24');
    const use = document.createElementNS(NS, 'use'); use.setAttribute('href', '#' + icon);
    svg.appendChild(use); b.appendChild(svg);
    return b;
  }

  function renderAccountList() {
    accList.textContent = '';
    for (const a of state.acc.accounts) {
      const li = document.createElement('li');
      li.className = 'pop-item'; li.setAttribute('role', 'option'); li.dataset.id = a.id;
      li.setAttribute('aria-selected', String(a.id === state.acc.active));
      const av = document.createElement('canvas'); av.className = 'avatar'; av.width = av.height = 8;
      const name = document.createElement('span'); name.className = 'pi-name'; name.textContent = a.name;
      const tag = document.createElement('span'); tag.className = 'pi-tag' + (a.needsLogin ? ' bad' : ''); tag.textContent = a.needsLogin ? 'нужен вход' : TYPE_NAME[a.type];
      li.append(av, name, tag);
      if (a.type === 'offline') li.append(iconButton('i-pencil', 'Изменить ник', 'rename'));
      li.append(iconButton('i-trash', 'Удалить аккаунт', 'remove', true));
      accList.appendChild(li);
      paintAvatar(av, a);
    }
  }

  function renderAccounts() {
    renderAccountButton();
    if (!accPop.hidden) renderAccountList();
    updateSkinAccountUi();
    syncStageSkin();
  }
  async function loadAccounts() { state.acc = await api.accounts.list(); renderAccounts(); }

  function openAccPop() { closePop(); accPop.hidden = false; accBtn.setAttribute('aria-expanded', 'true'); renderAccountList(); }
  function closeAccPop(refocus) {
    if (accPop.hidden) return;
    accPop.hidden = true; accBtn.setAttribute('aria-expanded', 'false');
    if (refocus) accBtn.focus();
  }
  accBtn.addEventListener('click', () => (accPop.hidden ? openAccPop() : closeAccPop()));
  document.addEventListener('pointerdown', (e) => { if (!accPop.hidden && !accPop.contains(e.target) && !accBtn.contains(e.target)) closeAccPop(); });

  function reloginAccount(a) { openElyDialog(a.name); }

  async function selectAccount(a) {
    closeAccPop(true);
    if (a.needsLogin) { reloginAccount(a); return; } // выбрать такой аккаунт можно, только войдя в него заново
    try { state.acc = await api.accounts.setActive(a.id); renderAccounts(); } catch (e) { toast(errText(e), 'bad'); }
  }

  async function removeAccount(a) {
    const text = a.type === 'offline'
      ? `Оффлайн-аккаунт «${a.name}» исчезнет из лаунчера. Миры и скины останутся.`
      : `Лаунчер забудет вход в «${a.name}» (${TYPE_NAME[a.type]}). Сам аккаунт не пострадает — войти можно снова.`;
    if (!(await confirmDialog({ title: 'Удалить аккаунт?', text, ok: 'Удалить' }))) return;
    try { state.acc = await api.accounts.remove(a.id); renderAccounts(); toast('Аккаунт удалён'); } catch (e) { toast(errText(e), 'bad'); }
  }

  accList.addEventListener('click', (e) => {
    const li = e.target.closest('.pop-item');
    if (!li) return;
    const a = state.acc.accounts.find((x) => x.id === li.dataset.id);
    if (!a) return;
    const btn = e.target.closest('.pi-btn');
    if (btn) { closeAccPop(); if (btn.dataset.act === 'rename') openOfflineDialog(a); else removeAccount(a); return; }
    selectAccount(a);
  });
  $('#acc-add-offline').addEventListener('click', () => { closeAccPop(); openOfflineDialog(null); });
  $('#acc-add-ely').addEventListener('click', () => { closeAccPop(); openElyDialog(''); });

  // --- оффлайн-аккаунт
  const dOff = $('#dlg-offline'), offIn = $('#dlg-offline-input'), offErr = $('#dlg-offline-err'), offOk = $('#dlg-offline-ok');
  let offEditId = null;
  function openOfflineDialog(a) {
    offEditId = a ? a.id : null;
    $('#dlg-offline-title').textContent = a ? 'Изменить ник' : 'Оффлайн-аккаунт';
    offIn.value = a ? a.name : ''; fieldErr(offErr, ''); offOk.disabled = false;
    dOff.showModal(); offIn.focus(); offIn.select();
  }
  offIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); offOk.click(); } });
  offOk.addEventListener('click', async (e) => {
    e.preventDefault();
    const nick = offIn.value.trim();
    if (!NICK_RE.test(nick)) { fieldErr(offErr, 'Ник: 3–16 символов, латиница, цифры и _'); return; }
    offOk.disabled = true;
    try {
      state.acc = offEditId ? await api.accounts.rename(offEditId, nick) : await api.accounts.addOffline(nick);
      dOff.close(); renderAccounts();
    } catch (err) { fieldErr(offErr, errText(err)); }
    offOk.disabled = false;
  });

  // --- Ely.by
  const dEly = $('#dlg-ely'), elyLogin = $('#ely-login'), elyPass = $('#ely-pass'), elyTotp = $('#ely-totp'), elyErr = $('#ely-err'), elyOk = $('#ely-ok');
  function openElyDialog(login) {
    elyLogin.value = login || ''; elyPass.value = ''; elyTotp.value = ''; elyTotp.hidden = true; fieldErr(elyErr, ''); elyOk.disabled = false;
    dEly.showModal(); (login ? elyPass : elyLogin).focus();
  }
  dEly.addEventListener('close', () => { elyPass.value = ''; elyTotp.value = ''; }); // пароль в памяти страницы не задерживаем
  $('#ely-cancel').addEventListener('click', () => api.accounts.cancelLogin());
  $('#ely-register').addEventListener('click', () => openExternal(ELY_REGISTER_URL));
  [elyLogin, elyPass, elyTotp].forEach((el) => el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); elyOk.click(); } }));
  elyOk.addEventListener('click', async (e) => {
    e.preventDefault();
    if (!elyLogin.value.trim() || !elyPass.value) { fieldErr(elyErr, 'Введите логин и пароль'); return; }
    elyOk.disabled = true; fieldErr(elyErr, ''); elyErr.textContent = 'Вхожу…';
    try {
      const r = await api.accounts.elyLogin({ login: elyLogin.value, password: elyPass.value, totp: elyTotp.hidden ? '' : elyTotp.value });
      if (r && r.twoFactor) {
        elyTotp.hidden = false; elyTotp.focus();
        fieldErr(elyErr, ''); elyErr.textContent = 'Включена двухфакторная защита — введите код из приложения';
      } else if (r && r.ok) {
        state.acc = r.accounts; dEly.close(); renderAccounts();
        toast('Вход выполнен: ' + ((activeAccount() || {}).name || ''));
      } else fieldErr(elyErr, '');
    } catch (err) { fieldErr(elyErr, errText(err)); }
    elyOk.disabled = false;
  });

  // --- скин аккаунта на вкладке «Скины»
  function updateSkinAccountUi() {
    const a = activeAccount(), btn = $('#sk-account'), note = $('#sk-account-note');
    if (a && a.type === 'elyby') {
      btn.hidden = false;
      note.textContent = 'Ely.by не принимает скины от лаунчеров: сохраним PNG и откроем ely.by/skins. Скин видят игроки на серверах с Ely.by.';
    } else {
      btn.hidden = true;
      note.textContent = 'В оффлайн-режиме скин видите только вы. Чтобы вас видели другие, войдите через Ely.by (на серверах, которые его принимают).';
    }
  }

  $('#sk-account').addEventListener('click', async () => {
    const a = activeAccount(), btn = $('#sk-account');
    if (!a || a.type !== 'elyby' || !state.curId) return;
    btn.disabled = true;
    try {
      await flushSave();
      if (await api.skins.export(state.curId)) {
        await openExternal(ELY_SKINS_URL);
        toast('Выберите сохранённый PNG на странице Ely.by');
      }
    } catch (e) { toast(errText(e), 'bad'); }
    btn.disabled = false;
  });

  // --- что показываем на сцене: скин аккаунта с сервера или выбранный локальный скин
  let stageToken = 0;
  async function syncStageSkin() {
    const token = ++stageToken;
    const a = activeAccount(), caption = $('#play-skin-name');
    if (a && a.type !== 'offline') {
      state.stageAccount = a.id;
      const tex = a.avatar ? await textureFromDataUrl(a.avatar) : null;
      if (token !== stageToken) return;
      if (tex) { playViewer.setTexture(tex); playViewer.setModel(await guessModel(a.avatar)); caption.textContent = `Скин аккаунта ${a.name}`; }
      else caption.textContent = 'Скин аккаунта пока не получен';
      return;
    }
    state.stageAccount = null;
    const m = activeMeta();
    caption.textContent = m ? m.name : 'Скин не выбран';
    if (!m) return;
    playViewer.setModel(m.model);
    let tex = state.curId === state.activeId ? editor.tex : null; // скин сейчас открыт в редакторе — берём его живую текстуру
    if (!tex) tex = await textureFromDataUrl(await api.skins.get(m.id));
    if (token === stageToken && tex) playViewer.setTexture(tex);
  }

  // ------------------------------------------------------------------ версии

  const typeName = { release: 'релиз', snapshot: 'снапшот', custom: 'своя' };
  const loaderName = { vanilla: 'Vanilla', fabric: 'Fabric', forge: 'Forge' };
  const verBtn = $('#ver-btn'), pop = $('#ver-pop'), verList = $('#ver-list'), verSearch = $('#ver-search');
  let kbIndex = -1;

  function currentVersion() { return state.versions.find((v) => v.id === state.selected); }

  function renderVersionButton() {
    const v = currentVersion();
    $('#ver-current').textContent = v ? v.id : (state.selected || 'Нет версий');
    const status = v ? (v.installed ? 'установлена' : (state.loader === 'forge' && v.loaderVersion ? v.loaderVersion : typeName[v.type] || '')) : '';
    $('#ver-meta').textContent = state.loader === 'vanilla' ? status : [loaderName[state.loader], status].filter(Boolean).join(' · ');
    updateIdleStatus();
    updatePlayButton();
  }

  const snapBtn = $('#ver-snap');
  const snapsOn = () => snapBtn.getAttribute('aria-pressed') === 'true';

  /** Прокрутка внутри списка без сдвига всей страницы (scrollIntoView двигает и родителей). */
  function scrollInList(el, center) {
    const lr = verList.getBoundingClientRect(), er = el.getBoundingClientRect();
    if (center) verList.scrollTop += (er.top - lr.top) - (lr.height - er.height) / 2;
    else if (er.top < lr.top) verList.scrollTop -= lr.top - er.top;
    else if (er.bottom > lr.bottom) verList.scrollTop += er.bottom - lr.bottom;
  }

  function visibleVersions() {
    const q = verSearch.value.trim().toLowerCase();
    const snaps = snapsOn();
    return state.versions.filter((v) => (snaps || v.type !== 'snapshot' || v.id === state.selected) && (!q || v.id.toLowerCase().includes(q)));
  }

  function renderVersionList() {
    const items = visibleVersions();
    verList.textContent = '';
    if (!items.length) {
      const li = document.createElement('li'); li.className = 'pop-empty';
      li.textContent = state.loading ? 'Загрузка списка…' : (state.versions.length ? 'Ничего не найдено' : (state.offline ? 'Нет связи — список недоступен' : 'Нет версий'));
      verList.appendChild(li); return;
    }
    const frag = document.createDocumentFragment();
    for (const v of items) {
      const li = document.createElement('li');
      li.className = 'pop-item'; li.setAttribute('role', 'option'); li.dataset.id = v.id;
      li.setAttribute('aria-selected', String(v.id === state.selected));
      const id = document.createElement('span'); id.className = 'pi-id'; id.textContent = v.id;
      const tag = document.createElement('span'); tag.className = 'pi-tag';
      tag.textContent = v.installed ? 'установлена' : (state.loader === 'forge' && v.loaderVersion ? v.loaderVersion : (v.type === 'release' ? '' : typeName[v.type] || ''));
      li.append(id, tag);
      frag.appendChild(li);
    }
    verList.appendChild(frag);
    const sel = verList.querySelector('[aria-selected="true"]');
    if (sel) scrollInList(sel, true);
    kbIndex = -1;
  }

  function showLoader() {
    $$('#ver-loader .seg-btn').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.loader === state.loader)));
    snapBtn.hidden = state.loader === 'forge'; // у Forge снапшотов нет
  }

  function openPop() {
    closeAccPop();
    pop.hidden = false; verBtn.setAttribute('aria-expanded', 'true');
    snapBtn.setAttribute('aria-pressed', String(!!state.settings.showSnapshots || !!(currentVersion() && currentVersion().type === 'snapshot')));
    showLoader();
    verSearch.value = '';
    renderVersionList();
    // не даём списку вылезти за нижний край окна
    const room = window.innerHeight - pop.getBoundingClientRect().top - 16 - 96;
    verList.style.maxHeight = Math.max(120, Math.min(300, room)) + 'px';
    verSearch.focus({ preventScroll: true });
  }
  function closePop(refocus) {
    if (pop.hidden) return;
    pop.hidden = true; verBtn.setAttribute('aria-expanded', 'false');
    if (refocus) verBtn.focus();
  }
  function selectVersion(id) {
    state.selected = id;
    setSetting({ version: id });
    renderVersionButton();
    closePop(true);
  }

  verBtn.addEventListener('click', () => (pop.hidden ? openPop() : closePop()));

  // Тип версии: Vanilla / Fabric / Forge. Для Fabric и Forge лаунчер сам скачает загрузчик при первом запуске.
  $$('#ver-loader .seg-btn').forEach((b) => b.addEventListener('click', async () => {
    const l = b.dataset.loader;
    if (l === state.loader) return;
    state.loader = l;
    setSetting({ loader: l });
    showLoader();
    verSearch.value = '';
    state.versions = []; state.loading = true;
    renderVersionList();
    await loadVersions(true);
    if (!pop.hidden) renderVersionList();
  }));
  verSearch.addEventListener('input', renderVersionList);
  snapBtn.addEventListener('click', () => { const on = !snapsOn(); snapBtn.setAttribute('aria-pressed', String(on)); setSetting({ showSnapshots: on }); renderVersionList(); });
  verList.addEventListener('click', (e) => { const li = e.target.closest('.pop-item'); if (li) selectVersion(li.dataset.id); });
  verSearch.addEventListener('keydown', (e) => {
    const items = $$('.pop-item', verList);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      kbIndex = Math.max(0, Math.min(items.length - 1, kbIndex + (e.key === 'ArrowDown' ? 1 : -1)));
      items.forEach((it, i) => it.classList.toggle('kb', i === kbIndex));
      if (items[kbIndex]) scrollInList(items[kbIndex], false);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const it = items[Math.max(0, kbIndex)];
      if (it) selectVersion(it.dataset.id);
    }
  });
  document.addEventListener('pointerdown', (e) => { if (!pop.hidden && !pop.contains(e.target) && !verBtn.contains(e.target)) closePop(); });

  async function loadVersions(refresh) {
    try {
      state.loading = true;
      const loader = state.loader;
      const r = await api.getVersions({ refresh: refresh !== false, loader });
      if (loader !== state.loader) return; // тип успели сменить, пока шёл запрос
      state.versions = r.versions; state.latest = r.latest; state.offline = r.offline;
      const ids = new Set(r.versions.map((v) => v.id));
      if (!state.selected || !ids.has(state.selected)) {
        const wanted = state.settings.version;
        state.selected = ids.has(wanted) ? wanted
          : (r.latest && ids.has(r.latest.release) ? r.latest.release : ((r.versions.find((v) => v.type === 'release') || r.versions[0] || {}).id || ''));
        if (state.selected && state.selected !== state.settings.version) setSetting({ version: state.selected });
      }
      if (r.offline && refresh !== false) {
        const who = loader === 'vanilla' ? 'Mojang' : loaderName[loader];
        toast(r.versions.length ? `Нет связи с ${who} — показаны сохранённые версии` : `Нет связи с ${who} и нет установленных версий`, 'bad');
      }
    } catch (e) { state.versions = []; toast('Не удалось получить список версий: ' + errText(e), 'bad'); }
    state.loading = false;
    renderVersionButton();
  }

  // ------------------------------------------------------------------ запуск игры

  const playBtn = $('#play-btn'), statusEl = $('#status'), progEl = $('#progress'), barFill = $('#bar-fill');

  function setStatus(text, bad) { statusEl.textContent = text || ''; statusEl.classList.toggle('bad', !!bad); }

  function updateIdleStatus() {
    if (state.play !== 'idle' || statusEl.classList.contains('bad')) return;
    const v = currentVersion();
    if (!v) return setStatus(state.loading ? '' : (state.offline ? 'Нет связи — список версий недоступен' : (state.loader !== 'vanilla' ? `Для ${loaderName[state.loader]} нет версий` : '')));
    if (v.installed) setStatus('Версия установлена');
    else if (state.loader !== 'vanilla') setStatus(state.offline ? `Нет связи — ${loaderName[state.loader]} не скачать` : `${loaderName[state.loader]} загрузится при первом запуске`);
    else setStatus(state.offline ? 'Нет связи с Mojang — версию не скачать' : 'Файлы загрузятся при первом запуске');
  }

  function updatePlayButton() {
    const s = state.play;
    playBtn.classList.toggle('ghost', s === 'preparing' || s === 'running');
    playBtn.disabled = s === 'launching' || (s === 'idle' && !state.selected);
    playBtn.textContent = { idle: 'Играть', preparing: 'Отменить', launching: 'Запуск…', running: 'Закрыть игру' }[s];
    const busy = s === 'preparing' || s === 'launching';
    progEl.hidden = !busy;
    accBtn.disabled = verBtn.disabled = s !== 'idle';
  }

  function showProgress(p) {
    if ('stage' in p) {
      state.stage = p.stage; state.prog = null;
      progEl.classList.add('indeterminate'); barFill.style.width = '';
      setStatus(p.stage);
      return;
    }
    state.prog = p;
    if (!p.total) return;
    progEl.classList.remove('indeterminate');
    const frac = p.totalBytes ? Math.min(1, p.bytes / p.totalBytes) : p.done / p.total;
    barFill.style.width = (frac * 100).toFixed(1) + '%';
    const bytes = p.totalBytes ? ` · ${fmtBytes(p.bytes)} из ${fmtBytes(p.totalBytes)}` : '';
    setStatus(`Загрузка файлов · ${fmtNum(p.done)} из ${fmtNum(p.total)}${bytes}`);
  }

  // Одна и та же ошибка приходит и событием состояния, и отказом вызова — показываем её один раз.
  let lastErr = { msg: '', t: 0 };
  function showPlayError(msg) {
    const now = Date.now();
    if (lastErr.msg === msg && now - lastErr.t < 2000) return;
    lastErr = { msg, t: now };
    setStatus(msg, true);
    addLog(msg, 'err');
    if (state.view !== 'play') toast(msg, 'bad');
    if (/\(код -?\d+\)/.test(msg)) setDrawer(true);
  }

  async function onPlayClick() {
    const s = state.play;
    if (s === 'preparing') { await api.cancel(); return; }
    if (s === 'running') { await api.stop(); return; }
    const acc = activeAccount();
    if (!acc) { toast('Добавьте аккаунт', 'bad'); openAccPop(); return; }
    if (acc.needsLogin) { reloginAccount(acc); return; }
    if (!state.selected) return;
    statusEl.classList.remove('bad');
    try {
      await api.play({ version: state.selected, loader: state.loader });
    } catch (e) {
      showPlayError(errText(e));
    }
  }
  playBtn.addEventListener('click', onPlayClick);

  function bindPlayEvents() {
    api.onProgress(showProgress);
    api.onLog(({ line, tag }) => addLog(line, tag));
    api.onState(async ({ state: s, error, skin, account, accountType }) => {
      state.play = s;
      if (s === 'idle') {
        barFill.style.width = '0';
        if (error) showPlayError(error);
        else { statusEl.classList.remove('bad'); }
        await loadVersions(false);
        updateIdleStatus();
        loadAccounts().catch(() => {}); // токены могли обновиться, а сессия — отозваться
      } else if (s === 'preparing') {
        statusEl.classList.remove('bad'); progEl.classList.add('indeterminate'); setStatus('Подготовка…');
      } else if (s === 'launching') {
        progEl.classList.add('indeterminate'); setStatus('Запускаю игру…');
      } else if (s === 'running') {
        if (accountType && accountType !== 'offline') setStatus(`Игра запущена · ${account}`);
        else setStatus(skin ? `Игра запущена · скин «${skin}»` : 'Игра запущена');
      }
      updatePlayButton();
    });
  }

  // ------------------------------------------------------------------ скины: просмотр на главной

  const playViewer = new window.SkinViewer($('#play-canvas'), { swing: reduceMotion ? 0 : 0.12, autoRotate: !reduceMotion, dist: 122, pitch: 0.2 });
  const previewViewer = new window.SkinViewer($('#ed-preview'), { swing: 0, autoRotate: !reduceMotion, yaw: -0.5, pitch: 0.25, dist: 108 });

  const activeMeta = () => state.skins.find((s) => s.id === state.activeId);
  const curMeta = () => state.skins.find((s) => s.id === state.curId);

  function updatePlayCaption() { syncStageSkin(); }

  // ------------------------------------------------------------------ скины: редактор

  const PALETTE = ['#000000', '#3b3b3b', '#7a7a7a', '#bdbdbd', '#ffffff', '#f1c9a5', '#d9a37c', '#a8704a', '#6b4429', '#3a2a22',
    '#d9534f', '#e8884a', '#f0c94a', '#8fcf4f', '#3f9f55', '#4fc3c9', '#4a7fd9', '#2f4a9a', '#8a5cc9', '#d96fb0'];

  const editor = new window.SkinEditor(
    { stage: $('#ed-stage'), view: $('#ed-view'), guides: $('#ed-guides') },
    {
      onTexture(tex) {
        previewViewer.setTexture(tex);
        if (state.curId && state.curId === state.activeId && !state.stageAccount) playViewer.setTexture(tex);
      },
      onChange() { scheduleSave(); },
      onPick(hex) { syncColor(hex); },
      onHistory({ canUndo, canRedo }) { $('#ed-undo').disabled = !canUndo; $('#ed-redo').disabled = !canRedo; },
    },
  );

  if (window.Theme) window.Theme.onChange(() => editor.refreshTheme());

  function syncColor(hex) {
    $('#ed-color').value = hex; $('#ed-hex').value = hex;
    $$('.sw', $('#palette')).forEach((s) => s.classList.toggle('cur', s.dataset.c === hex));
  }

  function buildPalette() {
    const box = $('#palette');
    for (const c of PALETTE) {
      const b = document.createElement('button');
      b.className = 'sw'; b.dataset.c = c; b.title = c; b.setAttribute('aria-label', 'Цвет ' + c);
      b.style.background = c;
      b.addEventListener('click', () => { editor.setColor(c); syncColor(c); if (editor.tool === 'picker' || editor.tool === 'eraser') setTool('pencil'); });
      box.appendChild(b);
    }
    syncColor('#54c2a9');
  }

  function setTool(t) {
    editor.setTool(t);
    $$('#tools .seg-btn').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.tool === t)));
    editor.renderHover();
  }
  $$('#tools .seg-btn').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
  $$('#brushes .seg-btn').forEach((b) => b.addEventListener('click', () => {
    editor.setBrush(parseInt(b.dataset.brush, 10));
    $$('#brushes .seg-btn').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
  }));
  $('#ed-color').addEventListener('input', (e) => { editor.setColor(e.target.value); syncColor(editor.getColorHex()); if (editor.tool === 'picker' || editor.tool === 'eraser') setTool('pencil'); });
  $('#ed-hex').addEventListener('change', (e) => {
    const v = e.target.value.trim().replace(/^#?/, '#');
    if (/^#[0-9a-f]{6}$/i.test(v)) { editor.setColor(v); syncColor(v.toLowerCase()); } else syncColor(editor.getColorHex());
  });
  $('#ed-undo').addEventListener('click', () => editor.undo());
  $('#ed-redo').addEventListener('click', () => editor.redo());

  const bindToggle = (id, fn) => {
    const b = $(id);
    b.addEventListener('click', () => { const on = b.getAttribute('aria-pressed') !== 'true'; b.setAttribute('aria-pressed', String(on)); fn(on); });
  };
  bindToggle('#t-overlay', (on) => previewViewer.set({ overlay: on }));
  bindToggle('#t-guides', (on) => editor.setGuides(on));
  bindToggle('#t-grid', (on) => editor.setGrid(on));
  bindToggle('#t-anim', (on) => previewViewer.set({ swing: on && !reduceMotion ? 0.55 : 0 }));

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closePop(true); closeAccPop(true); if ($('#drawer').classList.contains('open')) setDrawer(false); return; }
    if (state.view !== 'skins') return;
    const tag = (document.activeElement && document.activeElement.tagName) || '';
    if (tag === 'INPUT' && document.activeElement.type !== 'checkbox' && document.activeElement.type !== 'range') return;
    if (document.querySelector('dialog[open]')) return;
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); e.shiftKey ? editor.redo() : editor.undo(); return; }
    if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); editor.redo(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const tools = { p: 'pencil', e: 'eraser', f: 'fill', i: 'picker' };
    if (tools[k]) setTool(tools[k]);
    else if (['1', '2', '3'].includes(k)) $(`#brushes [data-brush="${k}"]`).click();
  });

  // ------------------------------------------------------------------ скины: список и сохранение

  function makeThumb(dataUrl) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas'); c.width = c.height = 8;
        const x = c.getContext('2d'); x.imageSmoothingEnabled = false;
        x.drawImage(img, 8, 8, 8, 8, 0, 0, 8, 8);
        x.drawImage(img, 40, 8, 8, 8, 0, 0, 8, 8);
        resolve(c.toDataURL());
      };
      img.onerror = () => resolve('');
      img.src = dataUrl;
    });
  }

  function renderSkinList() {
    const ul = $('#sk-list');
    ul.textContent = '';
    for (const s of state.skins) {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.className = 'sk-item'; b.dataset.id = s.id;
      b.setAttribute('aria-current', String(s.id === state.curId));
      const img = document.createElement('img'); img.className = 'sk-thumb'; img.alt = '';
      if (state.thumbs[s.id]) img.src = state.thumbs[s.id];
      const meta = document.createElement('span'); meta.className = 'sk-meta';
      const name = document.createElement('span'); name.className = 'sk-name'; name.textContent = s.name;
      const sub = document.createElement('span'); sub.className = 'sk-sub' + (s.id === state.activeId ? ' on' : '');
      sub.textContent = s.id === state.activeId ? 'Используется в игре' : (s.model === 'slim' ? 'Тонкие руки' : 'Обычные руки');
      meta.append(name, sub); b.append(img, meta);
      b.addEventListener('click', () => { if (s.id !== state.curId) openSkin(s.id); });
      li.appendChild(b); ul.appendChild(li);
    }
    const use = $('#sk-use');
    const isActive = state.curId === state.activeId;
    use.disabled = isActive;
    use.textContent = isActive ? 'Используется в игре' : 'Использовать в игре';
  }

  async function refreshThumb(id, dataUrl) { state.thumbs[id] = await makeThumb(dataUrl); }

  async function loadSkins(selectId) {
    const r = await api.skins.list();
    state.skins = r.skins; state.activeId = r.active;
    for (const s of state.skins) if (!state.thumbs[s.id]) await refreshThumb(s.id, await api.skins.get(s.id));
    const want = selectId || state.curId;
    state.curId = state.skins.find((s) => s.id === want) ? want : (r.active || (state.skins[0] && state.skins[0].id) || null);
    updatePlayCaption();
    await openSkin(state.curId, true);
  }

  function reflectMeta() {
    const m = curMeta(); if (!m) return;
    $('#sk-name').value = m.name;
    $$('#models .seg-btn').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.model === m.model)));
    previewViewer.setModel(m.model);
  }

  async function openSkin(id, skipFlush) {
    if (!skipFlush) await flushSave();
    state.curId = id;
    const m = curMeta();
    if (!m) { renderSkinList(); return; }
    renderSkinList(); reflectMeta();
    await editor.load(await api.skins.get(id), m.model);
    if (id === state.activeId) updatePlayCaption();
    setSaved('');
  }

  let savedTimer;
  function setSaved(text) {
    const el = $('#sk-saved'); el.textContent = text;
    clearTimeout(savedTimer);
    if (text) savedTimer = setTimeout(() => { el.textContent = ''; }, 1800);
  }

  let dirty = false;
  const saveNow = async () => {
    if (!dirty || !state.curId) return;
    dirty = false;
    const id = state.curId, m = curMeta();
    try {
      const png = editor.toDataURL();
      const meta = await api.skins.save(id, { name: m.name, model: m.model, png });
      Object.assign(m, meta);
      await refreshThumb(id, png);
      state.thumbs[id] && renderSkinList();
      if (id === state.activeId) renderAccountButton(); // голова оффлайн-аккаунта — из выбранного скина
      setSaved('Сохранено');
    } catch (e) { dirty = true; toast('Не удалось сохранить скин: ' + errText(e), 'bad'); }
  };
  const debouncedSave = debounce(saveNow, 600);
  function scheduleSave() { dirty = true; debouncedSave(); }
  async function flushSave() { debouncedSave.cancel(); await saveNow(); }

  $('#sk-name').addEventListener('input', (e) => {
    const m = curMeta(); if (!m) return;
    m.name = e.target.value.slice(0, 32) || 'Без названия';
    const label = $(`.sk-item[data-id="${m.id}"] .sk-name`); if (label) label.textContent = m.name;
    if (m.id === state.activeId && !state.stageAccount) $('#play-skin-name').textContent = m.name;
    scheduleSave();
  });

  $$('#models .seg-btn').forEach((b) => b.addEventListener('click', () => {
    const m = curMeta(); if (!m || m.model === b.dataset.model) return;
    m.model = b.dataset.model;
    editor.setModel(m.model);
    reflectMeta(); renderSkinList();
    if (m.id === state.activeId) playViewer.setModel(m.model);
    scheduleSave();
  }));

  /** Тонкие руки определяем по прозрачным столбцам справа от правой руки (как это делают редакторы скинов). */
  function guessModel(dataUrl) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas'); c.width = c.height = 64;
        const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(img, 0, 0, 64, 64);
        const d = x.getImageData(54, 20, 2, 12).data;
        let opaque = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) opaque++;
        resolve(opaque === 0 ? 'slim' : 'classic');
      };
      img.onerror = () => resolve('classic');
      img.src = dataUrl;
    });
  }

  async function addSkin(opts, successText) {
    await flushSave();
    const meta = await api.skins.create(opts);
    await api.skins.setActive(meta.id); // новый скин сразу попадает в игру — не нужно отдельно нажимать «Использовать»
    await loadSkins(meta.id);
    if (successText) toast(successText + ' · выбран для игры');
    return meta;
  }

  $('#sk-new').addEventListener('click', () => addSkin({ name: 'Новый скин', model: 'classic' }).catch((e) => toast(errText(e), 'bad')));

  $('#sk-import').addEventListener('click', async () => {
    try {
      const r = await api.skins.import();
      if (!r) return;
      await addSkin({ name: r.name, model: await guessModel(r.png), png: r.png }, 'Скин добавлен');
    } catch (e) { toast(errText(e), 'bad'); }
  });

  $('#sk-dup').addEventListener('click', async () => {
    const m = curMeta(); if (!m) return;
    try { await addSkin({ name: (m.name + ' (копия)').slice(0, 32), model: m.model, png: editor.toDataURL() }, 'Копия создана'); }
    catch (e) { toast(errText(e), 'bad'); }
  });

  $('#sk-export').addEventListener('click', async () => {
    try { await flushSave(); if (await api.skins.export(state.curId)) toast('Скин сохранён в PNG'); }
    catch (e) { toast(errText(e), 'bad'); }
  });

  $('#sk-use').addEventListener('click', async () => {
    try {
      await flushSave();
      await api.skins.setActive(state.curId);
      state.activeId = state.curId;
      playViewer.setTexture(editor.tex);
      updatePlayCaption(); renderSkinList(); renderAccountButton();
      toast('Скин будет применён при следующем запуске игры');
    } catch (e) { toast(errText(e), 'bad'); }
  });

  $('#sk-del').addEventListener('click', async () => {
    const m = curMeta(); if (!m) return;
    const ok = await confirmDialog({ title: 'Удалить скин?', text: `«${m.name}» будет удалён без возможности восстановления.`, ok: 'Удалить' });
    if (!ok) return;
    try {
      debouncedSave.cancel(); dirty = false;
      await api.skins.remove(m.id);
      delete state.thumbs[m.id];
      state.curId = null;
      let list = await api.skins.list();
      if (!list.skins.length) await api.skins.create({ name: 'Мой скин', model: 'classic' });
      await loadSkins();
      toast('Скин удалён');
    } catch (e) { toast(errText(e), 'bad'); }
  });

  // скин по нику
  const dlgNick = $('#dlg-nick'), nickInput = $('#dlg-nick-input'), nickErr = $('#dlg-nick-err'), nickOk = $('#dlg-nick-ok');
  $('#sk-nick').addEventListener('click', () => { nickInput.value = ''; nickErr.textContent = ''; nickErr.classList.remove('bad'); nickOk.disabled = false; dlgNick.showModal(); nickInput.focus(); });
  nickInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); nickOk.click(); } });
  nickOk.addEventListener('click', async (e) => {
    e.preventDefault();
    const nick = nickInput.value.trim();
    if (!NICK_RE.test(nick)) { nickErr.textContent = 'Ник: 3–16 символов, латиница, цифры и _'; nickErr.classList.add('bad'); return; }
    nickOk.disabled = true; nickErr.classList.remove('bad'); nickErr.textContent = 'Скачиваю…';
    try {
      const r = await api.skins.fetchNick(nick);
      dlgNick.close();
      await addSkin({ name: r.name, model: r.model, png: r.png }, `Скин ${r.name} добавлен`);
    } catch (err) { nickErr.textContent = errText(err); nickErr.classList.add('bad'); }
    nickOk.disabled = false;
  });

  // ------------------------------------------------------------------ друзья

  const frIn = $('#fr-in'), frList = $('#fr-list'), frOut = $('#fr-out');
  const frAddInput = $('#fr-add-input'), frAddErr = $('#fr-add-err');

  const copyText = (text) => api.copy(text).then(() => true, () => false);

  function applyFriends(v, quiet) {
    const prev = state.fr;
    state.fr = v;
    if (prev && prev.me && !quiet) {
      const known = new Set(prev.incoming.map((p) => p.id));
      for (const p of v.incoming) if (!known.has(p.id)) toast(`${p.name} хочет добавить вас в друзья`);
      if (v.renewals > prev.renewals) toast('Вход на сервер друзей пришлось создать заново: код друга теперь другой, а список друзей пуст.', 'bad', 9000);
    }
    renderFriends();
  }

  function avatarEl(p) {
    if (p.avatar) {
      const img = document.createElement('img'); img.className = 'avatar lg'; img.alt = ''; img.src = p.avatar;
      return img;
    }
    const ph = document.createElement('span'); ph.className = 'avatar lg ph'; ph.textContent = p.name.charAt(0).toUpperCase();
    return ph;
  }

  function personRow(p, subText, { on, buttons } = {}) {
    const li = document.createElement('li'); li.className = 'fr-item'; li.dataset.id = p.id;
    const meta = document.createElement('div'); meta.className = 'fr-meta';
    const name = document.createElement('span'); name.className = 'fr-name'; name.textContent = p.name;
    const sub = document.createElement('span'); sub.className = 'fr-sub' + (on ? ' on' : '');
    if (on !== undefined) { const d = document.createElement('i'); d.className = 'dot'; sub.appendChild(d); }
    const t = document.createElement('span'); t.textContent = subText; sub.appendChild(t);
    meta.append(name, sub);
    li.append(avatarEl(p), meta);
    if (buttons) { const box = document.createElement('div'); box.className = 'fr-item-btns'; box.append(...buttons); li.appendChild(box); }
    return li;
  }
  function textButton(label, act, cls) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'btn small ' + (cls || 'ghost'); b.dataset.act = act; b.textContent = label;
    return b;
  }

  function renderFriends() {
    const v = state.fr; if (!v) return;
    const main = v.configured && v.enabled;
    $('#fr-intro').hidden = main; $('#fr-main').hidden = !main;
    const n = v.enabled ? v.incoming.length : 0;
    const badge = $('#fr-badge'); badge.hidden = !n; badge.textContent = String(n);
    if (!main) {
      $('#fr-intro-text').textContent = !v.configured
        ? (v.configError || 'Друзья пока не настроены. Им нужен бесплатный проект Supabase: как его создать, написано в файле friends/SETUP.md из исходников лаунчера. Когда проект готов, нажмите «Указать сервер».')
        : 'Добавляйте друзей по коду и смотрите, кто в сети и во что играет. Сервер для этого — проект Supabase, лаунчер общается с ним напрямую.';
      $('#fr-facts').hidden = !v.configured;
      $('#fr-enable').hidden = !v.configured;
      $('#fr-setup').textContent = v.configured ? 'Сменить сервер' : 'Указать сервер';
      $('#fr-setup').classList.toggle('primary', !v.configured); $('#fr-setup').classList.toggle('ghost', v.configured);
      $('#fr-intro-host').textContent = v.configured ? 'Сервер: ' + v.host : '';
      return;
    }

    // шапка: код и подключение
    $('#fr-code').textContent = v.me ? v.me.pretty : (v.status === 'error' ? 'нет связи' : 'подключаюсь…');
    $('#fr-copy').disabled = !v.me;
    $('#fr-add').disabled = !v.me;
    $('#fr-visible').checked = !v.hidden;
    const banner = $('#fr-banner');
    banner.hidden = v.status !== 'error';
    if (v.status === 'error') $('#fr-banner-text').textContent = 'Нет связи с сервером друзей. ' + v.error;

    const ordered = v.friends.slice().sort((a, b) => (b.online - a.online) || (!!b.playing - !!a.playing) || a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
    $('#fr-count').textContent = v.friends.length ? `${v.friends.filter((f) => f.online).length} в сети из ${v.friends.length}` : '';

    frIn.textContent = '';
    for (const p of v.incoming) frIn.appendChild(personRow(p, 'хочет добавить вас', { buttons: [textButton('Принять', 'accept', 'primary'), textButton('Отклонить', 'decline')] }));
    $('#fr-in-box').hidden = !v.incoming.length;

    frList.textContent = '';
    for (const p of ordered) {
      const sub = p.online ? (p.playing ? 'играет · ' + p.playing : 'в сети') : 'не в сети';
      const del = iconButton('i-trash', 'Удалить из друзей', 'remove', true);
      frList.appendChild(personRow(p, sub, { on: p.online, buttons: [del] }));
    }

    frOut.textContent = '';
    for (const p of v.outgoing) frOut.appendChild(personRow(p, 'ждёт ответа', { buttons: [textButton('Отозвать', 'cancel')] }));
    $('#fr-out-box').hidden = !v.outgoing.length;

    $('#fr-empty').textContent = v.me && !v.friends.length && !v.incoming.length && !v.outgoing.length
      ? 'Пока никого. Отправьте другу свой код или введите его код справа.' : '';
  }

  async function friendsAct(kind, id) {
    try {
      if (kind === 'remove') {
        const p = state.fr.friends.find((f) => f.id === id);
        if (!(await confirmDialog({ title: 'Удалить из друзей?', text: `${p ? p.name : 'Игрок'} исчезнет из вашего списка, а вы — из его. Добавить снова можно по коду.`, ok: 'Удалить' }))) return;
        applyFriends(await api.friends.remove(id), true);
      } else if (kind === 'cancel') applyFriends(await api.friends.remove(id), true);
      else if (kind === 'accept') { applyFriends(await api.friends.accept(id), true); toast('Теперь вы друзья'); }
      else if (kind === 'decline') applyFriends(await api.friends.decline(id), true);
    } catch (e) { toast(errText(e), 'bad'); }
  }
  $('#fr-main').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]'), li = e.target.closest('.fr-item');
    if (btn && li) friendsAct(btn.dataset.act, li.dataset.id);
  });

  async function addFriend() {
    const code = frAddInput.value.trim();
    if (!code) { fieldErr(frAddErr, 'Введите код друга'); return; }
    const btn = $('#fr-add'); btn.disabled = true; fieldErr(frAddErr, '');
    try {
      const r = await api.friends.request(code);
      frAddInput.value = '';
      toast({
        sent: `Заявка отправлена: ${r.target}`, accepted: `${r.target} теперь ваш друг`,
        already: `${r.target} уже у вас в друзьях`, already_sent: `Заявка для ${r.target} уже отправлена`,
      }[r.note] || `Заявка отправлена: ${r.target}`);
    } catch (e) { fieldErr(frAddErr, errText(e)); }
    btn.disabled = !(state.fr && state.fr.me);
  }
  $('#fr-add').addEventListener('click', addFriend);
  frAddInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addFriend(); } });
  frAddInput.addEventListener('input', () => fieldErr(frAddErr, ''));

  $('#fr-copy').addEventListener('click', async () => {
    if (state.fr && state.fr.me && await copyText(state.fr.me.pretty)) toast('Код скопирован');
  });
  const refreshFriends = async () => { try { applyFriends(await api.friends.sync(), true); } catch (e) { toast(errText(e), 'bad'); } };
  $('#fr-refresh').addEventListener('click', refreshFriends);
  $('#fr-banner-retry').addEventListener('click', refreshFriends);

  $('#fr-visible').addEventListener('change', async (e) => {
    try { applyFriends(await api.friends.setHidden(!e.target.checked), true); } catch (err) { toast(errText(err), 'bad'); }
  });
  $('#fr-newcode').addEventListener('click', async () => {
    if (!(await confirmDialog({ title: 'Сделать новый код?', text: 'Прежний код перестанет работать — по нему больше не смогут отправить заявку. Уже добавленные друзья останутся.', ok: 'Сделать' }))) return;
    try { applyFriends(await api.friends.newCode(), true); toast('Новый код готов'); } catch (e) { toast(errText(e), 'bad'); }
  });
  $('#fr-off').addEventListener('click', async () => {
    try { applyFriends(await api.friends.enable(false), true); } catch (e) { toast(errText(e), 'bad'); }
  });
  $('#fr-delete').addEventListener('click', async () => {
    if (!(await confirmDialog({ title: 'Удалить данные с сервера?', text: 'Ваш профиль, список друзей и заявки будут удалены с сервера. У друзей вы исчезнете. Включив друзей снова, вы получите новый код.', ok: 'Удалить' }))) return;
    try { applyFriends(await api.friends.delete(), true); toast('Данные удалены с сервера'); } catch (e) { toast(errText(e), 'bad'); }
  });
  $('#fr-enable').addEventListener('click', async () => {
    try { applyFriends(await api.friends.enable(true), true); } catch (e) { toast(errText(e), 'bad'); }
  });

  // --- адрес и ключ проекта Supabase
  const dFrs = $('#dlg-fr-server'), frsUrl = $('#frs-url'), frsKey = $('#frs-key'), frsErr = $('#frs-err'), frsOk = $('#frs-ok');
  function openServerDialog() {
    frsUrl.value = state.settings.friendsUrl || ''; frsKey.value = state.settings.friendsKey || ''; fieldErr(frsErr, ''); frsOk.disabled = false;
    dFrs.showModal(); frsUrl.focus();
  }
  async function saveServer(url, key) {
    frsOk.disabled = true; fieldErr(frsErr, '');
    try {
      applyFriends(await api.friends.setConfig({ url, key }), true);
      state.settings = await api.getSettings();
      dFrs.close();
    } catch (e) { fieldErr(frsErr, errText(e)); }
    frsOk.disabled = false;
  }
  $('#fr-server').addEventListener('click', openServerDialog);
  $('#fr-setup').addEventListener('click', openServerDialog);
  [frsUrl, frsKey].forEach((el) => el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); frsOk.click(); } }));
  frsOk.addEventListener('click', (e) => { e.preventDefault(); saveServer(frsUrl.value, frsKey.value); });
  $('#frs-reset').addEventListener('click', () => { frsUrl.value = ''; frsKey.value = ''; saveServer('', ''); });

  async function initFriends() {
    applyFriends(await api.friends.get(), true);
    api.friends.onState((v) => applyFriends(v));
  }

  // ------------------------------------------------------------------ запуск

  async function init() {
    if (!api) { document.body.textContent = 'Приложение нужно запускать через Unlucky.'; return; }
    try {
      [state.settings, state.info] = await Promise.all([api.getSettings(), api.info()]);
      state.selected = state.settings.version || '';
      state.loader = state.settings.loader || 'vanilla';
      showLoader();
      document.body.dataset.platform = state.info.platform;
      buildPalette();
      initSettingsView();
      bindPlayEvents();
      api.win.onMaximized(() => {});
      await loadSkins();
      await loadAccounts();
      await initFriends();
      updatePlayButton();
      await loadVersions(true);
    } catch (e) { toast('Ошибка запуска: ' + errText(e), 'bad'); }
  }
  init();
})();
