'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');

const UA = 'Unlucky-Launcher/1.1';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function withTimeout(signal, ms) {
  const t = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, t]) : t;
}

/** Переводит сетевые ошибки Node/undici в понятный человеку текст. */
function explain(e, url, signal) {
  if (signal && signal.aborted) return new Error('Отменено');
  if (!e || e.fatal || e.status || e.userFacing) return e;
  let host = url;
  try { host = new URL(url).host; } catch { /* оставляем как есть */ }
  const code = (e.cause && e.cause.code) || e.code || '';
  let msg;
  if (e.name === 'TimeoutError' || code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'ETIMEDOUT') msg = `Сервер ${host} не отвечает. Проверьте интернет и попробуйте ещё раз.`;
  else if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') msg = `Не удаётся найти сервер ${host}. Проверьте подключение к интернету.`;
  else if (e.message === 'fetch failed' || code === 'ECONNREFUSED' || code === 'ECONNRESET') msg = `Нет соединения с ${host}${code ? ' (' + code + ')' : ''}. Проверьте интернет, VPN или файрвол.`;
  else if (e.message === 'terminated' || code === 'UND_ERR_SOCKET') msg = `Соединение с ${host} прервалось во время загрузки.`;
  else return e;
  return Object.assign(new Error(msg), { userFacing: true });
}

async function fetchRaw(url, { signal, timeout = 20000, retries = 3 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < retries; attempt++) {
    if (signal && signal.aborted) throw new Error('Отменено');
    try {
      const res = await fetch(url, { signal: withTimeout(signal, timeout), headers: { 'User-Agent': UA } });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status} (${url})`);
        err.status = res.status;
        if (res.status >= 400 && res.status < 500 && res.status !== 429) throw Object.assign(err, { fatal: true });
        throw err;
      }
      return res;
    } catch (e) {
      lastErr = e;
      if (e.fatal || (signal && signal.aborted)) break;
      await sleep(400 * (attempt + 1));
    }
  }
  throw explain(lastErr, url, signal);
}

async function fetchJson(url, opts) {
  const res = await fetchRaw(url, opts);
  return res.json();
}

async function fetchBuffer(url, opts) {
  const res = await fetchRaw(url, opts);
  return Buffer.from(await res.arrayBuffer());
}

async function exists(p) { try { await fsp.access(p); return true; } catch { return false; } }

async function sha1OfFile(file) {
  const h = crypto.createHash('sha1');
  await pipeline(fs.createReadStream(file), h);
  return h.digest('hex');
}

/** Файл уже на месте и совпадает по размеру (если размер известен). */
async function fileOk(dest, size) {
  try {
    const st = await fsp.stat(dest);
    if (!st.isFile()) return false;
    return size == null || st.size === size;
  } catch { return false; }
}

async function downloadFile(url, dest, { sha1, signal, onBytes, timeout = 120000, retries = 3 } = {}) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const part = dest + '.part';
  let lastErr;
  for (let attempt = 0; attempt < retries; attempt++) {
    if (signal && signal.aborted) throw new Error('Отменено');
    let got = 0;
    try {
      const res = await fetchRaw(url, { signal, timeout, retries: 1 });
      const hash = crypto.createHash('sha1');
      const tap = new Transform({
        transform(chunk, _enc, cb) { hash.update(chunk); got += chunk.length; if (onBytes) onBytes(chunk.length); cb(null, chunk); },
      });
      await pipeline(Readable.fromWeb(res.body), tap, fs.createWriteStream(part));
      if (sha1 && hash.digest('hex') !== sha1.toLowerCase()) throw new Error(`Контрольная сумма не совпала: ${path.basename(dest)}`);
      await fsp.rename(part, dest);
      return;
    } catch (e) {
      lastErr = e;
      if (onBytes && got) onBytes(-got); // откатываем учёт прогресса
      try { await fsp.unlink(part); } catch { /* ignore */ }
      if (e.fatal || (signal && signal.aborted)) break;
      await sleep(600 * (attempt + 1));
    }
  }
  throw explain(lastErr, url, signal);
}

/**
 * Параллельная загрузка списка задач [{url, dest, sha1?, size?, executable?}].
 * Уже скачанные файлы (по размеру) пропускаются.
 * onProgress({ done, total, bytes, totalBytes })
 */
async function downloadAll(tasks, { concurrency = 16, signal, onProgress } = {}) {
  const total = tasks.length;
  const totalBytes = tasks.reduce((s, t) => s + (t.size || 0), 0);
  let done = 0, bytes = 0, next = 0, failed = null;
  let lastEmit = 0;
  const emit = (force) => {
    if (!onProgress) return;
    const now = Date.now();
    if (!force && now - lastEmit < 100) return;
    lastEmit = now;
    onProgress({ done, total, bytes, totalBytes });
  };
  emit(true);

  async function worker() {
    while (!failed) {
      const i = next++;
      if (i >= total) return;
      const t = tasks[i];
      try {
        if (await fileOk(t.dest, t.size)) {
          bytes += t.size || 0;
        } else {
          await downloadFile(t.url, t.dest, {
            sha1: t.sha1, signal,
            onBytes: (n) => { bytes += n; emit(false); },
          });
        }
        if (t.executable && process.platform !== 'win32') { try { await fsp.chmod(t.dest, 0o755); } catch { /* ignore */ } }
        done++;
        emit(false);
      } catch (e) {
        failed = failed || e;
        return;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, total)) }, worker));
  if (failed) throw failed;
  emit(true);
}

module.exports = { fetchJson, fetchBuffer, fetchRaw, downloadFile, downloadAll, exists, fileOk, sha1OfFile, sleep, explain, withTimeout };
