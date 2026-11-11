'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const mc = require('../src/main/minecraft');
const dl = require('../src/main/download');

const tmp = () => fs.mkdtempSync(path.join(process.env.UNLUCKY_TEST_TMP || os.tmpdir(), 'unlucky-'));
const here = { win32: 'windows', darwin: 'osx', linux: 'linux' }[process.platform];
const other = here === 'windows' ? 'linux' : 'windows';

test('rulesAllow: ОС, фичи и порядок правил', () => {
  assert.equal(mc.rulesAllow(undefined), true);
  assert.equal(mc.rulesAllow([{ action: 'allow' }]), true);
  assert.equal(mc.rulesAllow([{ action: 'allow', os: { name: other } }]), false);
  assert.equal(mc.rulesAllow([{ action: 'allow', os: { name: here } }]), true);
  assert.equal(mc.rulesAllow([{ action: 'allow' }, { action: 'disallow', os: { name: here } }]), false);
  assert.equal(mc.rulesAllow([{ action: 'allow', features: { is_demo_user: true } }], {}), false);
  assert.equal(mc.rulesAllow([{ action: 'allow', features: { is_demo_user: true } }], { is_demo_user: true }), true);
  assert.equal(mc.rulesAllow([{ action: 'allow', os: { name: here, arch: 'x86' } }]), process.arch === 'ia32');
});

test('оффлайн-UUID совпадает с Java UUID.nameUUIDFromBytes', () => {
  assert.equal(mc.offlineUuid('Notch'), 'b50ad385829d3141a2167e7d7539ba7f');
  assert.match(mc.offlineUuid('Steve_42'), /^[0-9a-f]{12}3[0-9a-f]{3}[89ab][0-9a-f]{15}$/);
});

test('splitArgs понимает кавычки', () => {
  assert.deepEqual(mc.splitArgs('-Xss1M "-Dfoo=bar baz" -XX:+UseG1GC'), ['-Xss1M', '-Dfoo=bar baz', '-XX:+UseG1GC']);
  assert.deepEqual(mc.splitArgs(''), []);
});

test('mavenPath', () => {
  assert.equal(mc.mavenPath('org.lwjgl.lwjgl:lwjgl:2.9.4'), 'org/lwjgl/lwjgl/lwjgl/2.9.4/lwjgl-2.9.4.jar');
  assert.equal(mc.mavenPath('a.b:c:1.0:natives-windows'), 'a/b/c/1.0/c-1.0-natives-windows.jar');
  assert.equal(mc.mavenPath('a.b:c:1.0@zip'), 'a/b/c/1.0/c-1.0.zip');
});

test('planLibraries: правила, нативы старого формата, класспат', () => {
  const root = tmp();
  const json = {
    libraries: [
      { name: 'a:plain:1', downloads: { artifact: { path: 'a/plain/1/plain-1.jar', url: 'http://x/plain', sha1: 'a', size: 1 } } },
      { name: 'a:other-os:1', rules: [{ action: 'allow', os: { name: other } }], downloads: { artifact: { path: 'a/o/1/o-1.jar', url: 'http://x/o', size: 1 } } },
      {
        name: 'a:nat:1', natives: { [here]: 'natives-' + here }, extract: { exclude: ['META-INF/'] },
        downloads: {
          artifact: { path: 'a/nat/1/nat-1.jar', url: 'http://x/nat', size: 1 },
          classifiers: { ['natives-' + here]: { path: 'a/nat/1/nat-1-natives.jar', url: 'http://x/nat-n', size: 1 } },
        },
      },
      { name: 'old.style:lib:2.0' }, // без downloads — берём с libraries.minecraft.net
    ],
  };
  const r = mc.planLibraries(json, root);
  assert.equal(r.cp.length, 3);
  assert.equal(r.natives.length, 1);
  assert.deepEqual(r.natives[0].exclude, ['META-INF/']);
  assert.ok(r.tasks.some(t => t.url === 'https://libraries.minecraft.net/old/style/lib/2.0/lib-2.0.jar'));
  assert.ok(!r.tasks.some(t => t.url === 'http://x/o'));
});

function fakePrepared(json, extra) {
  return Object.assign({
    json, classpath: ['/l/a.jar', '/l/b.jar', '/v/client.jar'], nativesDir: '/v/natives', assetsRoot: '/assets', libraryDir: '/libs',
    assetsIndexName: '12', gameAssets: '/assets', loggingArg: '-Dlog4j.configurationFile=/assets/log.xml',
    javaExe: 'java', gameDir: '/game', nickname: 'Steve_42', ramMb: 3072, jvmArgs: '-Dfoo=1', launcherVersion: '1.0.0',
  }, extra);
}

test('buildCommand: современный формат (arguments)', () => {
  const json = {
    id: '1.20.1', type: 'release', mainClass: 'net.minecraft.client.main.Main',
    arguments: {
      jvm: [
        { rules: [{ action: 'allow', os: { name: 'osx' } }], value: ['-XstartOnFirstThread'] },
        { rules: [{ action: 'allow', os: { name: 'windows' } }], value: '-XX:HeapDumpPath=dump' },
        '-Djava.library.path=${natives_directory}', '-Dminecraft.launcher.brand=${launcher_name}', '-cp', '${classpath}',
      ],
      game: [
        '--username', '${auth_player_name}', '--version', '${version_name}', '--gameDir', '${game_directory}',
        '--assetsDir', '${assets_root}', '--assetIndex', '${assets_index_name}', '--uuid', '${auth_uuid}',
        '--accessToken', '${auth_access_token}', '--clientId', '${clientid}', '--xuid', '${auth_xuid}', '--userType', '${user_type}',
        '--versionType', '${version_type}',
        { rules: [{ action: 'allow', features: { is_demo_user: true } }], value: '--demo' },
        { rules: [{ action: 'allow', features: { has_custom_resolution: true } }], value: ['--width', '${resolution_width}'] },
      ],
    },
  };
  const c = mc.buildCommand(fakePrepared(json));
  const a = c.args;
  assert.equal(c.command, 'java');
  assert.equal(c.cwd, '/game');
  assert.ok(a.includes('-Xmx3072M') && a.includes('-Xms512M'));
  assert.ok(a.includes('-Dfoo=1'));
  assert.ok(a.includes('-Djava.library.path=/v/natives'));
  assert.ok(a.indexOf('-Dlog4j.configurationFile=/assets/log.xml') < a.indexOf(json.mainClass));
  const sep = process.platform === 'win32' ? ';' : ':';
  assert.equal(a[a.indexOf('-cp') + 1], ['/l/a.jar', '/l/b.jar', '/v/client.jar'].join(sep));
  const main = a.indexOf(json.mainClass);
  assert.ok(main > a.indexOf('-cp'));
  const game = a.slice(main + 1);
  const val = (k) => game[game.indexOf(k) + 1];
  assert.equal(val('--username'), 'Steve_42');
  assert.equal(val('--version'), '1.20.1');
  assert.equal(val('--uuid'), mc.offlineUuid('Steve_42'));
  assert.equal(val('--assetIndex'), '12');
  assert.equal(val('--xuid'), '0');
  assert.ok(!game.includes('--demo'));
  assert.ok(!game.includes('--width'));
  assert.ok(!a.some(x => /\$\{/.test(x)), 'не должно остаться нераскрытых плейсхолдеров: ' + a.filter(x => /\$\{/.test(x)));
  assert.equal(a.includes('-XstartOnFirstThread'), process.platform === 'darwin');
});

test('buildCommand: старый формат (minecraftArguments)', () => {
  const json = {
    id: '1.7.10', type: 'release', mainClass: 'net.minecraft.client.main.Main',
    minecraftArguments: '--username ${auth_player_name} --version ${version_name} --gameDir ${game_directory} --assetsDir ${game_assets} --uuid ${auth_uuid} --accessToken ${auth_access_token} --userProperties ${user_properties} --userType ${user_type}',
  };
  const c = mc.buildCommand(fakePrepared(json, { gameAssets: '/assets/virtual/legacy' }));
  const a = c.args;
  assert.ok(a.includes('-Djava.library.path=/v/natives'));
  assert.ok(a.includes('-cp'));
  const game = a.slice(a.indexOf(json.mainClass) + 1);
  assert.equal(game[game.indexOf('--assetsDir') + 1], '/assets/virtual/legacy');
  assert.equal(game[game.indexOf('--userProperties') + 1], '{}');
  assert.ok(!a.some(x => /\$\{/.test(x)));
});

test('mergeInherited объединяет библиотеки и аргументы', () => {
  const parent = { id: '1.20.1', libraries: [{ name: 'p' }], arguments: { game: ['a'], jvm: ['j'] }, mainClass: 'P', downloads: { client: {} } };
  const child = { id: 'fabric-1.20.1', inheritsFrom: '1.20.1', libraries: [{ name: 'c' }], arguments: { game: ['b'] }, mainClass: 'KnotClient' };
  const m = mc.mergeInherited(child, Object.assign({ _jarId: '1.20.1' }, parent));
  assert.deepEqual(m.libraries.map(l => l.name), ['c', 'p']);
  assert.deepEqual(m.arguments.game, ['a', 'b']);
  assert.equal(m.mainClass, 'KnotClient');
  assert.equal(m._jarId, '1.20.1');
});

// ------------------------------------------------------------- загрузчик

function serve(files) {
  const srv = http.createServer((req, res) => {
    const f = files[req.url];
    if (!f) { res.writeHead(404); return res.end('nope'); }
    res.writeHead(200, { 'Content-Length': f.length });
    res.end(f);
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ srv, base: `http://127.0.0.1:${srv.address().port}` })));
}
const sha1 = (b) => crypto.createHash('sha1').update(b).digest('hex');

test('downloadAll: параллельная загрузка, проверка sha1, пропуск готовых файлов', async () => {
  const files = {};
  const tasks = [];
  const dir = tmp();
  for (let i = 0; i < 40; i++) {
    const body = Buffer.from(`file-${i}-` + 'x'.repeat(i * 10));
    files['/f' + i] = body;
    tasks.push({ url: null, path: '/f' + i, dest: path.join(dir, 'd' + (i % 3), 'f' + i), sha1: sha1(body), size: body.length });
  }
  const { srv, base } = await serve(files);
  try {
    tasks.forEach(t => { t.url = base + t.path; });
    let last;
    await dl.downloadAll(tasks, { concurrency: 8, onProgress: (p) => { last = p; } });
    assert.equal(last.done, 40);
    assert.equal(last.bytes, last.totalBytes);
    for (const t of tasks) assert.equal(sha1(fs.readFileSync(t.dest)), t.sha1);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'd0')).filter(n => n.endsWith('.part')), []);

    // повторный запуск не ходит в сеть
    srv.close();
    await dl.downloadAll(tasks, { concurrency: 8 });
  } finally { srv.close(); }
});

test('downloadAll: неверная контрольная сумма и 404 дают ошибку, .part не остаётся', async () => {
  const body = Buffer.from('hello');
  const { srv, base } = await serve({ '/ok': body });
  const dir = tmp();
  try {
    await assert.rejects(dl.downloadAll([{ url: base + '/ok', dest: path.join(dir, 'a'), sha1: 'deadbeef', size: undefined }]), /Контрольная сумма/);
    assert.equal(fs.existsSync(path.join(dir, 'a')), false);
    assert.equal(fs.existsSync(path.join(dir, 'a.part')), false);
    await assert.rejects(dl.downloadAll([{ url: base + '/missing', dest: path.join(dir, 'b') }]), /404/);
  } finally { srv.close(); }
});

test('сетевые ошибки объясняются по-человечески', async () => {
  const dir = tmp();
  // порт, на котором никто не слушает
  const free = await new Promise(r => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  await assert.rejects(dl.fetchJson(`http://127.0.0.1:${free}/x.json`, { retries: 1 }), /Нет соединения с 127\.0\.0\.1/);
  await assert.rejects(dl.downloadAll([{ url: `http://127.0.0.1:${free}/a`, dest: path.join(dir, 'a') }]), /Нет соединения/);
  const ac = new AbortController(); ac.abort();
  await assert.rejects(dl.fetchJson(`http://127.0.0.1:${free}/x.json`, { signal: ac.signal }), /Отменено/);
});
