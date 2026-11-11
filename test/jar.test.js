'use strict';
// Встраивание скина в копию клиента игры: проверяем на настоящей Java, в том числе на подписанном jar.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');
const AdmZip = require('adm-zip');
const SL = require('../src/shared/skin-layout');
const skins = require('../src/main/skins');

const tool = (n) => !cp.spawnSync(n, ['-help'], { encoding: 'utf8' }).error;
const hasJdk = ['javac', 'jar', 'java', 'keytool'].every(tool);
const tmp = () => fs.mkdtempSync(path.join(process.env.UNLUCKY_TEST_TMP || os.tmpdir(), 'unlucky-jar-'));
const sha1 = (b) => crypto.createHash('sha1').update(b).digest('hex');
const T = 'assets/minecraft/textures/entity/';

const MAIN = `
import java.io.*; import java.security.*;
public class Main {
  static String sha1(String res) throws Exception {
    try (InputStream in = Main.class.getResourceAsStream(res)) {
      if (in == null) return "missing";
      MessageDigest md = MessageDigest.getInstance("SHA-1");
      byte[] b = in.readAllBytes(); md.update(b);
      StringBuilder s = new StringBuilder(); for (byte x : md.digest()) s.append(String.format("%02x", x)); return s.toString();
    }
  }
  public static void main(String[] a) throws Exception {
    for (String r : a) System.out.println(r + "=" + sha1(r));
  }
}`;

const skin = (model) => ({ id: 'x', name: 't', model, png: skins.encodePng(SL.makeTemplate(model), 64, 64) });

function fakeJar(dir, { entries, sign }) {
  const src = path.join(dir, 'src'); fs.mkdirSync(src);
  fs.writeFileSync(path.join(src, 'Main.java'), MAIN);
  const out = path.join(dir, 'classes'); fs.mkdirSync(out);
  assert.equal(cp.spawnSync('javac', ['-d', out, path.join(src, 'Main.java')]).status, 0);
  for (const [name, data] of Object.entries(entries)) {
    const f = path.join(out, ...name.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data);
  }
  const jar = path.join(dir, '1.2.3.jar');
  assert.equal(cp.spawnSync('jar', ['cf', jar, '-C', out, '.']).status, 0);
  if (sign) {
    const ks = path.join(dir, 'ks.p12');
    assert.equal(cp.spawnSync('keytool', ['-genkeypair', '-alias', 'm', '-keyalg', 'RSA', '-keysize', '2048', '-validity', '30', '-dname', 'CN=Mojang', '-keystore', ks, '-storepass', 'secret123', '-storetype', 'PKCS12']).status, 0);
    const r = cp.spawnSync('jarsigner', ['-keystore', ks, '-storepass', 'secret123', '-sigfile', 'MOJANG_C', jar, 'm'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr + r.stdout);
  }
  return jar;
}

const readRes = (jar, paths) => {
  const r = cp.spawnSync('java', ['-cp', jar, 'Main', ...paths.map((p) => '/' + p)], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return Object.fromEntries(r.stdout.trim().split('\n').map((l) => { const i = l.lastIndexOf('='); return [l.slice(1, i), l.slice(i + 1)]; }));
};

test('patchClientJar: подменяет только существующие скины, остальное не трогает', () => {
  const zip = new AdmZip();
  zip.addFile(T + 'steve.png', Buffer.from('old-steve'));
  zip.addFile(T + 'alex.png', Buffer.from('old-alex'));
  zip.addFile(T + 'creeper/creeper.png', Buffer.from('creeper'));
  zip.addFile('version.json', Buffer.from('{}'));
  const dir = tmp(); const jar = path.join(dir, '1.8.jar'); zip.writeZip(jar);

  const r = skins.patchClientJar({ jarPath: jar, skin: skin('classic'), releaseTime: '2023-01-01T00:00:00Z' });
  assert.equal(r.replaced, 2);
  assert.match(path.basename(r.path), /^1\.8\.unlucky-[0-9a-f]{10}\.jar$/);
  const out = new AdmZip(r.path);
  assert.equal(skins.decodePng(out.getEntry(T + 'steve.png').getData()).height, 64);
  assert.equal(skins.decodePng(out.getEntry(T + 'alex.png').getData()).width, 64);
  assert.equal(out.getEntry(T + 'creeper/creeper.png').getData().toString(), 'creeper');
  assert.equal(out.getEntry(T + 'player/wide/steve.png'), null, 'новых файлов не создаём');
  assert.equal(new AdmZip(jar).getEntry(T + 'steve.png').getData().toString(), 'old-steve', 'оригинал не тронут');

  // повторно — из кэша; другой скин — новая копия, старая удаляется
  const again = skins.patchClientJar({ jarPath: jar, skin: skin('classic'), releaseTime: '2023-01-01T00:00:00Z' });
  assert.equal(again.cached, true); assert.equal(again.path, r.path);
  const s2 = skin('slim'); s2.png = skins.encodePng(SL.newBuffer(), 64, 64);
  const next = skins.patchClientJar({ jarPath: jar, skin: s2, releaseTime: '2023-01-01T00:00:00Z' });
  assert.notEqual(next.path, r.path);
  assert.equal(fs.existsSync(r.path), false);
  assert.equal(fs.readdirSync(dir).filter((f) => f.includes('.unlucky-')).length, 1);

  // версия 1.6–1.7: файлы в формате 64x32
  const old = skins.patchClientJar({ jarPath: jar, skin: skin('classic'), releaseTime: '2013-10-25T00:00:00Z' });
  assert.equal(skins.decodePng(new AdmZip(old.path).getEntry(T + 'steve.png').getData()).height, 32);

  // нет стандартных скинов — ничего не создаём
  const bare = new AdmZip(); bare.addFile('x.txt', Buffer.from('x'));
  const bj = path.join(dir, 'bare.jar'); bare.writeZip(bj);
  assert.equal(skins.patchClientJar({ jarPath: bj, skin: skin('classic'), releaseTime: '2023-01-01T00:00:00Z' }).path, null);
});

test('копия клиента читается настоящей JVM, в том числе у подписанного jar (как у старых версий)', { skip: !hasJdk && 'нет JDK' }, () => {
  for (const sign of [false, true]) {
    const dir = tmp();
    const names = [T + 'steve.png', T + 'alex.png', T + 'player/wide/zuri.png', T + 'player/slim/zuri.png'];
    const entries = Object.fromEntries(names.map((n) => [n, Buffer.from('vanilla ' + n)]));
    if (sign && !tool('jarsigner')) continue;
    const jar = fakeJar(dir, { entries, sign });
    const before = readRes(jar, names);
    assert.equal(before[names[0]], sha1(Buffer.from('vanilla ' + names[0])));

    const s = skin('slim');
    const r = skins.patchClientJar({ jarPath: jar, skin: s, releaseTime: '2023-06-07T00:00:00Z' });
    assert.equal(r.replaced, 4);
    const exp = skins.encodePng(SL.convertArms(skins.decodePng(s.png).data, 'slim', 'classic'), 64, 64);
    const expSlim = skins.encodePng(SL.convertArms(skins.decodePng(s.png).data, 'slim', 'slim'), 64, 64);
    const after = readRes(r.path, names);
    assert.equal(after[T + 'steve.png'], sha1(exp), `sign=${sign}: steve`);
    assert.equal(after[T + 'player/wide/zuri.png'], sha1(exp));
    assert.equal(after[T + 'alex.png'], sha1(expSlim));
    assert.equal(after[T + 'player/slim/zuri.png'], sha1(expSlim));
    if (sign) {
      const z = new AdmZip(r.path);
      assert.equal(z.getEntries().filter((e) => /^META-INF\/.*\.(SF|DSA|RSA)$/.test(e.entryName)).length, 0, 'подпись убрана');
    }
  }
});
