'use strict';
// Вход через Ely.by — бесплатный сервис аккаунтов и скинов с Yggdrasil-совместимым API (как у Mojang до 2022 года).
// Игра при этом запускается с authlib-injector (см. authlib.js): он направляет проверку входа на сервер Ely.by,
// поэтому ваш скин видят все, кто заходит на серверы с поддержкой Ely.by.
// Загрузить скин через API нельзя: его выставляют на сайте https://ely.by/skins.

const crypto = require('crypto');
const { request, userError } = require('./net');

const SKINS_URL = 'https://ely.by/skins';
const REGISTER_URL = 'https://account.ely.by/register';

function base() { return (process.env.UNLUCKY_ELYBY_URL || 'https://authserver.ely.by').replace(/\/$/, ''); }
/** Значение для -javaagent:authlib-injector.jar=<api>. */
function agentApi() { return process.env.UNLUCKY_ELYBY_AGENT_API || 'ely.by'; }
/** Откуда authlib-injector берёт скин игрока (для показа аватара в лаунчере). */
function skinUrlFor(name) { return (process.env.UNLUCKY_ELYBY_SKINS_URL || 'http://skinsystem.ely.by/skins').replace(/\/$/, '') + '/' + encodeURIComponent(name) + '.png'; }

function newClientToken() { return crypto.randomUUID().replace(/-/g, ''); }

function failure(r, { hadTotp } = {}) {
  const d = r.data || {};
  const msg = String(d.errorMessage || d.message || '');
  if (r.status === 429 || /too many|slow down/i.test(msg)) return userError('Ely.by временно ограничил попытки входа. Подождите несколько минут и попробуйте снова.');
  if (r.status === 401 || r.status === 403) {
    if (/suspend|ban|block/i.test(msg)) return userError('Аккаунт Ely.by заблокирован.');
    return userError(hadTotp ? 'Неверный логин, пароль или код из приложения.' : 'Неверный логин или пароль Ely.by.');
  }
  return userError(`Ely.by не принял запрос (HTTP ${r.status}). Попробуйте позже.`);
}

function profileOf(d) {
  const p = (d && d.selectedProfile) || (d && d.availableProfiles && d.availableProfiles[0]);
  if (!p || !p.id || !p.name) throw userError('У этого аккаунта Ely.by нет игрового профиля. Задайте ник на account.ely.by.');
  return { name: p.name, uuid: String(p.id).replace(/-/g, '') };
}

/**
 * Вход по логину (ник или e-mail) и паролю. Если включена двухфакторная защита, сервер сначала отвечает
 * ошибкой — тогда бросаем исключение с twoFactor: true, и вызывающий код просит код и повторяет вызов с totp.
 * → { name, uuid, accessToken, clientToken }
 */
async function authenticate(login, password, { totp, clientToken, signal } = {}) {
  if (!login || !password) throw userError('Введите логин и пароль Ely.by.');
  clientToken = clientToken || newClientToken();
  const pass = totp ? `${password}:${String(totp).replace(/\s+/g, '')}` : password;
  const r = await request(base() + '/auth/authenticate', {
    method: 'POST', signal, json: { username: login, password: pass, clientToken, requestUser: false },
  });
  const d = r.data || {};
  if (r.status === 401 && /two.?factor/i.test(String(d.errorMessage || ''))) {
    throw userError('Для этого аккаунта включена двухфакторная защита. Введите код из приложения-аутентификатора.', { twoFactor: true });
  }
  if (!r.ok || !d.accessToken) throw failure(r, { hadTotp: !!totp });
  return { ...profileOf(d), accessToken: d.accessToken, clientToken: d.clientToken || clientToken };
}

/** true — токен действует, false — нет. Сетевые ошибки пробрасываются. */
async function validate(accessToken, { signal } = {}) {
  const r = await request(base() + '/auth/validate', { method: 'POST', signal, json: { accessToken } });
  if (r.status === 204 || r.status === 200) return true;
  if (r.status === 401 || r.status === 403 || r.status === 400) return false;
  throw userError(`Ely.by не отвечает как обычно (HTTP ${r.status}). Попробуйте позже.`);
}

/** Меняет устаревший токен на новый. Ошибка с relogin: true — нужно войти заново. */
async function refresh(accessToken, clientToken, { signal } = {}) {
  const r = await request(base() + '/auth/refresh', { method: 'POST', signal, json: { accessToken, clientToken, requestUser: false } });
  const d = r.data || {};
  if (!r.ok || !d.accessToken) {
    if (r.status === 401 || r.status === 403 || r.status === 400) throw userError('Сессия Ely.by истекла — войдите в аккаунт заново.', { relogin: true });
    throw failure(r);
  }
  return { ...profileOf(d), accessToken: d.accessToken, clientToken: d.clientToken || clientToken };
}

/**
 * Проверяет токен аккаунта и при необходимости обновляет его.
 * Возвращает null, если токен годен, иначе — новые поля аккаунта { name, uuid, accessToken, clientToken }.
 */
async function ensureValid(acc, { signal } = {}) {
  if (!acc.accessToken) throw userError('Сессия Ely.by истекла — войдите в аккаунт заново.', { relogin: true });
  if (await validate(acc.accessToken, { signal })) return null;
  return refresh(acc.accessToken, acc.clientToken, { signal });
}

/** При выходе из аккаунта просим сервер аннулировать токен. Ошибки не важны. */
async function invalidate(accessToken, clientToken) {
  if (!accessToken) return;
  try { await request(base() + '/auth/invalidate', { method: 'POST', json: { accessToken, clientToken }, timeout: 8000 }); } catch { /* ignore */ }
}

module.exports = { SKINS_URL, REGISTER_URL, agentApi, skinUrlFor, newClientToken, authenticate, validate, refresh, ensureValid, invalidate };
