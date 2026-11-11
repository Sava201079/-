'use strict';
// Аккаунты: вход через Ely.by, authlib-injector, хранение токенов и параметры запуска. Всё — на локальных фейковых серверах.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const mc = require('../src/main/minecraft');
const ely = require('../src/main/elyby');
const authlib = require('../src/main/authlib');
const { createAccountStore } = require('../src/main/accounts');

const tmp = () => fs.mkdtempSync(path.join(process.env.UNLUCKY_TEST_TMP || os.tmpdir(), 'unlucky-auth-'));

const { withWorld, sha256, png64 } = require('./helpers/fake-world');

/** «Шифр» для тестов: читаемые токены в файле сразу выдали бы утечку. */
const fakeCipher = (available = true) => ({
  available: () => available,
  encrypt: (s) => Buffer.from(Buffer.from(s, 'utf8').map((b) => b ^ 0x5a)),
  decrypt: (b) => { if (!Buffer.from(b).length) throw new Error('bad'); return Buffer.from(Buffer.from(b).map((x) => x ^ 0x5a)).toString('utf8'); },
});
// ---------------------------------------------------------------- Ely.by

test('Ely.by: вход, двухфакторная защита, неверный пароль', async () => {
  await withWorld(async (w) => {
    const r = await ely.authenticate('bob', 'pw');
    assert.equal(r.name, 'Bob');
    assert.equal(r.uuid, 'bb0b0b0b0b0b4b0b8b0b0b0b0b0b0b0b');
    assert.match(r.accessToken, /^ELY-/);
    assert.match(r.clientToken, /^[0-9a-f]{32}$/);

    await assert.rejects(ely.authenticate('bob', 'wrong'), /Неверный логин или пароль/);
    await assert.rejects(ely.authenticate('', ''), /логин и пароль/);

    w.ely.twoFactor = true;
    await assert.rejects(ely.authenticate('bob', 'pw'), (e) => e.twoFactor === true && /двухфакторная/.test(e.message));
    const ok = await ely.authenticate('bob', 'pw', { totp: '123 456' }); // пробелы из приложения не мешают
    assert.equal(ok.name, 'Bob');
    await assert.rejects(ely.authenticate('bob', 'pw', { totp: '000000' }), /Неверный логин, пароль или код/);
  });
});

test('Ely.by: токен проверяется, обновляется или требует нового входа', async () => {
  await withWorld(async (w) => {
    const r = await ely.authenticate('bob', 'pw');
    assert.equal(await ely.ensureValid(r), null);

    w.ely.valid.clear();
    const upd = await ely.ensureValid(r);
    assert.notEqual(upd.accessToken, r.accessToken);
    assert.equal(upd.clientToken, r.clientToken);

    w.ely.valid.clear(); w.ely.refreshOk = false;
    await assert.rejects(ely.ensureValid(r), (e) => e.relogin === true);
    await assert.rejects(ely.ensureValid({}), (e) => e.relogin === true);
  });
});

// ---------------------------------------------------------------- authlib-injector

test('authlib-injector: скачивается с проверкой SHA-256, кэшируется, переживает недоступность сервера', async () => {
  await withWorld(async (w) => {
    const dir = path.join(tmp(), 'authlib');
    const jar = await authlib.ensure(dir);
    assert.equal(path.basename(jar), 'authlib-injector.jar');
    assert.equal(sha256(fs.readFileSync(jar)), w.authlib.sha);
    assert.equal(w.authlib.downloads, 1);

    await authlib.ensure(dir); // недавно проверяли — сеть не трогаем
    assert.equal(w.authlib.latestCalls, 1);
    assert.equal(w.authlib.downloads, 1);

    await authlib.ensure(dir, { force: true }); // проверили, версия та же — повторно не качаем
    assert.equal(w.authlib.latestCalls, 2);
    assert.equal(w.authlib.downloads, 1);

    w.authlib.breakLatest = true;
    assert.equal(await authlib.ensure(dir, { force: true }), jar); // сервер лёг — берём из кэша

    // повреждённый кэш скачивается заново
    w.authlib.breakLatest = false;
    fs.writeFileSync(jar, 'мусор');
    await authlib.ensure(dir, { force: true });
    assert.equal(sha256(fs.readFileSync(jar)), w.authlib.sha);
    assert.equal(w.authlib.downloads, 2);
  });
});

test('authlib-injector: неверная контрольная сумма отвергается и файл не остаётся', async () => {
  await withWorld({}, async (w) => {
    w.authlib.badSha = true;
    const dir = path.join(tmp(), 'authlib');
    await assert.rejects(authlib.ensure(dir), /Контрольная сумма/);
    assert.ok(!fs.existsSync(path.join(dir, 'authlib-injector.jar')));
  });
});

// ---------------------------------------------------------------- параметры запуска

function fakePrepared(extra) {
  const json = {
    id: '1.20.1', type: 'release', mainClass: 'net.minecraft.client.main.Main',
    arguments: { jvm: ['-cp', '${classpath}'], game: ['--username', '${auth_player_name}', '--uuid', '${auth_uuid}', '--accessToken', '${auth_access_token}', '--xuid', '${auth_xuid}', '--userType', '${user_type}', '--session', '${auth_session}'] },
  };
  return Object.assign({
    json, classpath: ['/c.jar'], nativesDir: '/n', assetsRoot: '/a', libraryDir: '/l', assetsIndexName: '12', gameAssets: '/a',
    javaExe: 'java', gameDir: '/g', nickname: 'Steve_42', ramMb: 2048, jvmArgs: '', launcherVersion: '1.4.0',
  }, extra);
}
const gameArgs = (c) => c.args.slice(c.args.indexOf('net.minecraft.client.main.Main') + 1);
const argVal = (a, k) => a[a.indexOf(k) + 1];

test('buildCommand: онлайн-аккаунт подставляет ник, UUID, токен и тип пользователя', () => {
  const c = mc.buildCommand(fakePrepared({ auth: { username: 'Alice', uuid: '069a79f444e94726a5befca90e38aaf5', accessToken: 'TOKEN-9', userType: 'mojang' } }));
  const g = gameArgs(c);
  assert.equal(argVal(g, '--username'), 'Alice');
  assert.equal(argVal(g, '--uuid'), '069a79f444e94726a5befca90e38aaf5');
  assert.equal(argVal(g, '--accessToken'), 'TOKEN-9');
  assert.equal(argVal(g, '--xuid'), '0');
  assert.equal(argVal(g, '--userType'), 'mojang');
  assert.equal(argVal(g, '--session'), 'token:TOKEN-9:069a79f444e94726a5befca90e38aaf5');
  assert.ok(!c.args.some((a) => a.startsWith('-javaagent')));
});

test('buildCommand: Ely.by добавляет authlib-injector до главного класса; оффлайн остаётся прежним', () => {
  const c = mc.buildCommand(fakePrepared({
    auth: { username: 'Bob', uuid: 'bb0b0b0b0b0b4b0b8b0b0b0b0b0b0b0b', accessToken: 'ELY-1', userType: 'mojang' },
    javaAgent: { jar: '/data/authlib/authlib-injector.jar', api: 'ely.by' },
  }));
  const i = c.args.indexOf('-javaagent:/data/authlib/authlib-injector.jar=ely.by');
  assert.ok(i >= 0 && i < c.args.indexOf('net.minecraft.client.main.Main'));
  assert.ok(c.args.includes('-Dauthlibinjector.noLogFile'));
  assert.equal(argVal(gameArgs(c), '--userType'), 'mojang');
  assert.equal(argVal(gameArgs(c), '--xuid'), '0');

  const off = gameArgs(mc.buildCommand(fakePrepared()));
  assert.equal(argVal(off, '--username'), 'Steve_42');
  assert.equal(argVal(off, '--uuid'), mc.offlineUuid('Steve_42'));
  assert.equal(argVal(off, '--accessToken'), '0');
  assert.equal(argVal(off, '--userType'), 'legacy');
});

// ---------------------------------------------------------------- хранилище аккаунтов

test('хранилище: оффлайн-аккаунты, проверка ника, миграция и «хотя бы один аккаунт»', () => {
  const dir = tmp();
  const s = createAccountStore({ dir, fallbackName: () => 'Player123' });
  assert.deepEqual(s.list().accounts, []);
  s.ensureOne('Steve_42');
  assert.equal(s.list().accounts.length, 1);
  assert.equal(s.list().accounts[0].name, 'Steve_42');
  assert.equal(s.list().accounts[0].uuid, mc.offlineUuid('Steve_42'));
  assert.equal(s.list().active, s.list().accounts[0].id);

  s.ensureOne('другой'); // уже есть — ничего не меняется
  assert.equal(s.list().accounts.length, 1);

  assert.throws(() => s.addOffline('a'), /3–16/);
  assert.throws(() => s.addOffline('Ник с пробелом'), /3–16/);
  const b = s.addOffline('Alex_7');
  assert.equal(s.list().active, b.id);
  assert.equal(s.addOffline('alex_7').id, b.id, 'тот же ник — тот же аккаунт');
  assert.equal(s.list().accounts.length, 2);
  assert.throws(() => s.renameOffline(b.id, 'steve_42'), /уже есть/);
  assert.equal(s.renameOffline(b.id, 'Alex_8').uuid, mc.offlineUuid('Alex_8'));

  // новый экземпляр читает тот же файл
  const again = createAccountStore({ dir });
  assert.deepEqual(again.list(), s.list());

  s.remove(b.id);
  assert.equal(s.list().accounts.length, 1);
  assert.equal(s.list().active, s.list().accounts[0].id);
  s.remove(s.list().accounts[0].id);
  assert.equal(s.list().accounts.length, 1, 'после удаления последнего создаётся новый оффлайн-аккаунт');
  assert.equal(s.list().accounts[0].type, 'offline');
  assert.throws(() => s.get('nonexistent0'), /не найден/);
});

test('хранилище: токены зашифрованы в файле и не попадают в публичный вид', () => {
  const dir = tmp();
  const s = createAccountStore({ dir, cipher: fakeCipher() });
  s.ensureOne('Steve_42');
  const A = 'aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa', B = 'bb0b0b0b0b0b4b0b8b0b0b0b0b0b0b0b';
  const v = s.upsertOnline('elyby', { name: 'Alice', uuid: A }, { accessToken: 'SECRET-ACCESS', clientToken: 'SECRET-CLIENT-1' });
  const e = s.upsertOnline('elyby', { name: 'Bob', uuid: B }, { accessToken: 'SECRET-ELY', clientToken: 'SECRET-CLIENT-2' });

  const text = fs.readFileSync(s.file, 'utf8');
  for (const secret of ['SECRET-ACCESS', 'SECRET-CLIENT-1', 'SECRET-ELY', 'SECRET-CLIENT-2']) assert.ok(!text.includes(secret), secret + ' лежит в файле открытым текстом');
  assert.ok(!Buffer.from(text).toString('base64').includes(Buffer.from('SECRET-ELY').toString('base64')));
  assert.match(JSON.parse(text).accounts[1].sec, /^s1:/);

  const pub = JSON.stringify(s.list());
  for (const secret of ['SECRET', 'sec"', 's1:']) assert.ok(!pub.includes(secret), 'в публичном виде: ' + secret);
  assert.equal(s.list().active, e.id);
  assert.equal(v.type, 'elyby');
  assert.equal(s.secureStorage, true);
  if (process.platform !== 'win32') assert.equal(fs.statSync(s.file).mode & 0o777, 0o600);

  // тот же игрок входит повторно — аккаунт обновляется, а не дублируется
  s.upsertOnline('elyby', { name: 'AliceNew', uuid: A }, { accessToken: 'SECRET-ACCESS-2', clientToken: 'SECRET-CLIENT-1' });
  assert.equal(s.list().accounts.filter((a) => a.type === 'elyby').length, 2);
  assert.ok(s.list().accounts.some((a) => a.name === 'AliceNew'));
  assert.throws(() => s.upsertOnline('microsoft', { name: 'X', uuid: A }, {}), /Неизвестный тип/);
});

test('хранилище: без шифрования — запасной вариант, а при смене компьютера аккаунт просит войти заново', () => {
  const dir = tmp();
  const plain = createAccountStore({ dir });
  plain.ensureOne('Steve_42');
  plain.upsertOnline('elyby', { name: 'Bob', uuid: 'bb0b0b0b0b0b4b0b8b0b0b0b0b0b0b0b' }, { accessToken: 'T', clientToken: 'C' });
  assert.equal(plain.secureStorage, false);
  assert.match(JSON.parse(fs.readFileSync(plain.file, 'utf8')).accounts[1].sec, /^p1:/);
  assert.equal(plain.list().accounts[1].needsLogin, false);

  // шифрованные данные, перенесённые на другой компьютер: расшифровка не удалась
  const dir2 = tmp();
  const enc = createAccountStore({ dir: dir2, cipher: fakeCipher() });
  enc.ensureOne('Steve_42');
  enc.upsertOnline('elyby', { name: 'Bob', uuid: 'bb0b0b0b0b0b4b0b8b0b0b0b0b0b0b0b' }, { accessToken: 'T', clientToken: 'C' });
  const broken = createAccountStore({ dir: dir2, cipher: { available: () => true, encrypt: () => Buffer.alloc(0), decrypt: () => { throw new Error('другой пользователь'); } } });
  assert.equal(broken.list().accounts[1].needsLogin, true);
  assert.equal(broken.list().accounts[0].needsLogin, false);
});

test('хранилище: испорченный файл не ломает лаунчер', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'accounts.json'), JSON.stringify({ active: 'zzz', accounts: [
    { id: 'not-an-id', type: 'offline', name: 'Bad' }, { id: 'aaaaaaaaaaaa', type: 'hacker', name: 'X' }, { id: 'bbbbbbbbbbbb', type: 'offline', name: 'Good_1' }, null, 5,
  ] }));
  const s = createAccountStore({ dir });
  assert.deepEqual(s.list().accounts.map((a) => a.name), ['Good_1']);
  assert.equal(s.list().active, 'bbbbbbbbbbbb');
  fs.writeFileSync(path.join(dir, 'accounts.json'), '{не json');
  assert.deepEqual(createAccountStore({ dir }).list().accounts, []);
});

test('запуск: оффлайн-аккаунт не требует сети и входа', async () => {
  const s = createAccountStore({ dir: tmp() });
  s.ensureOne('Steve_42');
  const r = await s.prepareLaunch(s.activeId(), {});
  assert.equal(r.online, false);
  assert.equal(r.auth, null);
  assert.equal(r.javaAgent, null);
  assert.equal(r.account.name, 'Steve_42');
});

test('запуск: Ely.by — проверка токена, authlib-injector и параметры агента', async () => {
  await withWorld(async (w) => {
    const dir = tmp();
    const s = createAccountStore({ dir, cipher: fakeCipher() });
    const login = await ely.authenticate('bob', 'pw');
    const v = s.upsertOnline('elyby', { name: login.name, uuid: login.uuid }, { accessToken: login.accessToken, clientToken: login.clientToken });

    const r = await s.prepareLaunch(v.id, { authlibDir: path.join(dir, 'authlib') });
    assert.equal(r.online, true);
    assert.deepEqual(r.auth, { username: 'Bob', uuid: 'bb0b0b0b0b0b4b0b8b0b0b0b0b0b0b0b', accessToken: login.accessToken, userType: 'mojang' });
    assert.equal(r.javaAgent.api, w.base + '/ely-root');
    assert.equal(sha256(fs.readFileSync(r.javaAgent.jar)), w.authlib.sha);

    // токен протух → обновился и сохранился
    w.ely.valid.clear();
    const r2 = await s.prepareLaunch(v.id, { authlibDir: path.join(dir, 'authlib') });
    assert.notEqual(r2.auth.accessToken, login.accessToken);
    w.ely.valid.add(r2.auth.accessToken);
    assert.equal((await s.prepareLaunch(v.id, { authlibDir: path.join(dir, 'authlib') })).auth.accessToken, r2.auth.accessToken);

    // аватар скачивается с сервера скинов Ely.by
    await s.refreshAvatar(v.id);
    assert.ok(fs.existsSync(path.join(dir, 'avatars', v.id + '.png')), 'аватар скачан');
    assert.match(s.get(v.id).avatar, /^data:image\/png;base64,/);

    // сессия отозвана
    w.ely.valid.clear(); w.ely.refreshOk = false;
    await assert.rejects(s.prepareLaunch(v.id, { authlibDir: path.join(dir, 'authlib') }), (e) => e.relogin === true);
    assert.equal(s.get(v.id).needsLogin, true);
    await assert.rejects(s.prepareLaunch(v.id, { authlibDir: path.join(dir, 'authlib') }), /Войдите в аккаунт «Bob» заново/);

    // повторный вход снимает пометку
    s.upsertOnline('elyby', { name: login.name, uuid: login.uuid }, { accessToken: login.accessToken, clientToken: login.clientToken });
    assert.equal(s.get(v.id).needsLogin, false);
  });
});

test('запуск: Ely.by — недоступный сервер не блокирует запуск, а лишь предупреждает', async () => {
  await withWorld(async () => {
    const dir = tmp();
    const s = createAccountStore({ dir, cipher: fakeCipher() });
    const login = await ely.authenticate('bob', 'pw');
    const v = s.upsertOnline('elyby', { name: login.name, uuid: login.uuid }, { accessToken: login.accessToken, clientToken: login.clientToken });
    await authlib.ensure(path.join(dir, 'authlib')); // агент уже скачан раньше

    process.env.UNLUCKY_ELYBY_URL = 'http://127.0.0.1:1/ely'; // сервер Ely.by недоступен
    const logs = [];
    const r = await s.prepareLaunch(v.id, { authlibDir: path.join(dir, 'authlib'), log: (line, tag) => logs.push([tag, line]) });
    assert.equal(r.auth.accessToken, login.accessToken);
    assert.equal(logs.length, 1);
    assert.equal(logs[0][0], 'warn');
    assert.match(logs[0][1], /Не удалось обновить вход в «Bob»/);
    assert.equal(s.get(v.id).needsLogin, false);
  });
});

test('Ely.by: при удалении аккаунта токен аннулируется на сервере', async () => {
  await withWorld(async (w) => {
    const s = createAccountStore({ dir: tmp(), cipher: fakeCipher() });
    s.ensureOne('Steve_42');
    const login = await ely.authenticate('bob', 'pw');
    const v = s.upsertOnline('elyby', { name: login.name, uuid: login.uuid }, { accessToken: login.accessToken, clientToken: login.clientToken });
    s.remove(v.id);
    await s.idle();
    assert.deepEqual(w.ely.invalidated, [login.accessToken]);
    assert.ok(!s.list().accounts.some((a) => a.type === 'elyby'));
  });
});

test('хранилище: записи Microsoft из версии 1.4.0 отбрасываются вместе с токенами и аватарами', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'avatars'));
  fs.writeFileSync(path.join(dir, 'avatars', 'cccccccccccc.png'), 'png');
  fs.writeFileSync(path.join(dir, 'accounts.json'), JSON.stringify({ active: 'cccccccccccc', accounts: [
    { id: 'bbbbbbbbbbbb', type: 'offline', name: 'Good_1' },
    { id: 'cccccccccccc', type: 'microsoft', name: 'Alice', uuid: '069a79f444e94726a5befca90e38aaf5', clientId: 'x', sec: 'p1:' + Buffer.from('{"msRefresh":"SECRET-MS"}').toString('base64') },
  ] }));
  const s = createAccountStore({ dir });
  assert.deepEqual(s.list().accounts.map((a) => a.name), ['Good_1']);
  assert.equal(s.list().active, 'bbbbbbbbbbbb', 'активным становится оставшийся аккаунт');
  const file = fs.readFileSync(path.join(dir, 'accounts.json'), 'utf8');
  assert.ok(!file.includes('microsoft') && !file.includes(Buffer.from('{"msRefresh":"SECRET-MS"}').toString('base64')), 'старые токены стёрты с диска');
  assert.ok(!fs.existsSync(path.join(dir, 'avatars', 'cccccccccccc.png')), 'аватар удалён');
});
