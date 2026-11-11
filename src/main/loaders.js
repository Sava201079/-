'use strict';
// Fabric и Forge: списки версий, установка профиля. Запуск дальше идёт тем же путём, что и у ванильных версий
// (профиль — обычный version.json с inheritsFrom, его читает minecraft.js).
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');
const AdmZip = require('adm-zip');
const dl = require('./download');
const mc = require('./minecraft');

const LOADERS = ['vanilla', 'fabric', 'forge'];
const LABEL = { vanilla: 'Vanilla', fabric: 'Fabric', forge: 'Forge' };

const fabricBase = () => (process.env.UNLUCKY_FABRIC_URL || 'https://meta.fabricmc.net').replace(/\/+$/, '');
const forgeMavens = () => (process.env.UNLUCKY_FORGE_URL
  ? [process.env.UNLUCKY_FORGE_URL.replace(/\/+$/, '')]
  : ['https://maven.minecraftforge.net', 'https://files.minecraftforge.net/maven']);
const forgePromosUrl = () => process.env.UNLUCKY_FORGE_PROMOS_URL || 'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json';
const FORGE_PATH = 'net/minecraftforge/forge';
// Установщики Forge для более старых версий игры устроены иначе и в списке не нужны.
const FORGE_MIN_MC = '1.7.10';

const dirs = mc.dirs;
const enc = encodeURIComponent;

/** "1.20.1" < "1.20.4"; нечисловые части (снапшоты) считаем «меньше». */
function cmpMc(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10)), pb = String(b).split('.').map((n) => parseInt(n, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = Number.isNaN(pa[i]) ? -1 : (pa[i] || 0), y = Number.isNaN(pb[i]) ? -1 : (pb[i] || 0);
    if (x !== y) return x - y;
  }
  return 0;
}

// ---------------------------------------------------------------- что установлено

/** Какой загрузчик у профиля из папки versions: 'fabric' | 'forge' | null. NeoForge и Quilt сюда не относятся. */
function detectLoader(json) { return mc.detectLoader(json); }

/** Для какой версии игры сделан профиль загрузчика. */
function gameVersionOf(id, json) {
  if (json && typeof json.inheritsFrom === 'string') return json.inheritsFrom;
  const m = /^(\d+\.\d+(?:\.\d+)?)-/.exec(id) || /-(\d+\.\d+(?:\.\d+)?)$/.exec(id);
  return m ? m[1] : null;
}

/** Установленные профили загрузчика: Map<версия игры, [{ id, mtime }]> (новые первыми). */
async function installedByGame(root, loader) {
  const local = await mc.installedIds(root);
  const out = new Map();
  for (const [id, info] of local) {
    if (detectLoader(info.json) !== loader) continue;
    const gv = gameVersionOf(id, info.json);
    if (!gv) continue;
    let mtime = 0;
    try { mtime = (await fsp.stat(path.join(dirs(root).versions, id, id + '.json'))).mtimeMs; } catch { /* нет файла */ }
    if (!out.has(gv)) out.set(gv, []);
    out.get(gv).push({ id, mtime });
  }
  for (const list of out.values()) list.sort((a, b) => b.mtime - a.mtime);
  return out;
}

async function findInstalled(root, loader, gameVersion) {
  return (await installedByGame(root, loader)).get(gameVersion) || [];
}

// ---------------------------------------------------------------- кэш списков

/** Тянет данные из сети и кладёт в cache/<name>; без сети отдаёт последний кэш. */
async function cached(root, name, fetcher, { signal, refresh = true } = {}) {
  const file = path.join(dirs(root).cache, name);
  if (refresh) {
    try {
      const data = await fetcher();
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(file, JSON.stringify(data));
      return { data, offline: false };
    } catch (e) { if (signal && signal.aborted) throw e; }
  }
  try { return { data: JSON.parse(await fsp.readFile(file, 'utf8')), offline: true }; } catch { return { data: null, offline: true }; }
}

// ---------------------------------------------------------------- Fabric

function fabricGames(root, opts) {
  return cached(root, 'fabric_games.json', async () => {
    const arr = await dl.fetchJson(`${fabricBase()}/v2/versions/game`, { signal: opts && opts.signal, timeout: 8000, retries: 1 });
    if (!Array.isArray(arr)) throw new Error('Неожиданный ответ Fabric');
    return arr.map((v) => ({ version: String(v.version), stable: !!v.stable }));
  }, opts);
}

/** Скачивает профиль Fabric Loader для версии игры и кладёт его в versions/. Возвращает id профиля. */
async function installFabric({ root, mc: gameVersion, signal, onStage }) {
  if (onStage) onStage(`Получаю Fabric Loader для ${gameVersion}…`);
  const base = fabricBase();
  let list;
  try { list = await dl.fetchJson(`${base}/v2/versions/loader/${enc(gameVersion)}`, { signal, timeout: 15000 }); }
  catch (e) {
    if (e.status === 400 || e.status === 404) throw new Error(`Fabric не поддерживает версию ${gameVersion}. Выберите другую версию или тип.`);
    throw e;
  }
  if (!Array.isArray(list) || !list.length) throw new Error(`Fabric не поддерживает версию ${gameVersion}. Выберите другую версию или тип.`);
  const pick = list.find((l) => l.loader && l.loader.stable) || list[0];
  const loaderVersion = pick.loader && pick.loader.version;
  if (!loaderVersion) throw new Error('Fabric не вернул версию загрузчика');

  const profile = await dl.fetchJson(`${base}/v2/versions/loader/${enc(gameVersion)}/${enc(loaderVersion)}/profile/json`, { signal, timeout: 20000 });
  const id = profile && profile.id;
  if (typeof id !== 'string' || !/^[\w.+-]+$/.test(id)) throw new Error('Fabric вернул некорректный профиль');
  if (profile.inheritsFrom && profile.inheritsFrom !== gameVersion) throw new Error('Профиль Fabric не подходит к выбранной версии');
  const file = path.join(dirs(root).versions, id, id + '.json');
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file + '.tmp', JSON.stringify(profile, null, 2));
  await fsp.rename(file + '.tmp', file);
  return id;
}

// ---------------------------------------------------------------- Forge

/** maven-metadata.xml → { "1.20.1": ["1.20.1-47.0.0", …] } (в порядке выхода). */
function parseForgeMetadata(xml) {
  const out = {};
  for (const m of String(xml).matchAll(/<version>\s*([^<\s]+)\s*<\/version>/g)) {
    const full = m[1];
    const i = full.indexOf('-');
    if (i < 1) continue;
    const gv = full.slice(0, i);
    if (!/^\d+\.\d+(\.\d+)?$/.test(gv)) continue;
    (out[gv] = out[gv] || []).push(full);
  }
  return out;
}

/** Для отображения: «1.7.10-10.13.4.1614-1.7.10» → «10.13.4.1614». */
function forgeBuild(full, gameVersion) {
  let b = full.slice(gameVersion.length + 1);
  if (b.endsWith('-' + gameVersion)) b = b.slice(0, -(gameVersion.length + 1));
  return b;
}

/** Каталог Forge: { [версия игры]: { all: [full…], recommended: full|null, latest: full|null } } */
function buildForgeCatalog(metaBy, promos) {
  const cat = {};
  const find = (gv, v) => {
    if (!v) return null;
    const all = (metaBy && metaBy[gv]) || [];
    return all.find((f) => f === `${gv}-${v}` || f === `${gv}-${v}-${gv}`) || (all.length ? null : `${gv}-${v}`);
  };
  for (const gv of Object.keys(metaBy || {})) cat[gv] = { all: metaBy[gv].slice(), recommended: null, latest: null };
  for (const [k, v] of Object.entries(promos || {})) {
    const m = /^(\d+\.\d+(?:\.\d+)?)-(recommended|latest)$/.exec(k);
    if (!m) continue;
    const gv = m[1];
    if (!cat[gv]) cat[gv] = { all: [], recommended: null, latest: null };
    const full = find(gv, v);
    if (full) cat[gv][m[2]] = full;
  }
  for (const gv of Object.keys(cat)) {
    const e = cat[gv];
    if (!e.all.length && !e.recommended && !e.latest) delete cat[gv];
  }
  return cat;
}

/** Какую сборку ставить: рекомендуемую, иначе последнюю. */
function pickForge(cat, gameVersion) {
  const e = cat && cat[gameVersion];
  if (!e) return null;
  const full = e.recommended || e.latest || e.all[e.all.length - 1];
  return full ? { full, build: forgeBuild(full, gameVersion), recommended: full === e.recommended } : null;
}

async function forgeCatalog(root, opts) {
  return cached(root, 'forge_catalog.json', async () => {
    const signal = opts && opts.signal;
    const [meta, promos] = await Promise.all([
      (async () => {
        for (const b of forgeMavens()) {
          try { return parseForgeMetadata(await (await dl.fetchRaw(`${b}/${FORGE_PATH}/maven-metadata.xml`, { signal, timeout: 10000, retries: 1 })).text()); }
          catch (e) { if (signal && signal.aborted) throw e; }
        }
        return null;
      })(),
      dl.fetchJson(forgePromosUrl(), { signal, timeout: 10000, retries: 1 }).then((j) => (j && j.promos) || null).catch((e) => { if (signal && signal.aborted) throw e; return null; }),
    ]);
    if (!meta && !promos) throw new Error('Не удалось получить список Forge');
    return buildForgeCatalog(meta || {}, promos || {});
  }, opts);
}

/** id версии, которую создаст установщик (по его install_profile.json). */
function installerVersionId(jarPath) {
  const zip = new AdmZip(jarPath);
  const read = (n) => { const e = zip.getEntry(n); try { return e ? JSON.parse(e.getData().toString('utf8')) : null; } catch { return null; } };
  const p = read('install_profile.json');
  if (p) {
    if (typeof p.version === 'string' && p.json) return p.version;          // установщики 1.13+
    if (p.versionInfo && p.versionInfo.id) return p.versionInfo.id;          // старые установщики
    if (p.install && p.install.target) return p.install.target;
  }
  const v = read('version.json');
  return v && v.id ? v.id : null;
}

function pumpLines(stream, tag, onLine) {
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i).replace(/\r$/, ''), tag); buf = buf.slice(i + 1); }
  });
  stream.on('end', () => { if (buf) onLine(buf, tag); });
}

/** Запускает установщик Forge без окна: java -jar installer --installClient <папка игры>. */
function runInstaller({ javaExe, jar, root, signal, onLine, timeoutMs = 20 * 60 * 1000 }) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(new Error('Отменено'));
    const child = spawn(javaExe, ['-Djava.awt.headless=true', '-jar', jar, '--installClient', root], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const line = onLine || (() => {});
    const tail = [];
    const keep = (l) => { if (l.trim()) { tail.push(l); if (tail.length > 8) tail.shift(); } };
    pumpLines(child.stdout, 'out', (l, t) => { keep(l); line(l, t); });
    pumpLines(child.stderr, 'err', (l, t) => { keep(l); line(l, t); });
    const onAbort = () => { try { child.kill(); } catch { /* уже завершён */ } };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => { onAbort(); reject(new Error('Установщик Forge не завершился за 20 минут')); }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); reject(new Error('Не удалось запустить установщик Forge: ' + e.message)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (signal && signal.aborted) return reject(new Error('Отменено'));
      if (code === 0) return resolve();
      const err = new Error(`Установщик Forge завершился с ошибкой (код ${code}). Подробности — в журнале.`);
      err.tail = tail.slice();
      reject(err);
    });
  });
}

async function downloadForgeInstaller(root, full, { signal, onStage }) {
  const dest = path.join(dirs(root).cache, 'forge', `forge-${full}-installer.jar`);
  let lastErr;
  for (const base of forgeMavens()) {
    const url = `${base}/${FORGE_PATH}/${enc(full)}/forge-${enc(full)}-installer.jar`;
    try {
      let sha1 = null;
      try { sha1 = ((await (await dl.fetchRaw(url + '.sha1', { signal, timeout: 10000, retries: 1 })).text()).trim().match(/^[0-9a-f]{40}/i) || [])[0] || null; } catch { /* без проверки */ }
      if (await dl.exists(dest)) {
        if (!sha1 || (await dl.sha1OfFile(dest)) === sha1.toLowerCase()) return dest;
      }
      if (onStage) onStage(`Скачиваю установщик Forge ${forgeBuild(full, full.split('-')[0])}…`);
      await dl.downloadFile(url, dest, { sha1, signal });
      return dest;
    } catch (e) {
      lastErr = e;
      if (signal && signal.aborted) throw e;
    }
  }
  if (lastErr && lastErr.status === 404) throw new Error(`Для Forge ${full} на сервере нет установщика. Выберите другую версию.`);
  throw lastErr || new Error('Не удалось скачать установщик Forge');
}

/**
 * Устанавливает Forge для версии игры: скачивает установщик и запускает его (он сам докачивает библиотеки
 * и собирает патченый клиент). Ваниль и Java должны быть уже подготовлены (prepare). Возвращает id профиля.
 */
async function installForge({ root, mc: gameVersion, javaExe, signal, onStage, onLine, catalog }) {
  if (onStage) onStage(`Ищу Forge для ${gameVersion}…`);
  const cat = catalog || (await forgeCatalog(root, { signal })).data;
  const pick = pickForge(cat, gameVersion);
  if (!pick) throw new Error(`Для версии ${gameVersion} нет сборок Forge. Выберите другую версию или тип.`);

  const jar = await downloadForgeInstaller(root, pick.full, { signal, onStage });
  const expectedId = installerVersionId(jar);

  // установщик ждёт, что здесь уже запускали официальный лаунчер
  const profiles = path.join(root, 'launcher_profiles.json');
  if (!(await dl.exists(profiles))) await fsp.writeFile(profiles, JSON.stringify({ profiles: {}, settings: {}, version: 3 }, null, 2));

  const before = new Set(await fsp.readdir(dirs(root).versions).catch(() => []));
  if (onStage) onStage(`Устанавливаю Forge ${pick.build}… Это может занять несколько минут.`);
  await runInstaller({ javaExe, jar, root, signal, onLine });

  let id = expectedId;
  if (!id || !(await dl.exists(path.join(dirs(root).versions, id, id + '.json')))) {
    const after = await fsp.readdir(dirs(root).versions).catch(() => []);
    id = after.find((n) => !before.has(n) && detectLoader({ id: n, libraries: [] }) === 'forge') || after.find((n) => !before.has(n)) || null;
  }
  if (!id || !(await dl.exists(path.join(dirs(root).versions, id, id + '.json')))) throw new Error('Установщик Forge завершился, но версия не появилась. Подробности — в журнале.');

  // Старые профили Forge без inheritsFrom/jar ждут свой jar рядом — берём ванильный.
  try {
    const f = path.join(dirs(root).versions, id, id + '.json');
    const j = JSON.parse(await fsp.readFile(f, 'utf8'));
    const jarFile = path.join(dirs(root).versions, id, id + '.jar');
    if (!j.inheritsFrom && !j.jar && !(j.downloads && j.downloads.client) && !(await dl.exists(jarFile))) {
      await fsp.copyFile(path.join(dirs(root).versions, gameVersion, gameVersion + '.jar'), jarFile);
    }
  } catch { /* prepare сам скажет, чего не хватает */ }
  return id;
}

// ---------------------------------------------------------------- списки для интерфейса

/**
 * Версии игры, для которых есть Fabric / Forge, в том же виде, что и listVersions у Vanilla.
 * id — версия игры; loaderVersion — сборка, которая будет установлена (для Forge).
 */
async function listLoaderVersions(root, loader, opts) {
  if (!LOADERS.includes(loader) || loader === 'vanilla') throw new Error('Неизвестный тип версии');
  const [{ manifest, offline: mOff }, installed] = await Promise.all([mc.loadManifest(root, opts), installedByGame(root, loader)]);
  const byId = new Map(manifest ? manifest.versions.map((v) => [v.id, v]) : []);

  let supported = null, catalogOff = false, forgeCat = null, fabricStable = null;
  if (loader === 'fabric') {
    const r = await fabricGames(root, opts);
    catalogOff = r.offline;
    if (r.data) { supported = r.data.map((g) => g.version); fabricStable = new Map(r.data.map((g) => [g.version, g.stable])); }
  } else {
    const r = await forgeCatalog(root, opts);
    catalogOff = r.offline;
    forgeCat = r.data;
    if (forgeCat) supported = Object.keys(forgeCat).filter((gv) => cmpMc(gv, FORGE_MIN_MC) >= 0);
  }

  const list = [];
  const seen = new Set();
  const push = (gv) => {
    if (seen.has(gv)) return;
    seen.add(gv);
    const m = byId.get(gv);
    const type = m ? (m.type === 'snapshot' ? 'snapshot' : 'release')
      : (fabricStable && fabricStable.get(gv) === false ? 'snapshot' : 'release');
    const pick = forgeCat ? pickForge(forgeCat, gv) : null;
    list.push({
      id: gv, type, releaseTime: (m && m.releaseTime) || '', installed: installed.has(gv),
      loaderVersion: pick ? pick.build : null,
    });
  };
  if (supported) {
    const sup = new Set(supported);
    if (manifest) {
      for (const v of manifest.versions) {
        if (!(v.type === 'release' || v.type === 'snapshot')) continue;
        if (Date.parse(v.releaseTime) < Date.parse('2013-06-25T00:00:00+00:00')) continue;
        if (sup.has(v.id)) push(v.id);
      }
    }
    // версии вне манифеста (нет кэша) — в порядке, который отдал сервер / каталог
    const rest = supported.filter((gv) => !seen.has(gv));
    (loader === 'forge' ? rest.sort((a, b) => cmpMc(b, a)) : rest).forEach(push);
  }
  for (const gv of installed.keys()) push(gv);

  return { latest: manifest ? manifest.latest : null, versions: list, offline: !!(mOff || catalogOff) };
}

module.exports = {
  LOADERS, LABEL, detectLoader, gameVersionOf, installedByGame, findInstalled,
  installFabric, installForge, listLoaderVersions,
  parseForgeMetadata, buildForgeCatalog, pickForge, forgeBuild, forgeCatalog, installerVersionId, runInstaller, cmpMc,
};
