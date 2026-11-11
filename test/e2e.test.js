'use strict';
// Сквозной тест: локальный «сервер Mojang» + настоящая Java-программа вместо игры.
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
const skins = require('../src/main/skins');
const SL = require('../src/shared/skin-layout');

const hasJavac = cp.spawnSync('javac', ['-version']).status === 0;
const tmp = () => fs.mkdtempSync(path.join(process.env.UNLUCKY_TEST_TMP || os.tmpdir(), 'unlucky-e2e-'));
const sha1 = (b) => crypto.createHash('sha1').update(b).digest('hex');
const here = { win32: 'windows', darwin: 'osx', linux: 'linux' }[process.platform];

const MAIN = `
import java.io.File;
public class Main {
  public static void main(String[] a) throws Exception {
    System.out.println("ARGS=" + String.join("|", a));
    String lib = System.getProperty("java.library.path");
    System.out.println("LIBPATH=" + lib);
    System.out.println("NATIVE=" + new File(lib, "liblwjgl.so").exists() + "," + new File(lib, "MANIFEST.MF").exists());
    System.out.println("CP=" + System.getProperty("java.class.path"));
    System.out.println("CWD=" + new File(".").getCanonicalPath());
    System.out.println("LOG4J=" + System.getProperty("log4j.configurationFile"));
    System.out.println("XMX=" + (Runtime.getRuntime().maxMemory() > 2000L*1024*1024));
  }
}`;

function buildFakeClient(dir) {
  const src = path.join(dir, 'src'); fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, 'Main.java'), MAIN);
  const out = path.join(dir, 'classes'); fs.mkdirSync(out);
  const r = cp.spawnSync('javac', ['-d', out, path.join(src, 'Main.java')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const zip = new AdmZip();
  zip.addLocalFile(path.join(out, 'Main.class'));
  zip.addFile('version.json', Buffer.from(JSON.stringify({ id: 'fake-1.0', pack_version: { resource: 15, data: 15 } })));
  return zip.toBuffer();
}

test('prepare → скин → запуск: полный цикл на фейковом сервере', { skip: !hasJavac && 'нет javac' }, async () => {
  const work = tmp();
  const files = {};
  const put = (url, buf) => { files[url] = buf; return { url, sha1: sha1(buf), size: buf.length }; };

  const clientJar = buildFakeClient(work);
  const libA = new AdmZip(); libA.addFile('a.txt', Buffer.from('a'));
  const nat = new AdmZip();
  nat.addFile('liblwjgl.so', Buffer.from('ELF')); nat.addFile('lwjgl.dll', Buffer.from('MZ')); nat.addFile('META-INF/MANIFEST.MF', Buffer.from('x'));
  const iconBytes = Buffer.from('icon-bytes'), oggBytes = Buffer.from('ogg-bytes');
  const iconHash = sha1(iconBytes), oggHash = sha1(oggBytes);
  files[`/objects/${iconHash.slice(0, 2)}/${iconHash}`] = iconBytes;
  files[`/objects/${oggHash.slice(0, 2)}/${oggHash}`] = oggBytes;
  const index = Buffer.from(JSON.stringify({ virtual: true, objects: { 'icons/icon.png': { hash: iconHash, size: iconBytes.length }, 'sounds/x.ogg': { hash: oggHash, size: oggBytes.length } } }));

  const srv = http.createServer((req, res) => {
    const f = files[req.url];
    if (!f) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Length': f.length }); res.end(f);
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  process.env.UNLUCKY_RESOURCES_URL = base + '/objects';
  const U = (o) => Object.assign(o, { url: base + o.url });

  const natKey = 'natives-' + here;
  const json = {
    id: 'fake-1.0', type: 'release', releaseTime: '2023-06-07T00:00:00+00:00', mainClass: 'Main',
    javaVersion: { component: 'jre-test', majorVersion: 8 },
    assetIndex: Object.assign({ id: 'legacy' }, U(put('/index.json', index))),
    downloads: { client: U(put('/client.jar', clientJar.length ? clientJar : Buffer.alloc(0))) },
    logging: { client: { argument: '-Dlog4j.configurationFile=${path}', file: Object.assign({ id: 'client-1.xml' }, U(put('/log.xml', Buffer.from('<Configuration/>')))) } },
    libraries: [
      { name: 'test:liba:1', downloads: { artifact: Object.assign({ path: 'test/liba/1/liba-1.jar' }, U(put('/liba.jar', libA.toBuffer()))) } },
      {
        name: 'test:nat:1', natives: { [here]: natKey }, extract: { exclude: ['META-INF/'] },
        downloads: { classifiers: { [natKey]: Object.assign({ path: 'test/nat/1/nat-1-' + natKey + '.jar' }, U(put('/nat.jar', nat.toBuffer()))) } },
      },
    ],
    arguments: {
      jvm: ['-Djava.library.path=${natives_directory}', '-cp', '${classpath}'],
      game: ['--username', '${auth_player_name}', '--uuid', '${auth_uuid}', '--gameDir', '${game_directory}', '--assetsDir', '${game_assets}', '--assetIndex', '${assets_index_name}'],
    },
  };

  const root = path.join(work, 'mc');
  fs.mkdirSync(path.join(root, 'versions', 'fake-1.0'), { recursive: true });
  fs.writeFileSync(path.join(root, 'versions', 'fake-1.0', 'fake-1.0.json'), JSON.stringify(json));

  try {
    const stages = [];
    let last;
    const prep = await mc.prepare({
      root, id: 'fake-1.0', gameDir: root, javaPath: 'java',
      onStage: s => stages.push(s), onProgress: p => { last = p; },
    });
    assert.ok(stages.includes('Загрузка файлов…'));
    assert.equal(last.done, last.total);
    assert.ok(fs.existsSync(prep.clientJar));
    assert.equal(prep.javaSource, 'custom');
    // legacy-ассеты скопированы в virtual/<id>
    assert.equal(fs.readFileSync(path.join(root, 'assets', 'virtual', 'legacy', 'icons', 'icon.png'), 'utf8'), 'icon-bytes');
    assert.equal(prep.gameAssets, path.join(root, 'assets', 'virtual', 'legacy'));
    // нативы извлечены, META-INF исключён
    assert.ok(fs.existsSync(path.join(prep.nativesDir, 'liblwjgl.so')));
    assert.ok(!fs.existsSync(path.join(prep.nativesDir, 'MANIFEST.MF')));

    // ресурспак берёт pack_format из version.json внутри клиента
    const skin = { id: 'x', name: 'Test', model: 'classic', png: skins.encodePng(SL.makeTemplate('classic'), 64, 64) };
    const r = skins.applySkinPack({ gameDir: root, skin, enable: true, releaseTime: json.releaseTime, jarPath: prep.clientJar, gameLang: true });
    assert.equal(r.packFormat, 15);
    assert.match(fs.readFileSync(path.join(root, 'options.txt'), 'utf8'), /file\/UnluckySkin/);

    // повторный prepare — ничего не качает
    const before = Object.keys(files).length;
    srv.close();
    const again = await mc.prepare({ root, id: 'fake-1.0', gameDir: root, javaPath: 'java' });
    assert.equal(again.classpath.length, prep.classpath.length);
    assert.ok(before > 0);

    // настоящий запуск процесса Java
    const cmd = mc.buildCommand(Object.assign({}, prep, { gameDir: root, nickname: 'Unlucky_Test', ramMb: 2500, jvmArgs: '', launcherVersion: '1.0.0' }));
    const lines = [];
    const code = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Java не завершилась за 20 с')), 20000);
      mc.launchGame(cmd, { onLine: l => lines.push(l), onExit: (c, e) => { clearTimeout(t); e ? reject(e) : resolve(c); } });
    });
    const out = lines.join('\n');
    assert.equal(code, 0, out);
    const grab = (k) => (lines.find(l => l.startsWith(k + '=')) || '').slice(k.length + 1);
    assert.deepEqual(grab('ARGS').split('|'), [
      '--username', 'Unlucky_Test', '--uuid', mc.offlineUuid('Unlucky_Test'), '--gameDir', root, '--assetsDir', path.join(root, 'assets', 'virtual', 'legacy'), '--assetIndex', 'legacy',
    ]);
    assert.equal(grab('LIBPATH'), prep.nativesDir);
    assert.equal(grab('NATIVE'), 'true,false');
    assert.equal(fs.realpathSync(grab('CWD')), fs.realpathSync(root));
    assert.equal(grab('XMX'), 'true');
    assert.ok(grab('LOG4J').endsWith('client-1.xml'));
    assert.ok(grab('CP').includes('liba-1.jar') && grab('CP').includes('fake-1.0.jar'));
  } finally { srv.close(); }
});
