'use strict';
// «Supabase» для проверок: настоящий Postgres (PGlite) с настоящим friends/friends.sql за HTTP-сервером,
// который повторяет то, что делают Supabase Auth и PostgREST: анонимный вход, обновление токена, вызов функций,
// ошибки с кодами. Формат ответов взят из документации Supabase; с настоящим сервером он не сверялся.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PGlite } = require('@electric-sql/pglite');

const SQL = fs.readFileSync(path.join(__dirname, '..', '..', 'friends', 'friends.sql'), 'utf8');
const KEY = 'sb_publishable_TESTKEY1234567890abcdef';

const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

async function fakeSupabase(opts = {}) {
  const db = new PGlite();
  await db.exec(`
    create schema auth;
    create table auth.users (id uuid primary key, is_anonymous boolean default true, created_at timestamptz default now());
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create role anon nologin; create role authenticated nologin;
    grant usage on schema public, auth to anon, authenticated;
    alter default privileges in schema public grant all on tables to anon, authenticated;
    alter default privileges in schema public grant all on functions to anon, authenticated;
  `);
  await db.exec(opts.skipSchema ? '' : SQL);

  const w = {
    key: KEY, db, calls: [], signups: 0, refreshes: 0,
    anonDisabled: false, down: 0, ttl: 3600, minted: [], expired: new Set(),
    refreshTokens: new Map(), // токен обновления → uid
    async close() { await new Promise((r) => server.close(r)); await db.close(); },
    /** Все выданные access-токены с этого момента считаются просроченными. */
    expireAccessTokens() { w.expired = new Set(w.minted); },
    /** Все токены обновления отозваны (как при «Sign out everywhere» или удалении пользователя). */
    revokeRefreshTokens() { w.refreshTokens.clear(); },
    async deleteUser(uid) { await db.query('delete from auth.users where id = $1', [uid]); },
  };

  const send = (res, status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(obj == null ? '' : JSON.stringify(obj)); };
  const readBody = (req) => new Promise((resolve) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => resolve(Buffer.concat(c).toString())); });

  const mint = (uid) => {
    const iat = Math.floor(Date.now() / 1000);
    const jti = crypto.randomUUID(); w.minted.push(jti);
    const access = `${b64u({ alg: 'HS256', typ: 'JWT' })}.${b64u({ sub: uid, role: 'authenticated', is_anonymous: true, iat, exp: iat + w.ttl, jti })}.fakesig`;
    const refresh = 'r' + crypto.randomBytes(8).toString('hex');
    w.refreshTokens.set(refresh, uid);
    return { access_token: access, token_type: 'bearer', expires_in: w.ttl, expires_at: iat + w.ttl, refresh_token: refresh, user: { id: uid, is_anonymous: true } };
  };
  const decode = (bearer) => {
    try { return JSON.parse(Buffer.from(bearer.split('.')[1], 'base64url').toString('utf8')); } catch { return null; }
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const raw = await readBody(req);
    let json = {}; try { json = raw ? JSON.parse(raw) : {}; } catch { /* не JSON */ }
    w.calls.push({ method: req.method, path: url.pathname + url.search, apikey: req.headers.apikey, auth: req.headers.authorization, body: json });
    if (w.down > 0) { w.down--; return send(res, 503, { message: 'down' }); }
    if (req.headers.apikey !== KEY) return send(res, 401, { message: 'Invalid API key', hint: 'Double check your Supabase `anon` or `service_role` API key.' });

    // ---- Auth
    if (url.pathname === '/auth/v1/signup') {
      if (w.anonDisabled) return send(res, 422, { code: 422, error_code: 'anonymous_provider_disabled', msg: 'Anonymous sign-ins are disabled' });
      const uid = crypto.randomUUID();
      await db.query('insert into auth.users (id) values ($1)', [uid]);
      w.signups++;
      return send(res, 200, mint(uid));
    }
    if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'refresh_token') {
      const uid = w.refreshTokens.get(json.refresh_token);
      const exists = uid && (await db.query('select 1 from auth.users where id = $1', [uid])).rows.length;
      if (!exists) return send(res, 400, { code: 400, error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token: Refresh Token Not Found' });
      w.refreshTokens.delete(json.refresh_token); // одноразовый
      w.refreshes++;
      return send(res, 200, mint(uid));
    }

    // ---- PostgREST
    const m = url.pathname.match(/^\/rest\/v1\/rpc\/([a-z_]+)$/);
    if (m && req.method === 'POST') {
      const claims = decode((req.headers.authorization || '').replace(/^Bearer /, ''));
      if (!claims || w.expired.has(claims.jti) || claims.exp * 1000 < Date.now()) return send(res, 401, { code: 'PGRST301', message: 'JWT expired' });
      const keys = Object.keys(json).filter((k) => /^[a-z_]+$/.test(k));
      const args = keys.map((k, i) => `${k} => $${i + 1}`).join(', ');
      try {
        const out = await db.transaction(async (tx) => {
          await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [claims.sub]);
          await tx.exec('set local role authenticated');
          return tx.query(`select public.${m[1]}(${args}) as r`, keys.map((k) => json[k]));
        });
        const v = out.rows[0].r;
        return v === null || v === undefined ? send(res, 204, null) : send(res, 200, v);
      } catch (e) {
        const code = e.code || '';
        if (code === '42883') return send(res, 404, { code: 'PGRST202', message: `Could not find the function public.${m[1]} in the schema cache` });
        if (code === '42501') return send(res, 403, { code, message: e.message });
        if (code === 'P0001') return send(res, 400, { code, message: e.message, details: null, hint: null });
        if (code === '23503') return send(res, 409, { code, message: e.message });
        return send(res, 400, { code, message: e.message });
      }
    }
    send(res, 404, { message: 'not found' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  w.url = 'http://127.0.0.1:' + server.address().port;
  return w;
}

async function withSupabase(fn, opts) {
  const w = await fakeSupabase(opts);
  try { return await fn(w); } finally { await w.close(); }
}

module.exports = { fakeSupabase, withSupabase, KEY };
