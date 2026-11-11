'use strict';
// Фейковые серверы для проверки аккаунтов: Ely.by, скины, authlib-injector.
// Используется и автотестами (test/auth.test.js), и ручной проверкой интерфейса.
const assert = require('node:assert/strict');
const http = require('http');
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const { PNG } = require('pngjs');

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const png64 = () => { const p = new PNG({ width: 64, height: 64 }); p.data.fill(200); return PNG.sync.write(p); };

// ---------------------------------------------------------------- фейковый мир

/** Один HTTP-сервер изображает Ely.by, сервер скинов и authlib-injector. */
async function fakeWorld(opts = {}) {
  const w = {
    ely: { user: 'bob', pass: 'pw', twoFactor: false, totp: '123456', valid: new Set(), seq: 0, invalidated: [], refreshOk: true },
    authlib: { version: '1.2.5', jar: null, sha: '', downloads: 0, latestCalls: 0, breakLatest: false, badSha: false },
    ...opts,
  };
  const jar = new AdmZip(); jar.addFile('META-INF/MANIFEST.MF', Buffer.from('Premain-Class: x\n')); jar.addFile('payload.bin', crypto.randomBytes(4000)); // несжимаемое содержимое: настоящий jar весит десятки килобайт
  w.authlib.jar = jar.toBuffer(); w.authlib.sha = sha256(w.authlib.jar);
  const skinTex = png64();

  const readBody = (req) => new Promise((resolve) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => resolve(Buffer.concat(c))); });
  const send = (res, status, obj, headers) => {
    const body = obj == null ? '' : (Buffer.isBuffer(obj) ? obj : JSON.stringify(obj));
    res.writeHead(status, { 'Content-Type': Buffer.isBuffer(obj) ? 'application/octet-stream' : 'application/json', ...(headers || {}) });
    res.end(body);
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const raw = await readBody(req);
    const ct = req.headers['content-type'] || '';
    const form = ct.includes('urlencoded') ? Object.fromEntries(new URLSearchParams(raw.toString())) : {};
    const json = ct.includes('json') && raw.length ? JSON.parse(raw.toString()) : {};
    const bearer = (req.headers.authorization || '').replace(/^Bearer /, '');
    const p = url.pathname;

    // ---- Ely.by
    if (p.startsWith('/ely/auth/')) {
      const e = w.ely;
      if (p.endsWith('/authenticate')) {
        if (json.username !== e.user) return send(res, 401, { error: 'ForbiddenOperationException', errorMessage: 'Invalid credentials. Invalid username or password.' });
        if (e.twoFactor && !json.password.includes(':')) return send(res, 401, { error: 'ForbiddenOperationException', errorMessage: 'Account protected with two factor auth.' });
        const want = e.twoFactor ? `${e.pass}:${e.totp}` : e.pass;
        if (json.password !== want) return send(res, 401, { error: 'ForbiddenOperationException', errorMessage: 'Invalid credentials. Invalid username or password.' });
        const t = 'ELY-' + (++e.seq); e.valid.add(t);
        return send(res, 200, { accessToken: t, clientToken: json.clientToken, selectedProfile: { id: 'bb0b0b0b0b0b4b0b8b0b0b0b0b0b0b0b', name: 'Bob' }, availableProfiles: [] });
      }
      if (p.endsWith('/validate')) return send(res, e.valid.has(json.accessToken) ? 204 : 401, e.valid.has(json.accessToken) ? null : { errorMessage: 'Invalid token' });
      if (p.endsWith('/refresh')) {
        if (!e.refreshOk || !e.valid.has(json.accessToken)) { if (!e.refreshOk) return send(res, 401, { errorMessage: 'Invalid token' }); }
        const t = 'ELY-' + (++e.seq); e.valid.add(t);
        return send(res, 200, { accessToken: t, clientToken: json.clientToken, selectedProfile: { id: 'bb0b0b0b0b0b4b0b8b0b0b0b0b0b0b0b', name: 'Bob' } });
      }
      if (p.endsWith('/invalidate')) { e.invalidated.push(json.accessToken); e.valid.delete(json.accessToken); return send(res, 204, null); }
    }
    if (p === '/skins/Bob.png') return send(res, 200, skinTex);

    // ---- authlib-injector
    if (p === '/authlib/latest.json') {
      w.authlib.latestCalls++;
      if (w.authlib.breakLatest) return send(res, 500, { error: 'down' });
      return send(res, 200, { build_number: 42, version: w.authlib.version, download_url: w.base + '/authlib/a.jar', checksums: { sha256: w.authlib.badSha ? '0'.repeat(64) : w.authlib.sha } });
    }
    if (p === '/authlib/a.jar') { w.authlib.downloads++; return send(res, 200, w.authlib.jar); }
    send(res, 404, { error: 'not found ' + p });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  w.base = `http://127.0.0.1:${server.address().port}`;
  w.close = () => new Promise((r) => { server.closeAllConnections(); server.close(r); });
  return w;
}

const ENV = [
  'UNLUCKY_ELYBY_URL', 'UNLUCKY_ELYBY_SKINS_URL', 'UNLUCKY_AUTHLIB_URL', 'UNLUCKY_AUTHLIB_GITHUB_URL', 'UNLUCKY_ELYBY_AGENT_API'];

async function withWorld(opts, fn) {
  if (typeof opts === 'function') { fn = opts; opts = {}; }
  const w = await fakeWorld(opts);
  const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  Object.assign(process.env, {
    UNLUCKY_ELYBY_URL: w.base + '/ely', UNLUCKY_ELYBY_SKINS_URL: w.base + '/skins', UNLUCKY_AUTHLIB_URL: w.base + '/authlib/latest.json',
    UNLUCKY_AUTHLIB_GITHUB_URL: w.base + '/nope', UNLUCKY_ELYBY_AGENT_API: w.base + '/ely-root',
  });
  try { return await fn(w); }
  finally {
    for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    await w.close();
  }
}

module.exports = { fakeWorld, withWorld, ENV, sha256, png64 };
