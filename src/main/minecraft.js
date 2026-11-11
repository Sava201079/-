'use strict';
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const AdmZip = require('adm-zip');
const dl = require('./download');
const { planJava } = require('./java');

const LAUNCHER_NAME = 'Unlucky';
const MANIFEST_URLS = [
  'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json',
  'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json',
];
const manifestUrls = () => (process.env.UNLUCKY_MANIFEST_URL ? [process.env.UNLUCKY_MANIFEST_URL] : MANIFEST_URLS);
const LIB_BASE = 'https://libraries.minecraft.net/';
const resBase = () => process.env.UNLUCKY_RESOURCES_URL || 'https://resources.download.minecraft.net';
// Версии новее 1.6.1 используют современный формат запуска; более старые не поддерживаются.
const MIN_RELEASE_TIME = Date.parse('2013-06-25T00:00:00+00:00');

// ---------------------------------------------------------------- правила

function osName() { return { win32: 'windows', darwin: 'osx', linux: 'linux' }[process.platform] || process.platform; }
function osArch() { return process.arch === 'ia32' ? 'x86' : process.arch; }

function ruleMatches(rule, features) {
  if (rule.os) {
    if (rule.os.name && rule.os.name !== osName()) return false;
    if (rule.os.arch && rule.os.arch !== osArch()) return false;
    if (rule.os.version) {
      try { if (!new RegExp(rule.os.version).test(os.release())) return false; } catch { /* ignore */ }
    }
  }
  if (rule.features) {
    for (const [k, v] of Object.entries(rule.features)) if (!!(features && features[k]) !== !!v) return false;
  }
  return true;
}

/** Правила Mojang: по умолчанию запрещено, последнее подходящее правило решает. */
function rulesAllow(rules, features) {
  if (!rules || !rules.length) return true;
  let allowed = false;
  for (const r of rules) if (ruleMatches(r, features)) allowed = r.action === 'allow';
  return allowed;
}

// ---------------------------------------------------------------- пути

function dirs(root) {
  return {
    versions: path.join(root, 'versions'),
    libraries: path.join(root, 'libraries'),
    assets: path.join(root, 'assets'),
    cache: path.join(root, 'cache'),
  };
}

function mavenPath(name) {
  let ext = 'jar';
  if (name.includes('@')) { const p = name.split('@'); name = p[0]; ext = p[1]; }
  const [g, a, v, c] = name.split(':');
  return `${g.replace(/\./g, '/')}/${a}/${v}/${a}-${v}${c ? '-' + c : ''}.${ext}`;
}

// ---------------------------------------------------------------- список версий

async function readCachedManifest(root) {
  try { return JSON.parse(await fsp.readFile(path.join(dirs(root).cache, 'version_manifest.json'), 'utf8')); } catch { return null; }
}

async function loadManifest(root, { signal, refresh = true } = {}) {
  const cacheFile = path.join(dirs(root).cache, 'version_manifest.json');
  if (refresh) {
    for (const url of manifestUrls()) {
      try {
        const m = await dl.fetchJson(url, { signal, timeout: 8000, retries: 1 });
        await fsp.mkdir(path.dirname(cacheFile), { recursive: true });
        await fsp.writeFile(cacheFile, JSON.stringify(m));
        return { manifest: m, offline: false };
      } catch (e) { if (signal && signal.aborted) throw e; }
    }
  }
  const cached = await readCachedManifest(root);
  return { manifest: cached, offline: true };
}

async function installedIds(root) {
  const out = new Map();
  let names = [];
  try { names = await fsp.readdir(dirs(root).versions); } catch { return out; }
  for (const id of names) {
    const jf = path.join(dirs(root).versions, id, id + '.json');
    if (!(await dl.exists(jf))) continue;
    try {
      const j = JSON.parse(await fsp.readFile(jf, 'utf8'));
      const hasJar = await dl.exists(path.join(dirs(root).versions, id, id + '.jar'));
      out.set(id, { json: j, complete: hasJar || !!j.inheritsFrom });
    } catch { /* битый json — пропускаем */ }
  }
  return out;
}

/** Какой загрузчик у профиля из папки versions: 'fabric' | 'forge' | null. NeoForge и Quilt сюда не относятся. */
function detectLoader(json) {
  const id = String((json && json.id) || '');
  const names = ((json && json.libraries) || []).map((l) => String((l && l.name) || ''));
  if (id.startsWith('fabric-loader-') || names.some((n) => n.startsWith('net.fabricmc:fabric-loader:'))) return 'fabric';
  if (names.some((n) => /^net\.minecraftforge:(forge|fmlloader|fmlcore|minecraftforge):/.test(n)) || (/forge/i.test(id) && !/neoforge/i.test(id))) return 'forge';
  return null;
}

async function listVersions(root, opts) {
  const { manifest, offline } = await loadManifest(root, opts);
  const local = await installedIds(root);
  const list = [];
  const seen = new Set();
  if (manifest) {
    for (const v of manifest.versions) {
      const t = Date.parse(v.releaseTime);
      if (!(v.type === 'release' || v.type === 'snapshot')) continue;
      if (t < MIN_RELEASE_TIME) continue;
      seen.add(v.id);
      list.push({ id: v.id, type: v.type, releaseTime: v.releaseTime, installed: !!(local.get(v.id) && local.get(v.id).complete) });
    }
  }
  for (const [id, info] of local) {
    if (seen.has(id)) continue;
    if (detectLoader(info.json)) continue; // профили Fabric/Forge показываются в своих списках
    list.push({ id, type: info.json.type === 'snapshot' ? 'snapshot' : (info.json.type === 'release' ? 'release' : 'custom'), releaseTime: info.json.releaseTime || '', installed: info.complete, local: true });
  }
  return { latest: manifest ? manifest.latest : null, versions: list, offline };
}

// ---------------------------------------------------------------- version.json

function mergeInherited(child, parent) {
  const merged = Object.assign({}, parent, child);
  // как в официальном лаунчере: библиотека профиля (Fabric/Forge) заменяет ту же библиотеку родителя, а не дублирует её
  const libKey = (l) => { const p = String((l && l.name) || '').split(':'); return p.length >= 3 ? [p[0], p[1], p[3] || ''].join(':') : null; };
  const own = new Set((child.libraries || []).map(libKey).filter(Boolean));
  merged.libraries = [].concat(child.libraries || [], (parent.libraries || []).filter((l) => { const k = libKey(l); return !k || !own.has(k); }));
  // дата выхода самой игры (у профиля загрузчика своя, а от неё зависит формат ресурспака)
  merged._baseReleaseTime = parent._baseReleaseTime || parent.releaseTime || child.releaseTime;
  if (parent.arguments || child.arguments) {
    merged.arguments = {
      game: [].concat((parent.arguments && parent.arguments.game) || [], (child.arguments && child.arguments.game) || []),
      jvm: [].concat((parent.arguments && parent.arguments.jvm) || [], (child.arguments && child.arguments.jvm) || []),
    };
  }
  merged._jarId = child.jar || (child.downloads && child.downloads.client ? child.id : parent._jarId || parent.id);
  return merged;
}

async function ensureVersionJson(root, id, { signal } = {}) {
  const file = path.join(dirs(root).versions, id, id + '.json');
  if (!(await dl.exists(file))) {
    const { manifest } = await loadManifest(root, { signal, refresh: !(await readCachedManifest(root)) });
    const entry = manifest && manifest.versions.find(v => v.id === id);
    if (!entry) throw new Error(`Версия ${id} не найдена. Проверьте подключение к интернету.`);
    await dl.downloadFile(entry.url, file, { sha1: entry.sha1, signal });
  }
  let json = JSON.parse(await fsp.readFile(file, 'utf8'));
  if (json.inheritsFrom) {
    const parent = await ensureVersionJson(root, json.inheritsFrom, { signal });
    json = mergeInherited(json, parent);
  } else {
    json._jarId = json.jar || id;
    json._baseReleaseTime = json.releaseTime;
  }
  json.id = json.id || id;
  return json;
}

// ---------------------------------------------------------------- планирование загрузок

function planLibraries(json, root) {
  const libDir = dirs(root).libraries;
  const cp = [], natives = [], tasks = [];
  const seen = new Set();
  const is64 = process.arch !== 'ia32';
  const add = (a, isNative, exclude) => {
    const dest = path.join(libDir, ...a.path.split('/'));
    if (a.url) tasks.push({ url: a.url, dest, sha1: a.sha1, size: a.size });
    if (isNative) natives.push({ file: dest, exclude: exclude || [] });
    else if (!seen.has(dest)) { seen.add(dest); cp.push(dest); }
  };

  for (const lib of json.libraries || []) {
    if (lib.rules && !rulesAllow(lib.rules)) continue;
    const dls = lib.downloads || {};
    let classifier = null;
    if (lib.natives && lib.natives[osName()]) classifier = lib.natives[osName()].replace('${arch}', is64 ? '64' : '32');
    const base = lib.url || LIB_BASE;

    if (!classifier || dls.artifact) {
      let a = dls.artifact;
      if (!a && !dls.classifiers && lib.name) { const p = mavenPath(lib.name); a = { path: p, url: base + p }; }
      if (a) add(a, false);
    }
    if (classifier) {
      let n = dls.classifiers && dls.classifiers[classifier];
      if (!n && lib.name) { const p = mavenPath(lib.name + ':' + classifier); n = { path: p, url: base + p }; }
      if (n) add(n, true, lib.extract && lib.extract.exclude);
    }
  }
  return { cp, natives, tasks };
}

async function planAssets(json, root, { signal } = {}) {
  const ref = json.assetIndex;
  if (!ref) return { tasks: [], index: null, id: json.assets || 'legacy' };
  const id = ref.id || json.assets;
  const file = path.join(dirs(root).assets, 'indexes', id + '.json');
  if (!(await dl.fileOk(file, ref.size))) await dl.downloadFile(ref.url, file, { sha1: ref.sha1, signal });
  const index = JSON.parse(await fsp.readFile(file, 'utf8'));
  const byHash = new Map();
  for (const o of Object.values(index.objects || {})) {
    if (byHash.has(o.hash)) continue;
    const p2 = o.hash.slice(0, 2);
    byHash.set(o.hash, { url: `${resBase()}/${p2}/${o.hash}`, dest: path.join(dirs(root).assets, 'objects', p2, o.hash), sha1: o.hash, size: o.size });
  }
  return { tasks: [...byHash.values()], index, id };
}

function planLogging(json, root) {
  const c = json.logging && json.logging.client;
  if (!c || !c.file) return null;
  const dest = path.join(dirs(root).assets, 'log_configs', c.file.id);
  return { task: { url: c.file.url, dest, sha1: c.file.sha1, size: c.file.size }, arg: (c.argument || '').replace('${path}', dest) };
}

async function copyAssetsLegacy(root, gameDir, assets) {
  const idx = assets.index;
  if (!idx || !(idx.virtual || idx.map_to_resources)) return null;
  const target = idx.map_to_resources ? path.join(gameDir, 'resources') : path.join(dirs(root).assets, 'virtual', assets.id);
  for (const [name, o] of Object.entries(idx.objects)) {
    if (name.includes('..')) continue;
    const dest = path.join(target, ...name.split('/'));
    if (await dl.exists(dest)) continue;
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.copyFile(path.join(dirs(root).assets, 'objects', o.hash.slice(0, 2), o.hash), dest);
  }
  return target;
}

async function extractNatives(nativesDir, natives) {
  if (!natives.length) return;
  const marker = path.join(nativesDir, '.unlucky-ok');
  const stamp = crypto.createHash('sha1').update(natives.map(n => n.file).join('|')).digest('hex');
  try { if ((await fsp.readFile(marker, 'utf8')) === stamp) return; } catch { /* нужно извлечь */ }
  await fsp.rm(nativesDir, { recursive: true, force: true }).catch(() => {});
  await fsp.mkdir(nativesDir, { recursive: true });
  for (const n of natives) {
    const zip = new AdmZip(n.file);
    for (const e of zip.getEntries()) {
      if (e.isDirectory) continue;
      if (n.exclude.some(x => e.entryName.startsWith(x))) continue;
      const name = path.basename(e.entryName);
      if (!name || name === '.' || name === '..') continue;
      await fsp.writeFile(path.join(nativesDir, name), e.getData());
    }
  }
  await fsp.writeFile(marker, stamp);
}

/**
 * Скачивает всё необходимое для версии и возвращает данные для запуска.
 */
async function prepare({ root, id, gameDir, javaPath, signal, onStage, onProgress }) {
  const stage = (s) => { if (onStage) onStage(s); };
  stage('Получаю данные версии…');
  const json = await ensureVersionJson(root, id, { signal });
  const tasks = [];

  const jarId = json._jarId || id;
  const clientJar = path.join(dirs(root).versions, jarId, jarId + '.jar');
  const dc = json.downloads && json.downloads.client;
  if (dc) tasks.push({ url: dc.url, dest: clientJar, sha1: dc.sha1, size: dc.size });
  else if (!(await dl.exists(clientJar))) throw new Error(`Не найден клиент ${jarId}.jar`);

  const libs = planLibraries(json, root);
  tasks.push(...libs.tasks);

  stage('Проверяю ресурсы…');
  const assets = await planAssets(json, root, { signal });
  tasks.push(...assets.tasks);

  const logging = planLogging(json, root);
  if (logging) tasks.push(logging.task);

  stage('Готовлю Java…');
  const java = await planJava({ root, javaVersion: json.javaVersion, javaPath, signal });
  tasks.push(...java.tasks);

  stage('Загрузка файлов…');
  await dl.downloadAll(tasks, { concurrency: 16, signal, onProgress });
  await java.finalize();

  stage('Подготавливаю запуск…');
  const nativesDir = path.join(dirs(root).versions, id, 'natives');
  await extractNatives(nativesDir, libs.natives);
  const gameAssets = (await copyAssetsLegacy(root, gameDir, assets)) || dirs(root).assets;

  return {
    json, clientJar, classpath: [...libs.cp, clientJar], nativesDir,
    assetsRoot: dirs(root).assets, libraryDir: dirs(root).libraries, assetsIndexName: assets.id, gameAssets,
    loggingArg: logging ? logging.arg : '', javaExe: java.exe, javaSource: java.source,
  };
}

// ---------------------------------------------------------------- запуск

/** Офлайн-UUID так же, как это делает Java: UUID.nameUUIDFromBytes("OfflinePlayer:" + name) */
function offlineUuid(name) {
  const h = crypto.createHash('md5').update('OfflinePlayer:' + name, 'utf8').digest();
  h[6] = (h[6] & 0x0f) | 0x30;
  h[8] = (h[8] & 0x3f) | 0x80;
  return h.toString('hex');
}

function splitArgs(str) {
  const out = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(str || ''))) out.push(m[1] !== undefined ? m[1] : m[2]);
  return out;
}

function subst(s, map) { return s.replace(/\$\{([^}]+)\}/g, (m, k) => (k in map ? String(map[k]) : m)); }

function expandArgs(list, map, features) {
  const out = [];
  for (const a of list || []) {
    if (typeof a === 'string') out.push(subst(a, map));
    else if (a && rulesAllow(a.rules, features)) {
      const v = a.value;
      if (Array.isArray(v)) v.forEach(x => out.push(subst(x, map)));
      else if (v != null) out.push(subst(v, map));
    }
  }
  return out;
}

/**
 * Собирает команду запуска. Чистая функция — удобна для тестов.
 * p: результат prepare() + { gameDir, nickname, ramMb, jvmArgs, launcherVersion }
 *   + необязательно auth { username, uuid, accessToken, userType } — данные онлайн-аккаунта (иначе оффлайн-вход по нику)
 *   + необязательно javaAgent { jar, api } — authlib-injector для серверов авторизации вроде Ely.by
 */
function buildCommand(p) {
  const json = p.json;
  const sep = process.platform === 'win32' ? ';' : ':';
  const auth = p.auth || null;
  const map = {
    auth_player_name: auth ? auth.username : p.nickname,
    version_name: json.id,
    game_directory: p.gameDir,
    assets_root: p.assetsRoot,
    assets_index_name: p.assetsIndexName,
    game_assets: p.gameAssets,
    auth_uuid: auth ? auth.uuid : offlineUuid(p.nickname),
    auth_access_token: auth ? auth.accessToken : '0',
    auth_session: auth ? `token:${auth.accessToken}:${auth.uuid}` : '0', // так просят версии 1.6–1.12
    clientid: '0',
    auth_xuid: '0',
    user_type: auth ? auth.userType : 'legacy',
    version_type: json.type || 'release',
    user_properties: '{}',
    natives_directory: p.nativesDir,
    launcher_name: LAUNCHER_NAME,
    launcher_version: p.launcherVersion || '1.0',
    classpath: p.classpath.join(sep),
    classpath_separator: sep,
    library_directory: p.libraryDir,
  };
  const features = {}; // демо-режим, свой размер окна и quick play не используем

  let jvm, game;
  if (json.arguments) {
    jvm = expandArgs(json.arguments.jvm, map, features);
    game = expandArgs(json.arguments.game, map, features);
  } else {
    jvm = [`-Djava.library.path=${p.nativesDir}`, `-Dminecraft.launcher.brand=${LAUNCHER_NAME}`,
      `-Dminecraft.launcher.version=${map.launcher_version}`, '-cp', map.classpath];
    game = splitArgs(json.minecraftArguments || '').map(a => subst(a, map));
  }
  if (!jvm.includes('-cp') && !jvm.includes('-classpath')) jvm.push('-cp', map.classpath);

  const ram = Math.max(512, parseInt(p.ramMb, 10) || 2048);
  const args = [
    `-Xmx${ram}M`, `-Xms${Math.min(ram, 512)}M`,
    '-Dlog4j2.formatMsgNoLookups=true',
    '-Dfile.encoding=UTF-8',
    ...(p.javaAgent ? [`-javaagent:${p.javaAgent.jar}=${p.javaAgent.api}`, '-Dauthlibinjector.noLogFile'] : []),
    ...jvm,
    ...(p.loggingArg ? [p.loggingArg] : []),
    ...splitArgs(p.jvmArgs),
    json.mainClass,
    ...game,
  ];
  return { command: p.javaExe, args, cwd: p.gameDir };
}

function launchGame(cmd, { onLine, onExit }) {
  const child = spawn(cmd.command, cmd.args, { cwd: cmd.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const pump = (stream, tag) => {
    let buf = '';
    stream.setEncoding('utf8');
    stream.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i).replace(/\r$/, ''), tag); buf = buf.slice(i + 1); }
    });
    stream.on('end', () => { if (buf) onLine(buf, tag); });
  };
  pump(child.stdout, 'out');
  pump(child.stderr, 'err');
  child.on('error', (e) => onExit(-1, e));
  child.on('close', (code) => onExit(code, null));
  return child;
}

module.exports = {
  LAUNCHER_NAME, rulesAllow, mavenPath, listVersions, loadManifest, installedIds, detectLoader, ensureVersionJson, mergeInherited,
  planLibraries, prepare, buildCommand, launchGame, offlineUuid, splitArgs, dirs,
};
