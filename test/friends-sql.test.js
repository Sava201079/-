'use strict';
// Проверка friends/friends.sql на настоящем Postgres (PGlite — Postgres, собранный в WebAssembly).
// Имитируем то, что есть в Supabase: схему auth, функцию auth.uid() и роли anon / authenticated,
// которым Supabase по умолчанию выдаёт права на всё новое в схеме public.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let PGlite = null;
try { ({ PGlite } = require('@electric-sql/pglite')); } catch { /* пакет не установлен: тесты пропустятся */ }
const SQL = fs.readFileSync(path.join(__dirname, '..', 'friends', 'friends.sql'), 'utf8');
const skip = PGlite ? false : 'PGlite не установлен';

const U = { A: crypto.randomUUID(), B: crypto.randomUUID(), C: crypto.randomUUID(), D: crypto.randomUUID() };
const CODE_RE = /^[A-HJ-NP-Z2-9]{8}$/;

async function freshDb() {
  const db = new PGlite();
  await db.exec(`
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create role anon nologin; create role authenticated nologin;
    grant usage on schema public, auth to anon, authenticated;
    alter default privileges in schema public grant all on tables to anon, authenticated;
    alter default privileges in schema public grant all on functions to anon, authenticated;
  `);
  for (const id of Object.values(U)) await db.query('insert into auth.users (id) values ($1)', [id]);
  await db.exec(SQL);
  return db;
}

/** Вызов функции от имени пользователя (null — не вошедший, роль anon). */
function client(db, uid) {
  const role = uid ? 'authenticated' : 'anon';
  const run = async (fn) => {
    await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [uid || '']);
    await db.exec(`set role ${role}`);
    try { return await fn(); } finally { await db.exec('reset role'); }
  };
  const rpc = (name, ...args) => run(async () => {
    const ph = args.map((_, i) => '$' + (i + 1)).join(', ');
    const r = await db.query(`select public.${name}(${ph}) as r`, args);
    return r.rows[0].r;
  });
  return {
    rpc, run,
    sync: (name, o = {}) => rpc('friends_sync', name, o.avatar === undefined ? null : o.avatar, o.playing === undefined ? null : o.playing, !!o.hidden),
    query: (sql, args) => run(() => db.query(sql, args)),
  };
}
const fails = async (p, re) => { await assert.rejects(p, (e) => (re ? re.test(e.message) : true)); };
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const codeFor = (prefix, i) => prefix + ALPHA[(i >> 5) & 31] + ALPHA[i & 31] + 'ABAB';
const pretty = (code) => 'UNL-' + code.slice(0, 4) + '-' + code.slice(4);

test('SQL: скрипт выполняется повторно без ошибок', { skip }, async () => {
  const db = await freshDb();
  await db.exec(SQL);
  await db.exec(SQL);
  await db.close();
});

test('SQL: профиль создаётся, код нужного вида, ник проверяется', { skip }, async () => {
  const db = await freshDb(); const a = client(db, U.A);
  const s = await a.sync('Alice_1', { playing: 'Minecraft 1.20.1' });
  assert.match(s.me.code, CODE_RE);
  assert.equal(s.me.name, 'Alice_1');
  assert.deepEqual([s.friends, s.incoming, s.outgoing], [[], [], []]);
  // повторная синхронизация не меняет код
  assert.equal((await a.sync('Alice_2')).me.code, s.me.code);
  assert.equal((await a.sync('Alice_2')).me.name, 'Alice_2');
  await fails(a.sync('ab'), /Ник/);
  await fails(a.sync('имя с пробелом'), /Ник/);
  await fails(a.sync('Alice_1', { avatar: 'data:image/png;base64,AAA' }), /Аватар/);
  await fails(a.sync('Alice_1', { avatar: 'A'.repeat(2001) }), /Аватар/);
  await db.close();
});

test('SQL: напрямую в таблицы и во внутренние функции ходить нельзя', { skip }, async () => {
  const db = await freshDb(); const a = client(db, U.A); const anon = client(db, null);
  await a.sync('Alice_1');
  for (const who of [a, anon]) {
    await fails(who.query('select * from public.profiles'), /permission denied/);
    await fails(who.query('select * from public.friendships'), /permission denied/);
    await fails(who.query('select * from public.friend_lookups'), /permission denied/);
    await fails(who.query(`insert into public.profiles (id, code, name) values ($1, 'AAAAAAAA', 'Evil_1')`, [U.B]), /permission denied/);
    await fails(who.query('update public.profiles set name = $1', ['Evil_1']), /permission denied/);
    await fails(who.query('delete from public.profiles'), /permission denied/);
    await fails(who.rpc('friends_state', U.A), /permission denied/);
    await fails(who.rpc('friends_gen_code'), /permission denied/);
    await fails(who.rpc('friends_cleanup'), /permission denied/);
  }
  // без входа недоступны и публичные функции
  await fails(anon.sync('Alice_1'), /permission denied/);
  await fails(anon.rpc('friends_request', 'AAAAAAAA'), /permission denied/);
  await db.close();
});

test('SQL: заявка по коду → принятие → друзья видят друг друга', { skip }, async () => {
  const db = await freshDb(); const a = client(db, U.A), b = client(db, U.B);
  const sa = await a.sync('Alice_1', { avatar: 'iVBORw0KGgo=' });
  await b.sync('Bob_2');
  // код можно вводить как угодно: маленькими буквами, с дефисами и пробелами
  const r = await a.rpc('friends_request', ' ' + pretty(await codeOf(b)).toLowerCase().replace(/-/g, ' - ') + ' ');
  assert.equal(r.note, 'sent'); assert.equal(r.target, 'Bob_2');
  assert.equal(r.state.outgoing[0].name, 'Bob_2');
  const sb = await b.sync('Bob_2');
  assert.equal(sb.incoming.length, 1);
  assert.equal(sb.incoming[0].name, 'Alice_1');
  assert.equal(sb.incoming[0].avatar, 'iVBORw0KGgo=');
  assert.equal(sb.friends.length, 0);
  // чужие заявки принять нельзя
  await fails(client(db, U.C).rpc('friends_accept', U.A), /не найдена/);
  const accepted = await b.rpc('friends_accept', U.A);
  assert.equal(accepted.friends[0].name, 'Alice_1');
  assert.deepEqual(accepted.incoming, []);
  const sa2 = await a.sync('Alice_1');
  assert.equal(sa2.friends[0].name, 'Bob_2');
  assert.deepEqual(sa2.outgoing, []);
  assert.equal(sa.me.code.length, 8);
  await db.close();
});
async function codeOf(c) { return (await c.sync('Bob_2')).me.code; }

test('SQL: статус «в сети» и «играет», скрытый режим, выход', { skip }, async () => {
  const db = await freshDb(); const a = client(db, U.A), b = client(db, U.B);
  await a.sync('Alice_1'); await b.sync('Bob_2');
  await a.rpc('friends_request', await codeOf(b));
  await b.rpc('friends_accept', U.A);

  await a.sync('Alice_1', { playing: 'Minecraft 1.20.1 · Fabric' });
  let f = (await b.sync('Bob_2')).friends[0];
  assert.equal(f.online, true); assert.equal(f.playing, 'Minecraft 1.20.1 · Fabric');

  await a.sync('Alice_1', { playing: null });
  f = (await b.sync('Bob_2')).friends[0];
  assert.equal(f.online, true); assert.equal(f.playing, null);

  await a.sync('Alice_1', { playing: 'Minecraft 1.8.9', hidden: true });
  f = (await b.sync('Bob_2')).friends[0];
  assert.equal(f.online, false, 'скрытый игрок выглядит не в сети'); assert.equal(f.playing, null);

  await a.sync('Alice_1', { playing: 'Minecraft 1.8.9' });
  assert.equal((await b.sync('Bob_2')).friends[0].online, true);
  await a.rpc('friends_bye');
  f = (await b.sync('Bob_2')).friends[0];
  assert.equal(f.online, false); assert.equal(f.playing, null);

  // давно не появлялся → не в сети
  await a.sync('Alice_1', { playing: 'x' });
  await db.query(`update public.profiles set last_seen = now() - interval '5 minutes' where id = $1`, [U.A]);
  assert.equal((await b.sync('Bob_2')).friends[0].online, false);

  // служебные символы вырезаются, длина ограничена
  await a.sync('Alice_1', { playing: 'a\u0007b\nc' + 'z'.repeat(100) });
  const p = (await b.sync('Bob_2')).friends[0];
  assert.ok(p.playing.length <= 64 && !/[\u0000-\u001f]/.test(p.playing), p.playing);
  await db.close();
});

test('SQL: встречные заявки сразу делают друзьями', { skip }, async () => {
  const db = await freshDb(); const a = client(db, U.A), b = client(db, U.B);
  const ca = (await a.sync('Alice_1')).me.code, cb = (await b.sync('Bob_2')).me.code;
  await a.rpc('friends_request', cb);
  const r = await b.rpc('friends_request', ca);
  assert.equal(r.note, 'accepted');
  assert.equal(r.state.friends.length, 1);
  assert.equal((await a.sync('Alice_1')).friends[0].name, 'Bob_2');
  // повторная заявка тем, кто уже друг
  assert.equal((await a.rpc('friends_request', cb)).note, 'already');
  await db.close();
});

test('SQL: повторная заявка, отказ и защита от спама', { skip }, async () => {
  const db = await freshDb(); const a = client(db, U.A), b = client(db, U.B);
  const ca = (await a.sync('Alice_1')).me.code, cb = (await b.sync('Bob_2')).me.code;
  assert.equal((await a.rpc('friends_request', cb)).note, 'sent');
  assert.equal((await a.rpc('friends_request', cb)).note, 'already_sent');

  // Боб отклоняет: у Алисы заявка по-прежнему «ожидает», у Боба входящей нет
  const sb = await b.rpc('friends_decline', U.A);
  assert.deepEqual(sb.incoming, []);
  assert.equal((await a.sync('Alice_1')).outgoing.length, 1, 'отправитель не узнаёт об отказе');
  // Алиса не может ни повторить заявку, ни обойти отказ через «отозвать»
  assert.equal((await a.rpc('friends_request', cb)).note, 'sent');
  await a.rpc('friends_remove', U.B);
  assert.equal((await a.rpc('friends_request', cb)).note, 'sent');
  assert.deepEqual((await b.sync('Bob_2')).incoming, [], 'Боб заявок больше не получает');
  assert.equal((await a.sync('Alice_1')).outgoing.length, 1);

  // Боб сам может позвать Алису — тогда её заявка заменяется, и она увидит входящую
  const r = await b.rpc('friends_request', ca);
  assert.equal(r.note, 'sent');
  assert.equal((await a.sync('Alice_1')).incoming[0].name, 'Bob_2');
  assert.equal((await a.rpc('friends_accept', U.B)).friends[0].name, 'Bob_2');
  await db.close();
});

test('SQL: отозвать свою заявку, удалить друга', { skip }, async () => {
  const db = await freshDb(); const a = client(db, U.A), b = client(db, U.B), c = client(db, U.C);
  await a.sync('Alice_1'); const cb = (await b.sync('Bob_2')).me.code; await c.sync('Carol_3');
  await a.rpc('friends_request', cb);
  assert.deepEqual((await a.rpc('friends_remove', U.B)).outgoing, [], 'своя ожидающая заявка отзывается');
  assert.deepEqual((await b.sync('Bob_2')).incoming, []);
  // получатель не может «удалить» чужую ожидающую заявку: для этого есть отказ
  await a.rpc('friends_request', cb);
  assert.equal((await b.rpc('friends_remove', U.A)).incoming.length, 1);
  await b.rpc('friends_accept', U.A);

  // посторонний ничего не может сделать с чужой дружбой
  await c.rpc('friends_remove', U.A); await c.rpc('friends_remove', U.B);
  assert.equal((await a.sync('Alice_1')).friends.length, 1);

  // любой из двоих может удалить, и дружба исчезает у обоих
  const after = await b.rpc('friends_remove', U.A);
  assert.deepEqual(after.friends, []);
  assert.deepEqual((await a.sync('Alice_1')).friends, []);
  // и потом их можно добавить снова
  assert.equal((await a.rpc('friends_request', cb)).note, 'sent');
  await db.close();
});

test('SQL: чужие профили не видны посторонним', { skip }, async () => {
  const db = await freshDb(); const a = client(db, U.A), b = client(db, U.B), c = client(db, U.C);
  await a.sync('Alice_1'); await b.sync('Bob_2'); await c.sync('Carol_3');
  await a.rpc('friends_request', await codeOf(b));
  const s = JSON.stringify(await c.sync('Carol_3'));
  assert.ok(!/Alice_1|Bob_2/.test(s), 'Кэрол не видит чужих заявок');
  // а Алиса, пока Боб не принял, не видит его статус
  assert.deepEqual((await a.sync('Alice_1')).friends, []);
  await db.close();
});

test('SQL: перебор кодов ограничен, отказ запоминается', { skip }, async () => {
  const db = await freshDb(); const a = client(db, U.A), b = client(db, U.B);
  await a.sync('Alice_1'); const cb = (await b.sync('Bob_2')).me.code;
  for (let i = 0; i < 10; i++) {
    const r = await a.rpc('friends_request', 'AAAAAAA' + 'BCDEFGHJKL'[i]);
    assert.match(r.error, /Такого кода нет/, 'попытка ' + (i + 1));
  }
  // счётчик действительно записан (а не откатился вместе с ответом)
  assert.equal(Number((await db.query('select count(*) from public.friend_lookups')).rows[0].count), 10);
  const blocked = await a.rpc('friends_request', cb);
  assert.match(blocked.error, /Слишком много/);
  assert.equal((await b.sync('Bob_2')).incoming.length, 0);
  // через час можно снова
  await db.query(`update public.friend_lookups set at = now() - interval '2 hours'`);
  assert.equal((await a.rpc('friends_request', cb)).note, 'sent');
  await db.close();
});

test('SQL: неверный формат кода и собственный код', { skip }, async () => {
  const db = await freshDb(); const a = client(db, U.A);
  const me = (await a.sync('Alice_1')).me.code;
  assert.match((await a.rpc('friends_request', 'abc')).error, /UNL-/);
  assert.match((await a.rpc('friends_request', '')).error, /UNL-/);
  assert.match((await a.rpc('friends_request', '0000 0000')).error, /UNL-/);
  assert.match((await a.rpc('friends_request', me)).error, /собственный/);
  assert.match((await a.rpc('friends_request', 'UNL-' + me.slice(0, 4) + '-' + me.slice(4))).error, /собственный/);
  assert.equal(Number((await db.query('select count(*) from public.friend_lookups')).rows[0].count), 0, 'неверный формат попыткой не считается');
  // без профиля заявку отправить нельзя
  await fails(client(db, U.B).rpc('friends_request', me), /подключите/);
  await db.close();
});

test('SQL: новый код: старый перестаёт работать, друзья остаются', { skip }, async () => {
  const db = await freshDb(); const a = client(db, U.A), b = client(db, U.B), c = client(db, U.C);
  const old = (await a.sync('Alice_1')).me.code; await b.sync('Bob_2'); await c.sync('Carol_3');
  await b.rpc('friends_request', old); await a.rpc('friends_accept', U.B);
  const s = await a.rpc('friends_new_code');
  assert.match(s.me.code, CODE_RE); assert.notEqual(s.me.code, old);
  assert.equal(s.friends.length, 1);
  assert.match((await c.rpc('friends_request', old)).error, /Такого кода нет/);
  assert.equal((await c.rpc('friends_request', s.me.code)).note, 'sent');
  await fails(client(db, U.D).rpc('friends_new_code'), /подключите/);
  await db.close();
});

test('SQL: удаление данных убирает профиль и все связи', { skip }, async () => {
  const db = await freshDb(); const a = client(db, U.A), b = client(db, U.B), c = client(db, U.C);
  await a.sync('Alice_1'); const cb = (await b.sync('Bob_2')).me.code; const cc = (await c.sync('Carol_3')).me.code;
  await a.rpc('friends_request', cb); await b.rpc('friends_accept', U.A);
  await a.rpc('friends_request', cc);
  await a.rpc('friends_delete_me');
  assert.equal(Number((await db.query('select count(*) from public.profiles where id = $1', [U.A])).rows[0].count), 0);
  assert.equal(Number((await db.query('select count(*) from public.friendships')).rows[0].count), 0);
  assert.deepEqual((await b.sync('Bob_2')).friends, []);
  assert.deepEqual((await c.sync('Carol_3')).incoming, []);
  await db.close();
});

test('SQL: пределы на число друзей и входящих заявок', { skip }, async () => {
  const db = await freshDb(); const a = client(db, U.A), b = client(db, U.B);
  await a.sync('Alice_1'); const cb = (await b.sync('Bob_2')).me.code;

  // у Боба уже 50 ожидающих заявок
  for (let i = 0; i < 50; i++) {
    const id = crypto.randomUUID();
    await db.query('insert into auth.users (id) values ($1)', [id]);
    await db.query('insert into public.profiles (id, code, name) values ($1, $2, $3)', [id, codeFor('BB', i), 'Spam_' + i]);
    await db.query('insert into public.friendships (requester, addressee) values ($1, $2)', [id, U.B]);
  }
  assert.match((await a.rpc('friends_request', cb)).error, /слишком много заявок/);

  // у Алисы уже 200 друзей
  await db.query('delete from public.friendships');
  for (let i = 0; i < 200; i++) {
    const id = crypto.randomUUID();
    await db.query('insert into auth.users (id) values ($1)', [id]);
    await db.query('insert into public.profiles (id, code, name) values ($1, $2, $3)', [id, codeFor('CC', i), 'Pal_' + i]);
    await db.query(`insert into public.friendships (requester, addressee, status) values ($1, $2, 'accepted')`, [U.A, id]);
  }
  assert.match((await a.rpc('friends_request', cb)).error, /заполнен/);
  await db.close();
});

test('SQL: уборка старых профилей', { skip }, async () => {
  const db = await freshDb(); const a = client(db, U.A), b = client(db, U.B);
  await a.sync('Alice_1'); await b.sync('Bob_2');
  await db.query(`update public.profiles set last_seen = now() - interval '200 days' where id = $1`, [U.A]);
  assert.equal((await db.query('select public.friends_cleanup() as n')).rows[0].n, 1);
  await db.close();
});
