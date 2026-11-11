'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { PNG } = require('pngjs');
const AdmZip = require('adm-zip');
const SL = require('../shared/skin-layout');
const dl = require('./download');

const PACK_NAME = 'UnluckySkin';
const DEFAULT_SKINS = ['alex', 'ari', 'efe', 'kai', 'makena', 'noor', 'steve', 'sunny', 'zuri'];

// ---------------------------------------------------------------- PNG

function decodePng(buf) {
  const png = PNG.sync.read(buf);
  return { width: png.width, height: png.height, data: new Uint8ClampedArray(png.data) };
}

function encodePng(rgba, width, height) {
  const png = new PNG({ width, height });
  Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength).copy(png.data);
  return PNG.sync.write(png);
}

/** Приводит любой допустимый скин к 64x64. Бросает ошибку, если размер не подходит. */
function normalizeSkin(buf) {
  if (buf.length > 2 * 1024 * 1024) throw new Error('Файл слишком большой для скина');
  let img;
  try { img = decodePng(buf); } catch { throw new Error('Это не PNG-файл'); }
  if (img.width === 64 && img.height === 64) return encodePng(img.data, 64, 64);
  if (img.width === 64 && img.height === 32) return encodePng(SL.upgradeLegacy(img.data), 64, 64);
  throw new Error(`Размер скина должен быть 64×64 или 64×32 пикселя (у файла ${img.width}×${img.height})`);
}

function dataUrlToBuffer(url) {
  const m = /^data:image\/png;base64,(.+)$/.exec(url || '');
  if (!m) throw new Error('Ожидался PNG');
  return Buffer.from(m[1], 'base64');
}
function bufferToDataUrl(buf) { return 'data:image/png;base64,' + buf.toString('base64'); }

// ---------------------------------------------------------------- хранилище скинов

function createSkinStore(dir) {
  const indexFile = path.join(dir, 'skins.json');
  let data = { active: null, skins: [] };

  function load() {
    try { data = JSON.parse(fs.readFileSync(indexFile, 'utf8')); } catch { data = { active: null, skins: [] }; }
    data.skins = (data.skins || []).filter(s => fs.existsSync(path.join(dir, s.id + '.png')));
    if (data.active && !data.skins.find(s => s.id === data.active)) data.active = data.skins[0] ? data.skins[0].id : null;
  }
  function persist() {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = indexFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, indexFile);
  }
  const checkId = (id) => { if (!/^[a-z0-9]{6,32}$/.test(id || '')) throw new Error('Неверный id скина'); return id; };
  const newId = () => crypto.randomBytes(6).toString('hex');
  const cleanName = (n) => String(n || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 32) || 'Без названия';
  const cleanModel = (m) => (m === 'slim' ? 'slim' : 'classic');

  load();

  return {
    list() { return { active: data.active, skins: data.skins.slice() }; },
    get(id) { checkId(id); return fs.readFileSync(path.join(dir, id + '.png')); },
    create({ name, model, png }) {
      const id = newId();
      const buf = png ? normalizeSkin(png) : encodePng(SL.makeTemplate(cleanModel(model)), 64, 64);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, id + '.png'), buf);
      const meta = { id, name: cleanName(name), model: cleanModel(model), updatedAt: Date.now() };
      data.skins.push(meta);
      if (!data.active) data.active = id;
      persist();
      return meta;
    },
    save(id, { name, model, png }) {
      checkId(id);
      const meta = data.skins.find(s => s.id === id);
      if (!meta) throw new Error('Скин не найден');
      if (png) fs.writeFileSync(path.join(dir, id + '.png'), normalizeSkin(png));
      if (name != null) meta.name = cleanName(name);
      if (model != null) meta.model = cleanModel(model);
      meta.updatedAt = Date.now();
      persist();
      return meta;
    },
    remove(id) {
      checkId(id);
      data.skins = data.skins.filter(s => s.id !== id);
      try { fs.unlinkSync(path.join(dir, id + '.png')); } catch { /* ignore */ }
      if (data.active === id) data.active = data.skins[0] ? data.skins[0].id : null;
      persist();
    },
    setActive(id) { checkId(id); if (!data.skins.find(s => s.id === id)) throw new Error('Скин не найден'); data.active = id; persist(); },
    ensureDefault() { if (!data.skins.length) this.create({ name: 'Мой скин', model: 'classic' }); },
    getActive() {
      const meta = data.skins.find(s => s.id === data.active);
      return meta ? Object.assign({}, meta, { png: this.get(meta.id) }) : null;
    },
  };
}

// ---------------------------------------------------------------- скин в игре
//
// В оффлайн-режиме у игрока нет «настоящего» скина, поэтому игра берёт один из стандартных
// (Стив, Алекс и т. д. — по UUID). Мы подменяем их все, подставляя руки нужной ширины для каждой модели.
// Делаем это двумя независимыми способами, чтобы скин применялся при любой версии:
//   1) ресурспак UnluckySkin + запись в options.txt;
//   2) копия клиента игры (.jar) с уже подменёнными текстурами — она работает, даже если игра
//      по какой-то причине выключила ресурспак (несовместимый pack_format, чужие настройки и т. п.).

const T = (s) => Date.parse(s);

/** Старые названия пака (до переименования лаунчера) — чистим их из options.txt. */
const OUR_PACKS = [PACK_NAME, 'KubikSkin'];
const isOurPack = (n) => OUR_PACKS.some((x) => n === x || n === 'file/' + x);

const TEX = 'assets/minecraft/textures/entity/';
/** Файлы стандартных скинов: [путь внутри клиента/пака, модель рук]. Старые версии берут steve/alex, новые — player/*. */
const SKIN_FILES = (() => {
  const out = [[TEX + 'steve.png', 'classic'], [TEX + 'alex.png', 'slim']];
  for (const n of DEFAULT_SKINS) {
    out.push([`${TEX}player/wide/${n}.png`, 'classic'], [`${TEX}player/slim/${n}.png`, 'slim']);
  }
  return out;
})();

/** pack_format по дате выхода — для версий, где внутри клиента нет version.json (до 1.14). */
function fallbackPackFormat(releaseTime) {
  const t = T(releaseTime) || Date.now();
  if (t < T('2015-07-29')) return 1;  // 1.6–1.8
  if (t < T('2016-08-10')) return 2;  // 1.9–1.10
  if (t < T('2017-10-25')) return 3;  // 1.11–1.12
  return 4;                           // 1.13–1.14
}

function parsePackVersion(pv) {
  if (typeof pv === 'number') return pv;
  if (pv && typeof pv === 'object') {
    const r = pv.resource !== undefined ? pv.resource : pv.resource_major;
    if (typeof r === 'number') return r;
  }
  return null;
}

/** Формат ресурспака: берём из version.json внутри клиента (1.14+), иначе по дате релиза. */
function packFormatFor({ jarPath, releaseTime }) {
  try {
    if (jarPath && fs.existsSync(jarPath)) {
      const entry = new AdmZip(jarPath).getEntry('version.json');
      if (entry) {
        const n = parsePackVersion(JSON.parse(entry.getData().toString('utf8')).pack_version);
        if (n) return n;
      }
    }
  } catch { /* упадём на таблицу */ }
  return fallbackPackFormat(releaseTime);
}

function writeFile(p, data) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); }

function listLine(lines, key) {
  const idx = lines.findIndex((l) => l.startsWith(key));
  let list = [];
  if (idx >= 0) {
    try { list = JSON.parse(lines[idx].slice(key.length)); } catch { list = []; }
    if (!Array.isArray(list)) list = [];
  }
  return { idx, list };
}
function putLine(lines, idx, text) { if (idx >= 0) lines[idx] = text; else lines.push(text); }

/**
 * Правит options.txt: включает/выключает наш ресурспак.
 *  legacyNames — до 1.13 пак называется просто по имени папки, позже — «file/<имя>» (+ «vanilla» первым);
 *  incompat    — записать пак в incompatibleResourcePacks: иначе игра (1.9+) сама выкидывает пак из списка,
 *                если его pack_format не совпал с версией;
 *  oldSkin     — до 1.8 выбранный пак хранится одной строкой skin:<имя>.
 */
function patchOptions(gameDir, { enable, legacyNames, lang, incompat, oldSkin }) {
  const file = path.join(gameDir, 'options.txt');
  let lines = [];
  let existed = false;
  try { lines = fs.readFileSync(file, 'utf8').split(/\r?\n/); existed = true; } catch { /* нет файла */ }
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  if (!existed && !enable) return;
  const before = lines.join('\n');

  const entry = legacyNames ? PACK_NAME : 'file/' + PACK_NAME;

  const packs = listLine(lines, 'resourcePacks:');
  const list = packs.list.filter((n) => !isOurPack(n));
  if (enable) {
    if (!legacyNames && !list.includes('vanilla')) list.unshift('vanilla');
    list.push(entry);
  }
  if (enable || packs.idx >= 0) putLine(lines, packs.idx, 'resourcePacks:' + JSON.stringify(list));

  const bad = listLine(lines, 'incompatibleResourcePacks:');
  if (bad.idx >= 0 || (enable && incompat)) {
    const l = bad.list.filter((n) => !isOurPack(n));
    if (enable && incompat) l.push(entry);
    putLine(lines, bad.idx, 'incompatibleResourcePacks:' + JSON.stringify(l));
  }

  const si = lines.findIndex((l) => l.startsWith('skin:'));
  const cur = si >= 0 ? lines[si].slice(5).trim() : null;
  if (enable && oldSkin) putLine(lines, si, 'skin:' + PACK_NAME);
  else if (cur !== null && isOurPack(cur)) lines[si] = 'skin:Default';

  if (!existed && lang) lines.push('lang:' + lang);
  if (existed && lines.join('\n') === before) return; // нечего менять — не трогаем файл игрока
  fs.mkdirSync(gameDir, { recursive: true });
  fs.writeFileSync(file, lines.join('\n') + '\n');
}

/** Текстуры скина для обеих моделей рук (до 1.8 — в старом формате 64x32). */
function skinTextures(skin, releaseTime) {
  const t = T(releaseTime) || Date.now();
  const src = decodePng(skin.png).data;
  const legacyImage = t < T('2014-02-01');
  const enc = (rgba) => (legacyImage ? encodePng(SL.toLegacy(rgba), 64, 32) : encodePng(rgba, 64, 64));
  return {
    classic: enc(SL.convertArms(src, skin.model, 'classic')),
    slim: enc(SL.convertArms(src, skin.model, 'slim')),
  };
}

function packMeta(fmt) {
  const pack = { pack_format: fmt, description: 'Unlucky: ваш скин' };
  if (fmt <= 64) {
    // с запасом: пак не должен считаться несовместимым, даже если формат определился неточно
    pack.supported_formats = { min_inclusive: 1, max_inclusive: Math.max(64, fmt) };
  } else {
    // 1.21.9+: pack_format заменён на min_format / max_format
    pack.supported_formats = { min_inclusive: fmt, max_inclusive: fmt };
    pack.min_format = fmt;
    pack.max_format = fmt;
  }
  return { pack };
}

/** Собирает ресурспак со скином и включает его в options.txt (или убирает, если enable=false). */
function applySkinPack({ gameDir, skin, enable, releaseTime, jarPath, gameLang }) {
  const packDir = path.join(gameDir, 'resourcepacks', PACK_NAME);
  const t = T(releaseTime) || Date.now();
  const opts = {
    legacyNames: t < T('2018-07-18'),
    incompat: t >= T('2015-06-01'),
    oldSkin: t < T('2014-09-02'),
    lang: gameLang ? (t < T('2016-11-14') ? 'ru_RU' : 'ru_ru') : null,
  };
  for (const old of OUR_PACKS) if (old !== PACK_NAME) fs.rmSync(path.join(gameDir, 'resourcepacks', old), { recursive: true, force: true });

  if (!enable || !skin) {
    fs.rmSync(packDir, { recursive: true, force: true });
    patchOptions(gameDir, Object.assign({ enable: false }, opts));
    return { applied: false };
  }

  const tex = skinTextures(skin, releaseTime);
  fs.rmSync(packDir, { recursive: true, force: true });
  for (const [name, kind] of SKIN_FILES) writeFile(path.join(packDir, ...name.split('/')), kind === 'slim' ? tex.slim : tex.classic);
  const fmt = packFormatFor({ jarPath, releaseTime });
  writeFile(path.join(packDir, 'pack.mcmeta'), JSON.stringify(packMeta(fmt), null, 2));
  patchOptions(gameDir, Object.assign({ enable: true }, opts));
  return { applied: true, packFormat: fmt };
}

/**
 * Делает копию клиента игры со стандартными скинами, заменёнными на выбранный, и возвращает путь к ней.
 * Подменяются только файлы, которые в этой версии игры уже есть. Копия кэшируется рядом с оригиналом
 * (имя содержит хэш скина), старые копии удаляются. Возвращает { path, replaced, cached } или { path: null }.
 */
function patchClientJar({ jarPath, skin, releaseTime }) {
  const st = fs.statSync(jarPath);
  const tex = skinTextures(skin, releaseTime);
  const key = crypto.createHash('sha1').update(tex.classic).update(tex.slim).update(`${st.size}:${Math.floor(st.mtimeMs)}:1`).digest('hex').slice(0, 10);
  const dir = path.dirname(jarPath);
  const base = path.basename(jarPath, '.jar') + '.unlucky-';
  const outName = base + key + '.jar';
  const out = path.join(dir, outName);

  for (const f of fs.readdirSync(dir)) {
    if (f !== outName && f.startsWith(base)) { try { fs.unlinkSync(path.join(dir, f)); } catch { /* занят — не страшно */ } }
  }
  if (fs.existsSync(out) && fs.statSync(out).size > 0) return { path: out, replaced: null, cached: true };

  const zip = new AdmZip(jarPath);
  const done = [];
  for (const [name, kind] of SKIN_FILES) {
    if (zip.getEntry(name)) { zip.updateFile(name, kind === 'slim' ? tex.slim : tex.classic); done.push([name, kind]); }
  }
  if (!done.length) return { path: null, replaced: 0 };

  // Подпись Mojang у старых версий (1.6–1.12) после замены файлов стала бы недействительной — JVM отказалась бы читать jar.
  const sigs = zip.getEntries().map((e) => e.entryName).filter((n) => /^META-INF\/[^/]+\.(SF|DSA|RSA|EC)$/i.test(n));
  if (sigs.length) {
    sigs.forEach((n) => zip.deleteFile(n));
    const mf = zip.getEntry('META-INF/MANIFEST.MF');
    if (mf) {
      const txt = mf.getData().toString('utf8');
      const cut = txt.search(/\r?\n\r?\n/);
      if (cut >= 0) zip.updateFile('META-INF/MANIFEST.MF', Buffer.from(txt.slice(0, cut) + '\r\n\r\n'));
    }
  }

  const tmp = out + '.tmp';
  try {
    zip.writeZip(tmp);
    const chk = new AdmZip(tmp);
    for (const [name, kind] of done) {
      const e = chk.getEntry(name);
      if (!e || !e.getData().equals(kind === 'slim' ? tex.slim : tex.classic)) throw new Error('копия клиента собралась с ошибкой');
    }
    fs.renameSync(tmp, out);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* нет файла */ }
    throw e;
  }
  return { path: out, replaced: done.length, cached: false };
}

// ---------------------------------------------------------------- скин игрока по нику

async function fetchSkinByNick(nick, { signal } = {}) {
  if (!/^[A-Za-z0-9_]{3,16}$/.test(nick || '')) throw new Error('Ник: 3–16 символов, латиница, цифры и _');
  let profile;
  try { profile = await dl.fetchJson(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(nick)}`, { signal, retries: 1 }); }
  catch (e) {
    if (e.status === 404 || e.status === 204) throw new Error(`Игрок «${nick}» не найден`);
    if (e.status === 429) throw new Error('Слишком много запросов к Mojang. Подождите минуту.');
    throw new Error('Не удалось связаться с Mojang. Проверьте интернет.');
  }
  if (!profile || !profile.id) throw new Error(`Игрок «${nick}» не найден`);
  let prof;
  try { prof = await dl.fetchJson(`https://sessionserver.mojang.com/session/minecraft/profile/${profile.id}`, { signal, retries: 1 }); }
  catch (e) {
    if (e.status === 429) throw new Error('Слишком много запросов к Mojang. Подождите минуту.');
    throw new Error('Не удалось получить профиль игрока.');
  }
  const prop = (prof.properties || []).find(p => p.name === 'textures');
  const textures = prop ? JSON.parse(Buffer.from(prop.value, 'base64').toString('utf8')) : null;
  const skin = textures && textures.textures && textures.textures.SKIN;
  if (!skin || !skin.url) throw new Error('У этого игрока нет собственного скина');
  const u = new URL(skin.url);
  if (!/(^|\.)minecraft\.net$/.test(u.hostname)) throw new Error('Неожиданный адрес скина');
  const png = normalizeSkin(await dl.fetchBuffer(skin.url, { signal }));
  return { name: profile.name || nick, model: skin.metadata && skin.metadata.model === 'slim' ? 'slim' : 'classic', png };
}

module.exports = {
  createSkinStore, applySkinPack, patchClientJar, patchOptions, packFormatFor, fetchSkinByNick,
  normalizeSkin, decodePng, encodePng, dataUrlToBuffer, bufferToDataUrl, PACK_NAME,
};
