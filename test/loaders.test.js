'use strict';
// Fabric и Forge на фейковых серверах: списки, установка профилей, запуск через общий prepare.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const cp = require('child_process');
const AdmZip = require('adm-zip');
const mc = require('../src/main/minecraft');
const loaders = require('../src/main/loaders');

const hasJdk = ['javac', 'jar', 'java'].every((n) => !cp.spawnSync(n, ['-help']).error);
const tmp = () => fs.mkdtempSync(path.join(process.env.UNLUCKY_TEST_TMP || os.tmpdir(), 'unlucky-ld-'));
const sha1 = (b) => crypto.createHash('sha1').update(b).digest('hex');

// ---------------------------------------------------------------- чистые функции

test('Forge: разбор maven-metadata, промо-сборки и выбор (в том числе старые версии с суффиксом)', () => {
  const xml = `<metadata><versioning><versions>
    <version>1.5.2-7.8.1.738</version><version>1.7.10-10.13.4.1614-1.7.10</version><version>1.7.10-10.13.2.1291</version>
    <version>1.12.2-14.23.5.2859</version><version>1.12.2-14.23.5.2860</version>
    <version>1.20.1-47.2.0</version><version>1.20.1-47.3.0</version><version>1.20.1-47.4.0</version></versions></versioning></metadata>`;
  const meta = loaders.parseForgeMetadata(xml);
  assert.deepEqual(Object.keys(meta), ['1.5.2', '1.7.10', '1.12.2', '1.20.1']);
  assert.equal(meta['1.7.10'].length, 2);
  const cat = loaders.buildForgeCatalog(meta, {
    '1.20.1-recommended': '47.3.0', '1.20.1-latest': '47.4.0',
    '1.7.10-recommended': '10.13.4.1614', '1.7.10-latest': '10.13.4.1614', '1.12.2-latest': '14.23.5.2860',
  });
  assert.deepEqual(loaders.pickForge(cat, '1.20.1'), { full: '1.20.1-47.3.0', build: '47.3.0', recommended: true });
  const old = loaders.pickForge(cat, '1.7.10');
  assert.equal(old.full, '1.7.10-10.13.4.1614-1.7.10');
  assert.equal(old.build, '10.13.4.1614');
  assert.equal(loaders.pickForge(cat, '1.12.2').full, '1.12.2-14.23.5.2860'); // нет recommended → latest
  assert.equal(loaders.pickForge({ '1.8': { all: ['1.8-11.14.0.1237', '1.8-11.14.0.1299'], recommended: null, latest: null } }, '1.8').build, '11.14.0.1299'); // нет промо → последняя
  assert.equal(loaders.pickForge(cat, '9.9'), null);
});

test('detectLoader, версия игры профиля и сравнение версий', () => {
  assert.equal(mc.detectLoader({ id: 'fabric-loader-0.16.9-1.21.4', libraries: [] }), 'fabric');
  assert.equal(mc.detectLoader({ id: 'x', libraries: [{ name: 'net.fabricmc:fabric-loader:0.15.0' }] }), 'fabric');
  assert.equal(mc.detectLoader({ id: '1.20.1-forge-47.3.0', libraries: [] }), 'forge');
  assert.equal(mc.detectLoader({ id: '1.7.10-Forge10.13.4.1614-1.7.10', libraries: [] }), 'forge');
  assert.equal(mc.detectLoader({ id: 'x', libraries: [{ name: 'net.minecraftforge:fmlloader:1.20.1-47.3.0' }] }), 'forge');
  assert.equal(mc.detectLoader({ id: 'neoforge-21.1.50', libraries: [{ name: 'net.neoforged:neoforge:21.1.50' }] }), null);
  assert.equal(mc.detectLoader({ id: '1.21.4', libraries: [{ name: 'com.google.guava:guava:31' }] }), null);
  assert.equal(loaders.gameVersionOf('fabric-loader-0.16.9-1.21.4', { inheritsFrom: '1.21.4' }), '1.21.4');
  assert.equal(loaders.gameVersionOf('1.12.2-forge1.12.2-14.23.5.2860', {}), '1.12.2');
  assert.ok(loaders.cmpMc('1.20.4', '1.20.1') > 0 && loaders.cmpMc('1.7.10', '1.12.2') < 0 && loaders.cmpMc('1.21', '1.21.0') === 0);
});

test('mergeInherited: библиотека профиля заменяет такую же библиотеку родителя, дата — от игры', () => {
  const parent = { id: '1.20.1', releaseTime: '2023-06-12T00:00:00+00:00', libraries: [{ name: 'com.google.guava:guava:31.0.1-jre' }, { name: 'org.lwjgl:lwjgl:3.3.1' }, { name: 'org.lwjgl:lwjgl:3.3.1:natives-linux' }] };
  const child = { id: '1.20.1-forge-47.3.0', inheritsFrom: '1.20.1', releaseTime: '2024-09-01T00:00:00+00:00', libraries: [{ name: 'com.google.guava:guava:32.1.2-jre' }, { name: 'net.minecraftforge:forge:1.20.1-47.3.0' }] };
  const m = mc.mergeInherited(child, Object.assign({ _jarId: '1.20.1', _baseReleaseTime: parent.releaseTime }, parent));
  assert.deepEqual(m.libraries.map((l) => l.name), ['com.google.guava:guava:32.1.2-jre', 'net.minecraftforge:forge:1.20.1-47.3.0', 'org.lwjgl:lwjgl:3.3.1', 'org.lwjgl:lwjgl:3.3.1:natives-linux']);
  assert.equal(m._baseReleaseTime, '2023-06-12T00:00:00+00:00');
  assert.equal(m._jarId, '1.20.1');
});

// ---------------------------------------------------------------- фейковые серверы

async function serve(handler) {
  const srv = http.createServer(handler);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { srv, base: 'http://127.0.0.1:' + srv.address().port };
}
const send = (res, body, type) => {
  const b = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(200, { 'content-type': type || 'application/json', 'content-length': b.length }); res.end(b);
};
const MANIFEST = {
  latest: { release: '1.21.4', snapshot: '24w01a' },
  versions: [['1.21.4', 'release', '2024-12-03'], ['24w01a', 'snapshot', '2024-12-10'], ['1.20.1', 'release', '2023-06-12'], ['1.12.2', 'release', '2017-09-18'], ['1.7.10', 'release', '2014-06-26']]
    .map(([id, type, t]) => ({ id, type, url: 'http://127.0.0.1:1/' + id + '.json', time: t + 'T00:00:00+00:00', releaseTime: t + 'T00:00:00+00:00', sha1: 'x' })),
};
const FABRIC_PROFILE = (base, gv, lv) => ({
  id: `fabric-loader-${lv}-${gv}`, inheritsFrom: gv, releaseTime: '2024-12-03T00:00:00+00:00', time: '2024-12-03T00:00:00+00:00', type: 'release',
  mainClass: 'Main',
  arguments: { game: [], jvm: ['-DFabricMcEmu= net.minecraft.client.main.Main '] },
  libraries: [{ name: `net.fabricmc:fabric-loader:${lv}`, url: base + '/maven/' }, { name: 'net.fabricmc:intermediary:' + gv, url: base + '/maven/' }],
});

async function fakeFabric() {
  const hits = [];
  const { srv, base } = await serve((q, res) => {
    hits.push(q.url);
    if (q.url === '/v2/versions/game') return send(res, [{ version: '1.21.4', stable: true }, { version: '24w01a', stable: false }, { version: '1.20.1', stable: true }]);
    if (q.url === '/v2/versions/loader/1.20.1') return send(res, [{ loader: { version: '0.17.0-beta.1', stable: false } }, { loader: { version: '0.16.9', stable: true } }]);
    if (q.url === '/v2/versions/loader/1.20.1/0.16.9/profile/json') return send(res, FABRIC_PROFILE(base, '1.20.1', '0.16.9'));
    if (q.url.startsWith('/maven/')) return send(res, Buffer.from('jar:' + q.url), 'application/java-archive');
    res.writeHead(q.url.startsWith('/v2/versions/loader/') ? 400 : 404); res.end('{}');
  });
  return { srv, base, hits };
}

test('Fabric: список версий, установка профиля (берётся стабильный загрузчик), неподдерживаемая версия', async () => {
  const root = tmp();
  const m = await serve((q, res) => send(res, MANIFEST));
  const f = await fakeFabric();
  process.env.UNLUCKY_MANIFEST_URL = m.base + '/m.json';
  process.env.UNLUCKY_FABRIC_URL = f.base;
  try {
    const list = await loaders.listLoaderVersions(root, 'fabric');
    assert.deepEqual(list.versions.map((v) => v.id), ['1.21.4', '24w01a', '1.20.1']); // только то, что поддерживает Fabric, в порядке манифеста
    assert.equal(list.versions.find((v) => v.id === '24w01a').type, 'snapshot');
    assert.equal(list.versions.every((v) => !v.installed), true);
    assert.equal(list.offline, false);

    const id = await loaders.installFabric({ root, mc: '1.20.1' });
    assert.equal(id, 'fabric-loader-0.16.9-1.20.1');
    const saved = JSON.parse(fs.readFileSync(path.join(root, 'versions', id, id + '.json'), 'utf8'));
    assert.equal(saved.inheritsFrom, '1.20.1');
    assert.equal((await loaders.findInstalled(root, 'fabric', '1.20.1'))[0].id, id);

    // после установки версия помечена, а в списке Vanilla профиль Fabric не показывается
    const again = await loaders.listLoaderVersions(root, 'fabric');
    assert.equal(again.versions.find((v) => v.id === '1.20.1').installed, true);
    assert.equal((await mc.listVersions(root)).versions.some((v) => v.id === id), false);

    await assert.rejects(loaders.installFabric({ root, mc: '1.7.10' }), /не поддерживает/);

    // без сети — списки из кэша
    process.env.UNLUCKY_MANIFEST_URL = 'http://127.0.0.1:1/m.json';
    process.env.UNLUCKY_FABRIC_URL = 'http://127.0.0.1:1';
    const off = await loaders.listLoaderVersions(root, 'fabric');
    assert.equal(off.offline, true);
    assert.deepEqual(off.versions.map((v) => v.id), ['1.21.4', '24w01a', '1.20.1']);
  } finally { m.srv.close(); f.srv.close(); delete process.env.UNLUCKY_MANIFEST_URL; delete process.env.UNLUCKY_FABRIC_URL; }
});

const INSTALLER = `
import java.nio.file.*;
public class Installer {
  public static void main(String[] a) throws Exception {
    if (a.length < 2 || !a[0].equals("--installClient")) { System.err.println("bad args"); System.exit(2); }
    Path root = Paths.get(a[1]);
    if (!Files.exists(root.resolve("launcher_profiles.json"))) { System.err.println("There is no minecraft launcher profile in " + root); System.exit(3); }
    System.out.println("Installing into " + root);
    System.setProperty("x", "y");
    String id = "1.20.1-forge-47.3.0";
    Path dir = root.resolve("versions").resolve(id); Files.createDirectories(dir);
    Files.writeString(dir.resolve(id + ".json"), "{\\"id\\":\\"" + id + "\\",\\"inheritsFrom\\":\\"1.20.1\\",\\"type\\":\\"release\\",\\"releaseTime\\":\\"2024-09-01T00:00:00+00:00\\",\\"mainClass\\":\\"Main\\","
      + "\\"libraries\\":[{\\"name\\":\\"net.minecraftforge:forge:1.20.1-47.3.0:client\\",\\"downloads\\":{\\"artifact\\":{\\"path\\":\\"net/minecraftforge/forge/1.20.1-47.3.0/forge-1.20.1-47.3.0-client.jar\\",\\"url\\":\\"\\",\\"sha1\\":\\"\\",\\"size\\":0}}}],"
      + "\\"arguments\\":{\\"game\\":[\\"--launchTarget\\",\\"forgeclient\\"],\\"jvm\\":[]}}");
    Path lib = root.resolve("libraries/net/minecraftforge/forge/1.20.1-47.3.0/forge-1.20.1-47.3.0-client.jar");
    Files.createDirectories(lib.getParent()); Files.write(lib, new byte[] {1, 2, 3});
    System.out.println("Successfully installed client into launcher.");
  }
}`;

function buildInstallerJar(dir) {
  const src = path.join(dir, 'Installer.java'); fs.writeFileSync(src, INSTALLER);
  const out = path.join(dir, 'cls'); fs.mkdirSync(out);
  assert.equal(cp.spawnSync('javac', ['-d', out, src], { encoding: 'utf8' }).status, 0);
  const jar = path.join(dir, 'installer.jar');
  assert.equal(cp.spawnSync('jar', ['cfe', jar, 'Installer', '-C', out, 'Installer.class']).status, 0);
  const z = new AdmZip(jar);
  z.addFile('install_profile.json', Buffer.from(JSON.stringify({ spec: 1, profile: 'forge', version: '1.20.1-forge-47.3.0', json: '/version.json', minecraft: '1.20.1' })));
  z.writeZip(jar);
  return fs.readFileSync(jar);
}

async function fakeForge(installer) {
  const hits = [];
  const P = '/net/minecraftforge/forge/';
  const { srv, base } = await serve((q, res) => {
    hits.push(q.url);
    if (q.url === P + 'maven-metadata.xml') return send(res, `<metadata><versioning><versions><version>1.5.2-7.8.1.738</version><version>1.7.10-10.13.4.1614-1.7.10</version><version>1.12.2-14.23.5.2860</version><version>1.20.1-47.2.0</version><version>1.20.1-47.3.0</version></versions></versioning></metadata>`, 'application/xml');
    if (q.url === '/promos.json') return send(res, { homepage: 'x', promos: { '1.20.1-recommended': '47.3.0', '1.20.1-latest': '47.3.0', '1.7.10-recommended': '10.13.4.1614', '1.12.2-latest': '14.23.5.2860' } });
    if (q.url === P + '1.20.1-47.3.0/forge-1.20.1-47.3.0-installer.jar') return send(res, installer, 'application/java-archive');
    if (q.url === P + '1.20.1-47.3.0/forge-1.20.1-47.3.0-installer.jar.sha1') return send(res, sha1(installer), 'text/plain');
    res.writeHead(404); res.end();
  });
  return { srv, base, hits };
}

test('Forge: каталог для интерфейса и установка настоящим установщиком (Java)', { skip: !hasJdk && 'нет JDK' }, async () => {
  const work = tmp(), root = path.join(work, 'mc');
  fs.mkdirSync(path.join(root, 'versions'), { recursive: true });
  const installer = buildInstallerJar(work);
  const m = await serve((q, res) => send(res, MANIFEST));
  const f = await fakeForge(installer);
  process.env.UNLUCKY_MANIFEST_URL = m.base + '/m.json';
  process.env.UNLUCKY_FORGE_URL = f.base;
  process.env.UNLUCKY_FORGE_PROMOS_URL = f.base + '/promos.json';
  try {
    const list = await loaders.listLoaderVersions(root, 'forge');
    // 1.21.4 и снапшот Forge не поддерживает, 1.5.2 старше минимума
    assert.deepEqual(list.versions.map((v) => v.id), ['1.20.1', '1.12.2', '1.7.10']);
    assert.equal(list.versions[0].loaderVersion, '47.3.0');
    assert.equal(list.versions[2].loaderVersion, '10.13.4.1614');
    assert.equal(list.versions.every((v) => v.type === 'release'), true);

    const stages = [], lines = [];
    const id = await loaders.installForge({
      root, mc: '1.20.1', javaExe: 'java', onStage: (s) => stages.push(s), onLine: (l) => lines.push(l),
    });
    assert.equal(id, '1.20.1-forge-47.3.0');
    assert.ok(lines.some((l) => l.includes('Successfully installed')), lines.join('\n'));
    assert.ok(stages.some((s) => /Forge 47\.3\.0/.test(s)));
    assert.ok(fs.existsSync(path.join(root, 'launcher_profiles.json')), 'установщику нужен launcher_profiles.json');
    assert.ok(fs.existsSync(path.join(root, 'cache', 'forge', 'forge-1.20.1-47.3.0-installer.jar')));
    assert.equal((await loaders.findInstalled(root, 'forge', '1.20.1'))[0].id, id);
    assert.equal((await loaders.listLoaderVersions(root, 'forge')).versions[0].installed, true);

    // повторная установка не качает установщик заново
    const before = f.hits.filter((h) => h.endsWith('-installer.jar')).length;
    await loaders.installForge({ root, mc: '1.20.1', javaExe: 'java' });
    assert.equal(f.hits.filter((h) => h.endsWith('-installer.jar')).length, before);

    // версия без сборок Forge
    await assert.rejects(loaders.installForge({ root, mc: '1.21.4', javaExe: 'java' }), /нет сборок Forge/);
    // установщик, который упал, даёт понятную ошибку
    await assert.rejects(loaders.runInstaller({ javaExe: 'java', jar: path.join(work, 'nope.jar'), root, onLine: () => {} }), /код/);
  } finally { m.srv.close(); f.srv.close(); delete process.env.UNLUCKY_MANIFEST_URL; delete process.env.UNLUCKY_FORGE_URL; delete process.env.UNLUCKY_FORGE_PROMOS_URL; }
});

test('установленный профиль Fabric запускается через prepare: библиотеки с maven-url, родитель, dedupe', { skip: !hasJdk && 'нет JDK' }, async () => {
  const work = tmp(), root = path.join(work, 'mc');
  const files = {};
  const put = (url, buf) => { files[url] = buf; return { url, sha1: sha1(buf), size: buf.length }; };
  const client = new AdmZip(); client.addFile('version.json', Buffer.from('{}'));
  const index = Buffer.from(JSON.stringify({ objects: {} }));
  let base;
  const fab = await fakeFabric();
  process.env.UNLUCKY_FABRIC_URL = fab.base;
  const m = await serve((q, res) => { const b = files[q.url]; if (!b) { res.writeHead(404); return res.end(); } send(res, b, 'application/octet-stream'); });
  base = m.base;
  const vanilla = {
    id: '1.20.1', type: 'release', releaseTime: '2023-06-12T00:00:00+00:00', mainClass: 'net.minecraft.client.main.Main', javaVersion: { component: 'jre-test', majorVersion: 8 },
    assetIndex: Object.assign({ id: 'x' }, put('/index.json', index), { url: base + '/index.json' }),
    downloads: { client: Object.assign(put('/client.jar', client.toBuffer()), { url: base + '/client.jar' }) },
    libraries: [{ name: 'org.ow2.asm:asm:9.3', downloads: { artifact: Object.assign({ path: 'org/ow2/asm/asm/9.3/asm-9.3.jar' }, put('/asm93.jar', Buffer.from('asm93'))) } }],
    arguments: { jvm: ['-cp', '${classpath}'], game: ['--username', '${auth_player_name}'] },
  };
  vanilla.assetIndex.url = base + '/index.json'; vanilla.libraries[0].downloads.artifact.url = base + '/asm93.jar'; vanilla.downloads.client.url = base + '/client.jar';
  fs.mkdirSync(path.join(root, 'versions', '1.20.1'), { recursive: true });
  fs.writeFileSync(path.join(root, 'versions', '1.20.1', '1.20.1.json'), JSON.stringify(vanilla));
  try {
    const id = await loaders.installFabric({ root, mc: '1.20.1' });
    // профиль требует свежий asm (как у настоящего Fabric) — он должен вытеснить asm родителя
    const pf = path.join(root, 'versions', id, id + '.json');
    const prof = JSON.parse(fs.readFileSync(pf, 'utf8'));
    prof.libraries.push({ name: 'org.ow2.asm:asm:9.6', url: fab.base + '/maven/' });
    fs.writeFileSync(pf, JSON.stringify(prof));
    const prep = await mc.prepare({ root, id, gameDir: root, javaPath: 'java' });
    const names = prep.classpath.map((p) => path.relative(root, p).split(path.sep).join('/'));
    assert.ok(names.includes('libraries/net/fabricmc/fabric-loader/0.16.9/fabric-loader-0.16.9.jar'), names.join('\n'));
    assert.ok(names.includes('libraries/org/ow2/asm/asm/9.6/asm-9.6.jar'));
    assert.ok(!names.includes('libraries/org/ow2/asm/asm/9.3/asm-9.3.jar'), 'asm родителя вытеснен профилем');
    assert.ok(names.includes('versions/1.20.1/1.20.1.jar'), 'jar берётся у родителя');
    assert.equal(prep.json.mainClass, 'Main');
    assert.equal(prep.json._baseReleaseTime, '2023-06-12T00:00:00+00:00');
    const cmd = mc.buildCommand(Object.assign({}, prep, { gameDir: root, nickname: 'Unlucky_Test', ramMb: 2048, jvmArgs: '', launcherVersion: '1.1.0' }));
    assert.ok(cmd.args.includes('-DFabricMcEmu= net.minecraft.client.main.Main '));
  } finally { m.srv.close(); fab.srv.close(); delete process.env.UNLUCKY_FABRIC_URL; }
});
