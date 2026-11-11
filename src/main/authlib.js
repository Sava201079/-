'use strict';
// authlib-injector — маленький java-агент, который подменяет серверы авторизации Mojang на сторонние (здесь — Ely.by).
// Лаунчер скачивает его один раз в папку лаунчера, сверяет SHA-256 и раз в неделю проверяет, нет ли новой версии.
// Если проверить не удалось (нет интернета), используется уже скачанная копия.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { fetchJson, fetchBuffer } = require('./download');
const { userError } = require('./net');

const JAR = 'authlib-injector.jar';
const META = 'authlib-injector.json';
const RECHECK_MS = 7 * 24 * 3600 * 1000;

function endpoints() {
  const e = process.env;
  return {
    latest: e.UNLUCKY_AUTHLIB_URL || 'https://authlib-injector.yushi.moe/artifact/latest.json',
    github: e.UNLUCKY_AUTHLIB_GITHUB_URL || 'https://api.github.com/repos/yushijinhun/authlib-injector/releases/latest',
  };
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

async function readMeta(dir) {
  try { return JSON.parse(await fsp.readFile(path.join(dir, META), 'utf8')); } catch { return null; }
}
async function writeMeta(dir, meta) {
  const f = path.join(dir, META);
  await fsp.writeFile(f + '.part', JSON.stringify(meta, null, 2));
  await fsp.rename(f + '.part', f);
}

/** Скачанный jar на месте и цел (сверяем хэш с тем, что записали при загрузке). */
async function cachedJarOk(jar, meta) {
  try {
    const buf = await fsp.readFile(jar);
    if (buf.length < 1000 || buf[0] !== 0x50 || buf[1] !== 0x4b) return false; // «PK»
    return !meta || !meta.sha256 || sha256(buf) === meta.sha256;
  } catch { return false; }
}

/** Что сейчас считается последней версией: { version, url, sha256 }. */
async function latest(signal) {
  const e = endpoints();
  try {
    const d = await fetchJson(e.latest, { signal, retries: 2 });
    if (d && /^https?:\/\//.test(String(d.download_url || ''))) {
      return { version: String(d.version || d.build_number || ''), url: d.download_url, sha256: String((d.checksums && d.checksums.sha256) || '').toLowerCase() };
    }
  } catch (err) { if (signal && signal.aborted) throw err; /* пробуем GitHub */ }
  const g = await fetchJson(e.github, { signal, retries: 2 });
  const asset = ((g && g.assets) || []).find((a) => /^authlib-injector-.*\.jar$/.test(a.name || ''));
  if (!asset || !/^https?:\/\//.test(String(asset.browser_download_url || ''))) throw new Error('в релизе нет jar-файла');
  return { version: String(g.tag_name || '').replace(/^v/, ''), url: asset.browser_download_url, sha256: '' };
}

/** Возвращает путь к authlib-injector.jar, при необходимости скачивая его в dir. */
async function ensure(dir, { signal, force } = {}) {
  await fsp.mkdir(dir, { recursive: true });
  const jar = path.join(dir, JAR);
  const meta = await readMeta(dir);
  const have = !!meta && await cachedJarOk(jar, meta);
  if (have && !force && Date.now() - (meta.checkedAt || 0) < RECHECK_MS) return jar;

  let info;
  try { info = await latest(signal); } catch (e) {
    if (signal && signal.aborted) throw e;
    if (have) return jar; // нет сети — работаем с тем, что есть
    throw userError(`Не удалось получить authlib-injector (нужен для входа через Ely.by): ${e.message}`);
  }
  if (have && meta.version === info.version && (!info.sha256 || meta.sha256 === info.sha256)) {
    await writeMeta(dir, { ...meta, checkedAt: Date.now() }).catch(() => {});
    return jar;
  }

  try {
    const buf = await fetchBuffer(info.url, { signal, timeout: 60000 });
    const hash = sha256(buf);
    if (info.sha256 && hash !== info.sha256) throw userError('Контрольная сумма authlib-injector не совпала — файл повреждён или подменён.');
    if (buf.length < 1000 || buf[0] !== 0x50 || buf[1] !== 0x4b) throw userError('Скачанный authlib-injector не похож на jar-файл.');
    await fsp.writeFile(jar + '.part', buf);
    await fsp.rename(jar + '.part', jar);
    await writeMeta(dir, { version: info.version, sha256: hash, checkedAt: Date.now() });
    return jar;
  } catch (e) {
    try { await fsp.unlink(jar + '.part'); } catch { /* ignore */ }
    if (signal && signal.aborted) throw e;
    if (have) return jar;
    throw e.userFacing ? e : userError(`Не удалось скачать authlib-injector (нужен для входа через Ely.by): ${e.message}`);
  }
}

module.exports = { ensure, JAR };
