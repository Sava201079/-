'use strict';
// Друзья: клиент лаунчера (src/main/friends.js) против «Supabase» на настоящем Postgres с настоящим friends.sql.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PNG } = require('pngjs');

let withSupabase = null, KEY = '';
try { ({ withSupabase, KEY } = require('./helpers/fake-supabase')); } catch { /* нет PGlite */ }
const skip = withSupabase ? false : 'PGlite не установлен';
const { createFriends, parseConfig, safeAvatarB64, serverName, cleanState, prettyCode } = require('../src/main/friends');

const tmp = () => fs.mkdtempSync(path.join(process.env.UNLUCKY_TEST_TMP || os.tmpdir(), 'unlucky-friends-'));
const fakeCipher = () => ({
  available: () => true,
  encrypt: (s) => Buffer.from(Buffer.from(s, 'utf8').map((b) => b ^ 0x5a)),
  decrypt: (b) => Buffer.from(Buffer.from(b).map((x) => x ^ 0x5a)).toString('utf8'),
});
const png8 = (shade = 120) => { const p = new PNG({ width: 8, height: 8 }); p.data.fill(shade); return PNG.sync.write(p).toString('base64'); };

/** Один «установленный лаунчер». */
function launcher(w, name, { dir = tmp(), key = KEY, url } = {}) {
  const profile = { name, avatar: png8(), playing: null, hidden: false };
  const changes = [];
  const f = createFriends({
    dir, cipher: fakeCipher(), intervalMs: 60000,
    getConfig: () => ({ url: url || w.url, key }),
    getProfile: () => profile,
    onChange: (v) => changes.push(v),
  });
  return { f, profile, dir, changes };
}
const online = async (l) => { l.f.start(); await l.f.syncNow(); return l; };

// ---------------------------------------------------------------- настройки

test('настройки: адрес и ключ проверяются, секретные ключи отвергаются', () => {
  assert.equal(parseConfig('', ''), null);
  assert.deepEqual(parseConfig('  https://abcd.supabase.co/rest/v1/  ', KEY), { url: 'https://abcd.supabase.co', key: KEY });
  assert.equal(parseConfig('abcd.supabase.co', KEY).url, 'https://abcd.supabase.co');
  assert.equal(parseConfig('http://127.0.0.1:5000', KEY).url, 'http://127.0.0.1:5000');
  assert.throws(() => parseConfig('http://example.com', KEY), /https/);
  assert.throws(() => parseConfig('https://u:p@abcd.supabase.co', KEY), /логина/);
  assert.throws(() => parseConfig('https://abcd.supabase.co', ''), /ключ/);
  assert.throws(() => parseConfig('', KEY), /адрес/);
  assert.throws(() => parseConfig('https://abcd.supabase.co', 'короткий ключ'), /неправильно/);
  assert.throws(() => parseConfig('https://abcd.supabase.co', 'sb_secret_' + 'a'.repeat(30)), /секретный/);
  const jwt = (role) => 'eyJhbGciOiJIUzI1NiJ9.' + Buffer.from(JSON.stringify({ role })).toString('base64url') + '.c2lnbmF0dXJlc2lnbmF0dXJl';
  assert.throws(() => parseConfig('https://abcd.supabase.co', jwt('service_role')), /секретный/);
  assert.equal(parseConfig('https://abcd.supabase.co', jwt('anon')).key, jwt('anon'));
});

test('вспомогательное: имя для сервера, коды, аватар', () => {
  assert.equal(serverName('Alex_7'), 'Alex_7');
  assert.equal(serverName('Имя'), '___');
  assert.equal(serverName('ab'), 'ab_');
  assert.equal(serverName('a b'), 'a_b');
  assert.equal(serverName('x'.repeat(40)).length, 16);
  assert.equal(prettyCode('K7M29QX4'), 'UNL-K7M2-9QX4');
  assert.equal(prettyCode('bad'), '');
  assert.ok(safeAvatarB64(png8()));
  assert.equal(safeAvatarB64('QUJD'), '', 'не PNG');
  assert.equal(safeAvatarB64('data:image/png;base64,' + png8()), '');
  assert.equal(safeAvatarB64('A'.repeat(2500)), '');
  const big = new PNG({ width: 128, height: 8 }); big.data.fill(1);
  assert.equal(safeAvatarB64(PNG.sync.write(big).toString('base64')), '', 'слишком большая картинка');
});

test('данные с сервера недоверенные: имена, аватары и статусы проверяются', () => {
  const id = '11111111-2222-4333-8444-555555555555';
  const s = cleanState({
    me: { code: 'K7M29QX4', name: 'Me_1' },
    friends: [
      { id, name: 'Good_1', avatar: png8(), online: true, playing: 'Игра\u0007\n' + 'я'.repeat(100) },
      { id, name: '<img src=x onerror=alert(1)>', avatar: png8(), online: true },
      { id: 'не-uuid', name: 'Bad_id', online: true },
      { id: '22222222-2222-4333-8444-555555555555', name: 'Evil_1', avatar: '"><script>alert(1)</script>', online: 'yes', playing: 'тайно' },
      null, 5, 'x',
    ],
    incoming: 'не список', outgoing: [{ id, name: 'Out_1', avatar: 'QUJD' }],
  });
  assert.equal(s.me.pretty, 'UNL-K7M2-9QX4');
  assert.equal(s.friends.length, 2);
  assert.match(s.friends[0].avatar, /^data:image\/png;base64,[A-Za-z0-9+/=]+$/);
  assert.ok(s.friends[0].playing.length <= 64 && !/[\u0000-\u001f]/.test(s.friends[0].playing));
  assert.equal(s.friends[1].avatar, '');
  assert.equal(s.friends[1].online, false, 'online только при настоящем true');
  assert.equal(s.friends[1].playing, '', 'не в сети — статуса нет');
  assert.deepEqual(s.incoming, []);
  assert.equal(s.outgoing[0].avatar, '');
  assert.equal(cleanState({ me: { code: 'bad' } }).me, null);
  assert.equal(cleanState({ friends: Array.from({ length: 500 }, (_, i) => ({ id, name: 'Pal_' + i })) }).friends.length, 250);
});

// ---------------------------------------------------------------- вход и сессия

test('первый запуск: анонимный вход, код друга, сессия хранится зашифрованной', { skip }, async () => {
  await withSupabase(async (w) => {
    const a = await online(launcher(w, 'Alice_1'));
    const v = a.f.view();
    assert.equal(v.status, 'ok'); assert.equal(v.configured, true);
    assert.match(v.me.pretty, /^UNL-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    assert.equal(w.signups, 1);
    const sync = w.calls.find((c) => c.path.endsWith('friends_sync'));
    assert.equal(sync.body.p_name, 'Alice_1');
    assert.ok(sync.body.p_avatar, 'аватар отправлен в первый раз');
    // в файле нет токенов открытым текстом, права 0600
    const file = fs.readFileSync(path.join(a.dir, 'friends.json'), 'utf8');
    assert.ok(!/eyJ|"access_token"|"refresh"/.test(file) && !file.includes(w.calls.find((c) => c.path.includes('friends_sync')).auth.slice(7, 40)), 'токены не лежат открыто');
    assert.equal(fs.statSync(path.join(a.dir, 'friends.json')).mode & 0o777, 0o600);
    a.f.stop();
  });
});

test('вход переживает перезапуск, лишних регистраций нет', { skip }, async () => {
  await withSupabase(async (w) => {
    const a = await online(launcher(w, 'Alice_1'));
    const code = a.f.view().me.code; a.f.stop();
    const again = await online(launcher(w, 'Alice_1', { dir: a.dir }));
    assert.equal(again.f.view().me.code, code);
    assert.equal(w.signups, 1);
    // аватар второй раз без изменений не отправляется... но после перезапуска — отправится один раз (сервер мог его потерять)
    again.f.stop();
  });
});

test('просроченный токен доступа обновляется незаметно', { skip }, async () => {
  await withSupabase(async (w) => {
    const a = await online(launcher(w, 'Alice_1'));
    const code = a.f.view().me.code;
    w.expireAccessTokens();
    await a.f.syncNow();
    assert.equal(a.f.view().status, 'ok');
    assert.equal(a.f.view().me.code, code, 'тот же игрок');
    assert.equal(w.refreshes, 1); assert.equal(w.signups, 1);
    assert.equal(a.f.view().renewals, 0);
    a.f.stop();
  });
});

test('токен доступа с истёкшим сроком (по часам) обновляется до запроса', { skip }, async () => {
  await withSupabase(async (w) => {
    w.ttl = 30; // короче минуты: клиент считает такой токен просроченным сразу
    const a = await online(launcher(w, 'Alice_1'));
    await a.f.syncNow(); await a.f.syncNow();
    assert.ok(w.refreshes >= 2, 'обновлений: ' + w.refreshes);
    assert.equal(w.signups, 1);
    a.f.stop();
  });
});

test('вход отозван на сервере: новый идентификатор и сообщение для интерфейса', { skip }, async () => {
  await withSupabase(async (w) => {
    const a = await online(launcher(w, 'Alice_1'));
    const old = a.f.view().me.code;
    w.expireAccessTokens(); w.revokeRefreshTokens();
    await a.f.syncNow();
    assert.equal(a.f.view().status, 'ok');
    assert.notEqual(a.f.view().me.code, old, 'это уже другой профиль');
    assert.equal(a.f.view().renewals, 1);
    assert.equal(w.signups, 2);
    a.f.stop();
  });
});

test('пользователя удалили на сервере: клиент входит заново', { skip }, async () => {
  await withSupabase(async (w) => {
    const a = await online(launcher(w, 'Alice_1'));
    const uid = (await w.db.query('select id from public.profiles')).rows[0].id;
    await w.deleteUser(uid);
    await a.f.syncNow();
    assert.equal(a.f.view().status, 'ok');
    assert.equal(a.f.view().renewals, 1);
    assert.equal(w.signups, 2);
    a.f.stop();
  });
});

// ---------------------------------------------------------------- ошибки

test('ошибки сервера объясняются по-русски и подсказывают, что делать', { skip }, async () => {
  await withSupabase(async (w) => {
    w.anonDisabled = true;
    const a = launcher(w, 'Alice_1'); a.f.start();
    await assert.rejects(a.f.syncNow(), /анонимный вход/);
    assert.equal(a.f.view().status, 'error'); assert.match(a.f.view().error, /Allow anonymous/);
    a.f.stop();

    const wrong = launcher(w, 'Alice_1', { key: 'sb_publishable_WRONGWRONGWRONGWRONG' }); wrong.f.start();
    await assert.rejects(wrong.f.syncNow(), /не принял ключ/);
    wrong.f.stop();
  });
  await withSupabase(async (w) => {
    const a = launcher(w, 'Alice_1'); a.f.start();
    await assert.rejects(a.f.syncNow(), /friends\.sql/);
    a.f.stop();
  }, { skipSchema: true });
  // сервера нет вообще
  const dead = launcher({ url: 'http://127.0.0.1:1' }, 'Alice_1'); dead.f.start();
  await assert.rejects(dead.f.syncNow(), /127\.0\.0\.1/);
  assert.equal(dead.f.view().status, 'error');
  dead.f.stop();
});

test('сервер временно недоступен: ошибка, потом сам восстанавливается', { skip }, async () => {
  await withSupabase(async (w) => {
    const a = await online(launcher(w, 'Alice_1'));
    w.down = 1;
    await assert.rejects(a.f.syncNow(), /недоступен/);
    assert.equal(a.f.view().status, 'error');
    assert.equal(a.f.view().me.name, 'Alice_1', 'прежние данные остаются на экране');
    await a.f.syncNow();
    assert.equal(a.f.view().status, 'ok'); assert.equal(a.f.view().error, '');
    a.f.stop();
  });
});

// ---------------------------------------------------------------- друзья

test('двое друзей: код → заявка → принятие → статус, «играет», аватар', { skip }, async () => {
  await withSupabase(async (w) => {
    const a = await online(launcher(w, 'Alice_1')), b = await online(launcher(w, 'Bob_2'));
    assert.notEqual(a.f.view().me.code, b.f.view().me.code);

    // ввод кода как попало: строчные, пробелы, дефисы
    const r = await a.f.request(' ' + b.f.view().me.pretty.toLowerCase().replace(/-/g, ' ') + ' ');
    assert.deepEqual(r, { note: 'sent', target: 'Bob_2' });
    assert.equal(a.f.view().outgoing[0].name, 'Bob_2');

    await b.f.syncNow();
    assert.equal(b.f.view().incoming.length, 1);
    assert.equal(b.f.view().incoming[0].name, 'Alice_1');
    assert.match(b.f.view().incoming[0].avatar, /^data:image\/png;base64,/);
    assert.equal(b.f.view().friends.length, 0);

    await b.f.accept(b.f.view().incoming[0].id);
    assert.equal(b.f.view().friends[0].name, 'Alice_1');
    await a.f.syncNow();
    assert.equal(a.f.view().friends[0].name, 'Bob_2');
    assert.equal(a.f.view().outgoing.length, 0);

    // статус
    a.profile.playing = 'Minecraft 1.20.1 · Fabric';
    await a.f.syncNow(); await b.f.syncNow();
    assert.equal(b.f.view().friends[0].online, true);
    assert.equal(b.f.view().friends[0].playing, 'Minecraft 1.20.1 · Fabric');
    a.profile.hidden = true;
    await a.f.syncNow(); await b.f.syncNow();
    assert.equal(b.f.view().friends[0].online, false);
    assert.equal(b.f.view().friends[0].playing, '');
    a.profile.hidden = false; a.profile.playing = null;
    await a.f.syncNow(); await b.f.syncNow();
    assert.equal(b.f.view().friends[0].online, true);

    // смена ника доходит до друга
    a.profile.name = 'Alice_Two';
    await a.f.syncNow(); await b.f.syncNow();
    assert.equal(b.f.view().friends[0].name, 'Alice_Two');

    // аватар отправляется только когда изменился
    const sent = () => w.calls.filter((c) => c.path.endsWith('friends_sync') && c.body.p_avatar).length;
    const before = sent();
    await a.f.syncNow(); await a.f.syncNow();
    assert.equal(sent(), before, 'тот же аватар повторно не отправляется');
    a.profile.avatar = png8(200);
    await a.f.syncNow();
    assert.equal(sent(), before + 1);

    // удаление
    await b.f.remove(b.f.view().friends[0].id);
    assert.equal(b.f.view().friends.length, 0);
    await a.f.syncNow();
    assert.equal(a.f.view().friends.length, 0);
    a.f.stop(); b.f.stop();
  });
});

test('ошибки при добавлении понятны, чужие коды перебирать нельзя', { skip }, async () => {
  await withSupabase(async (w) => {
    const a = await online(launcher(w, 'Alice_1'));
    await assert.rejects(a.f.request('abc'), /UNL-/);
    await assert.rejects(a.f.request(a.f.view().me.code), /собственный/);
    await assert.rejects(a.f.request('AAAAAAAA'), /Такого кода нет/);
    for (let i = 0; i < 9; i++) await assert.rejects(a.f.request('AAAAAAA' + 'BCDEFGHJK'[i]), /Такого кода нет/);
    const b = await online(launcher(w, 'Bob_2'));
    await assert.rejects(a.f.request(b.f.view().me.code), /Слишком много/);
    await assert.rejects(a.f.accept('не-идентификатор'), /не найден/);
    await assert.rejects(a.f.accept('11111111-2222-4333-8444-555555555555'), /не найдена/);
    a.f.stop(); b.f.stop();
  });
});

test('встречные заявки и отказ', { skip }, async () => {
  await withSupabase(async (w) => {
    const a = await online(launcher(w, 'Alice_1')), b = await online(launcher(w, 'Bob_2')), c = await online(launcher(w, 'Carol_3'));
    await a.f.request(b.f.view().me.code);
    const r = await b.f.request(a.f.view().me.code);
    assert.equal(r.note, 'accepted');
    assert.equal(b.f.view().friends[0].name, 'Alice_1');

    await a.f.request(c.f.view().me.code);
    await c.f.syncNow();
    await c.f.decline(c.f.view().incoming[0].id);
    assert.equal(c.f.view().incoming.length, 0);
    await a.f.syncNow();
    assert.equal(a.f.view().outgoing.length, 1, 'отправитель отказа не видит');
    a.f.stop(); b.f.stop(); c.f.stop();
  });
});

test('новый код: старый перестаёт работать', { skip }, async () => {
  await withSupabase(async (w) => {
    const a = await online(launcher(w, 'Alice_1')), b = await online(launcher(w, 'Bob_2'));
    const old = a.f.view().me.code;
    const v = await a.f.newCode();
    assert.notEqual(v.me.code, old);
    await assert.rejects(b.f.request(old), /Такого кода нет/);
    assert.equal((await b.f.request(v.me.code)).note, 'sent');
    a.f.stop(); b.f.stop();
  });
});

test('закрытие лаунчера: друг сразу видит «не в сети»', { skip }, async () => {
  await withSupabase(async (w) => {
    const a = await online(launcher(w, 'Alice_1')), b = await online(launcher(w, 'Bob_2'));
    await a.f.request(b.f.view().me.code); await b.f.syncNow(); await b.f.accept(b.f.view().incoming[0].id);
    a.profile.playing = 'Minecraft 1.8.9'; await a.f.syncNow(); await b.f.syncNow();
    assert.equal(b.f.view().friends[0].online, true);
    await a.f.bye();
    await b.f.syncNow();
    assert.equal(b.f.view().friends[0].online, false);
    // bye не бросает ошибок, даже если сервер не отвечает
    w.down = 5;
    await b.f.bye(300);
    b.f.stop();
  });
});

test('удаление данных: профиль и вход исчезают и на сервере, и в лаунчере', { skip }, async () => {
  await withSupabase(async (w) => {
    const a = await online(launcher(w, 'Alice_1')), b = await online(launcher(w, 'Bob_2'));
    await a.f.request(b.f.view().me.code); await b.f.syncNow(); await b.f.accept(b.f.view().incoming[0].id);
    await a.f.deleteMe();
    assert.equal(Number((await w.db.query('select count(*) from public.profiles')).rows[0].count), 1);
    assert.equal(fs.existsSync(path.join(a.dir, 'friends.json')), false);
    assert.equal(a.f.view().me, null); assert.equal(a.f.view().status, 'off');
    await b.f.syncNow();
    assert.equal(b.f.view().friends.length, 0);
    // включить снова — это уже новый профиль
    await online(a);
    assert.equal(w.signups, 3);
    a.f.stop(); b.f.stop();
  });
});

test('смена проекта: старая сессия не отправляется на чужой сервер', { skip }, async () => {
  await withSupabase(async (w1) => {
    await withSupabase(async (w2) => {
      const dir = tmp();
      const a = await online(launcher(w1, 'Alice_1', { dir }));
      const token = w1.calls.find((c) => c.path.endsWith('friends_sync')).auth;
      a.f.stop();
      const moved = await online(launcher(w2, 'Alice_1', { dir }));
      assert.ok(!w2.calls.some((c) => c.auth === token), 'токен первого проекта второму не отдан');
      assert.equal(w2.signups, 1);
      moved.f.stop();
    });
  });
});

test('друзья не настроены: ничего не отправляется', { skip }, async () => {
  const f = createFriends({ dir: tmp(), cipher: fakeCipher(), getConfig: () => ({ url: '', key: '' }), getProfile: () => ({ name: 'Alice_1' }) });
  f.start();
  assert.equal(f.view().configured, false); assert.equal(f.view().status, 'off');
  await assert.rejects(f.request('K7M29QX4'), /выключены/);
  const bad = createFriends({ dir: tmp(), cipher: fakeCipher(), getConfig: () => ({ url: 'ftp://x', key: KEY || 'k'.repeat(30) }), getProfile: () => ({ name: 'Alice_1' }) });
  bad.start();
  assert.equal(bad.view().configured, false); assert.match(bad.view().configError, /https/);
});

test('вшитый в сборку адрес и ключ (friends.config.json) корректны и ключ не секретный', () => {
  const cfg = require('../src/main/friends.config.json');
  const parsed = parseConfig(cfg.url, cfg.key); // бросит ошибку, если адрес кривой или ключ секретный
  if (parsed) {
    assert.equal(parsed.url, cfg.url, 'адрес записан в нормальном виде (без пути)');
    assert.match(parsed.url, /^https:\/\/[a-z0-9-]+\.supabase\.co$/);
    assert.match(parsed.key, /^(sb_publishable_|eyJ)/);
  }
});
