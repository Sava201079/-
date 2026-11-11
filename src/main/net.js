'use strict';
// Запросы к серверам авторизации (Microsoft, Xbox, Mojang, Ely.by). В отличие от download.js ничего не повторяем:
// повторная отправка пароля или кода входа — плохая идея. Ответы с ошибкой HTTP не бросают исключений —
// их разбирает вызывающий код, потому что у каждого сервиса свой формат ошибок.

const { explain, withTimeout } = require('./download');

const UA = 'Unlucky-Launcher/1.4';

/** Ошибка, текст которой можно показать пользователю как есть. */
function userError(message, extra) {
  return Object.assign(new Error(message), { userFacing: true }, extra || {});
}

/**
 * request(url, { method, headers, json, form, body, signal, timeout })
 * → { status, ok, data (разобранный JSON или null), text, headers }
 */
async function request(url, { method = 'GET', headers = {}, json, form, body, signal, timeout = 20000 } = {}) {
  const h = { 'User-Agent': UA, Accept: 'application/json', ...headers };
  let payload = body;
  if (json !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(json); }
  else if (form) { h['Content-Type'] = 'application/x-www-form-urlencoded'; payload = new URLSearchParams(form).toString(); }
  try {
    const res = await fetch(url, { method, headers: h, body: payload, signal: withTimeout(signal, timeout) });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* не JSON */ }
    return { status: res.status, ok: res.ok, data, text, headers: res.headers };
  } catch (e) { throw explain(e, url, signal); }
}

/** Пауза, которую можно прервать сигналом отмены. */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(new Error('Отменено'));
    const t = setTimeout(() => { if (signal) signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(new Error('Отменено')); };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

module.exports = { request, sleep, userError, UA };
