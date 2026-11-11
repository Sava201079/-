'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');
const { fetchJson, exists } = require('./download');

// Каталог Java-рантаймов Mojang (тот же, что использует официальный лаунчер)
const RUNTIME_INDEX = 'https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json';

function platformKey() {
  const a = process.arch;
  if (process.platform === 'win32') return a === 'arm64' ? 'windows-arm64' : a === 'ia32' ? 'windows-x86' : 'windows-x64';
  if (process.platform === 'darwin') return a === 'arm64' ? 'mac-os-arm64' : 'mac-os';
  return a === 'ia32' ? 'linux-i386' : 'linux';
}

function javaExeRelative() {
  if (process.platform === 'win32') return path.join('bin', 'java.exe');
  if (process.platform === 'darwin') return path.join('jre.bundle', 'Contents', 'Home', 'bin', 'java');
  return path.join('bin', 'java');
}

/** Запускает `java -version` и возвращает основную версию (8, 17, 21 …) или 0. */
function javaMajor(exe) {
  return new Promise((resolve) => {
    let out = '';
    let p;
    try { p = spawn(exe, ['-version'], { windowsHide: true }); } catch { return resolve(0); }
    const timer = setTimeout(() => { try { p.kill(); } catch { /* ignore */ } resolve(0); }, 8000);
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { out += d; });
    p.on('error', () => { clearTimeout(timer); resolve(0); });
    p.on('close', () => {
      clearTimeout(timer);
      const m = /version "(\d+)(?:\.(\d+))?/.exec(out) || /(?:openjdk|java) (\d+)/i.exec(out);
      if (!m) return resolve(0);
      const first = parseInt(m[1], 10);
      resolve(first === 1 ? parseInt(m[2] || '8', 10) : first);
    });
  });
}

async function findSystemJava(required) {
  const exeName = process.platform === 'win32' ? 'java.exe' : 'java';
  const candidates = [];
  if (process.env.JAVA_HOME) candidates.push(path.join(process.env.JAVA_HOME, 'bin', exeName));
  candidates.push(exeName);
  for (const c of candidates) {
    const major = await javaMajor(c);
    if (major && major >= required) return c;
  }
  return null;
}

/**
 * Определяет, какую Java использовать, и какие файлы для неё нужно скачать.
 * Возвращает { exe, tasks, finalize, source }.
 */
async function planJava({ root, javaVersion, javaPath, signal }) {
  const required = (javaVersion && javaVersion.majorVersion) || 8;
  const component = (javaVersion && javaVersion.component) || 'jre-legacy';
  const noop = async () => {};

  if (javaPath) {
    const major = await javaMajor(javaPath);
    if (!major) throw new Error(`Не удаётся запустить Java по пути из настроек: ${javaPath}`);
    if (major < required) throw new Error(`Для этой версии нужна Java ${required}+, а по пути из настроек — Java ${major}. Выберите автоматический режим.`);
    return { exe: javaPath, tasks: [], finalize: noop, source: 'custom' };
  }

  const key = platformKey();
  const dir = path.join(root, 'runtime', component, key);
  const exe = path.join(dir, javaExeRelative());
  const marker = path.join(dir, '.unlucky-complete');
  const oldMarker = path.join(dir, '.kubik-complete'); // отметка, поставленная лаунчером до переименования
  if (((await exists(marker)) || (await exists(oldMarker))) && (await exists(exe))) return { exe, tasks: [], finalize: noop, source: 'managed' };

  try {
    const all = await fetchJson(RUNTIME_INDEX, { signal });
    const entry = all[key] && all[key][component] && all[key][component][0];
    if (!entry) throw new Error(`для платформы ${key} нет рантайма ${component}`);
    const manifest = await fetchJson(entry.manifest.url, { signal });
    const tasks = [], links = [], dirs = [];
    for (const [rel, f] of Object.entries(manifest.files || {})) {
      if (rel.includes('..')) continue;
      const dest = path.join(dir, ...rel.split('/'));
      if (f.type === 'directory') dirs.push(dest);
      else if (f.type === 'link') links.push({ dest, target: f.target });
      else if (f.type === 'file' && f.downloads && f.downloads.raw) {
        const r = f.downloads.raw;
        tasks.push({ url: r.url, dest, sha1: r.sha1, size: r.size, executable: !!f.executable });
      }
    }
    const finalize = async () => {
      for (const d of dirs) await fsp.mkdir(d, { recursive: true });
      if (process.platform !== 'win32') {
        for (const l of links) {
          try { await fsp.mkdir(path.dirname(l.dest), { recursive: true }); await fsp.rm(l.dest, { force: true }); await fsp.symlink(l.target, l.dest); } catch { /* ignore */ }
        }
      }
      await fsp.writeFile(marker, new Date().toISOString());
    };
    return { exe, tasks, finalize, source: 'managed' };
  } catch (e) {
    if (signal && signal.aborted) throw e;
    const sys = await findSystemJava(required);
    if (sys) return { exe: sys, tasks: [], finalize: noop, source: 'system' };
    throw new Error(`Не удалось получить Java ${required}: ${e.message}. Проверьте интернет или установите Java и укажите путь в настройках.`);
  }
}

module.exports = { planJava, javaMajor, findSystemJava, platformKey };
