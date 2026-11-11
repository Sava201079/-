'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const SL = require('../src/shared/skin-layout');
const skins = require('../src/main/skins');

const tmp = () => fs.mkdtempSync(path.join(process.env.UNLUCKY_TEST_TMP || os.tmpdir(), 'unlucky-'));
const get = (b, x, y) => Array.from(b.slice((y * 64 + x) * 4, (y * 64 + x) * 4 + 4));
const set = (b, x, y, c) => { b.set(c, (y * 64 + x) * 4); };

test('шаблон рисует только внутри маски модели', () => {
  for (const model of ['classic', 'slim']) {
    const t = SL.makeTemplate(model), m = SL.mask(model);
    let painted = 0;
    for (let i = 0; i < 4096; i++) {
      if (t[i * 4 + 3] > 0) { painted++; assert.equal(m[i], 1, `${model}: пиксель ${i % 64},${Math.floor(i / 64)} вне маски`); }
    }
    assert.ok(painted > 1500, 'шаблон должен быть заполнен');
  }
});

test('маска: 3264 текселя для classic и 3136 для slim', () => {
  const sum = (m) => m.reduce((a, b) => a + b, 0);
  assert.equal(sum(SL.mask('classic')), 3264);
  assert.equal(sum(SL.mask('slim')), 3136);
});

test('legacy 64x32 -> 64x64 зеркалит правую ногу в левую', () => {
  const src = new Uint8ClampedArray(64 * 32 * 4);
  set(src, 4, 20, [255, 0, 0, 255]); // правая нога, front, самый левый столбец
  const dst = SL.upgradeLegacy(src);
  assert.equal(dst.length, 64 * 64 * 4);
  assert.deepEqual(get(dst, 4, 20), [255, 0, 0, 255]);
  assert.deepEqual(get(dst, 23, 52), [255, 0, 0, 255]); // левая нога, front, самый правый столбец
});

test('classic -> slim: боковые грани сохраняются, фронт сжимается до 3 столбцов', () => {
  const src = SL.newBuffer();
  const cols = [[10, 0, 0, 255], [20, 0, 0, 255], [30, 0, 0, 255], [40, 0, 0, 255]];
  cols.forEach((c, i) => { for (let y = 20; y < 32; y++) set(src, 44 + i, y, c); });
  set(src, 48, 25, [1, 2, 3, 255]); // левая боковая грань (первый столбец)
  const slim = SL.convertArms(src, 'classic', 'slim');
  assert.deepEqual([get(slim, 44, 25)[0], get(slim, 45, 25)[0], get(slim, 46, 25)[0]], [10, 30, 40]);
  assert.deepEqual(get(slim, 47, 25), [1, 2, 3, 255]); // боковая грань сдвинулась на 1 пиксель
  const back = SL.convertArms(slim, 'slim', 'classic');
  assert.deepEqual(get(back, 48, 25), [1, 2, 3, 255]);
  assert.deepEqual(SL.convertArms(src, 'classic', 'classic'), src);
});

test('normalizeSkin принимает 64x64 и 64x32, отклоняет остальное', () => {
  const ok64 = skins.encodePng(SL.newBuffer(), 64, 64);
  const ok32 = skins.encodePng(new Uint8ClampedArray(64 * 32 * 4), 64, 32);
  const bad = skins.encodePng(new Uint8ClampedArray(128 * 128 * 4), 128, 128);
  assert.equal(skins.decodePng(skins.normalizeSkin(ok64)).height, 64);
  assert.equal(skins.decodePng(skins.normalizeSkin(ok32)).height, 64);
  assert.throws(() => skins.normalizeSkin(bad), /64×64/);
  assert.throws(() => skins.normalizeSkin(Buffer.from('not a png')), /PNG/);
});

test('хранилище скинов: создание, сохранение, активный, удаление', () => {
  const dir = tmp();
  const s = skins.createSkinStore(dir);
  s.ensureDefault();
  assert.equal(s.list().skins.length, 1);
  const second = s.create({ name: 'Второй', model: 'slim' });
  s.setActive(second.id);
  assert.equal(s.getActive().id, second.id);
  assert.equal(s.getActive().model, 'slim');
  s.save(second.id, { name: 'Переименован' });
  assert.equal(s.list().skins.find(x => x.id === second.id).name, 'Переименован');
  assert.throws(() => s.get('../etc/passwd'), /id/);
  s.remove(second.id);
  assert.equal(s.list().skins.length, 1);
  assert.notEqual(s.list().active, second.id);
  // перезагрузка с диска
  assert.equal(skins.createSkinStore(dir).list().skins.length, 1);
});

test('options.txt: включение, замена и отключение пака', () => {
  const dir = tmp();
  const f = path.join(dir, 'options.txt');
  skins.patchOptions(dir, { enable: true, legacyNames: false, lang: 'ru_ru' });
  assert.equal(fs.readFileSync(f, 'utf8'), 'resourcePacks:["vanilla","file/UnluckySkin"]\nlang:ru_ru\n');

  fs.writeFileSync(f, 'fov:70.0\nresourcePacks:["vanilla","file/Other","file/UnluckySkin"]\nlang:en_us\n');
  skins.patchOptions(dir, { enable: true, legacyNames: false, lang: 'ru_ru' });
  assert.equal(fs.readFileSync(f, 'utf8'), 'fov:70.0\nresourcePacks:["vanilla","file/Other","file/UnluckySkin"]\nlang:en_us\n');

  skins.patchOptions(dir, { enable: false, legacyNames: false });
  assert.match(fs.readFileSync(f, 'utf8'), /resourcePacks:\["vanilla","file\/Other"\]/);

  skins.patchOptions(dir, { enable: true, legacyNames: true });
  assert.match(fs.readFileSync(f, 'utf8'), /"UnluckySkin"\]/);
  assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /file\/UnluckySkin/);

  const clean = tmp();
  skins.patchOptions(clean, { enable: false, legacyNames: false });
  assert.equal(fs.existsSync(path.join(clean, 'options.txt')), false, 'без пака options.txt не создаём');
});

test('ресурспак: файлы для старых и новых версий, руки под нужную модель', () => {
  const dir = tmp();
  const slimSkin = { id: 'x', name: 't', model: 'slim', png: skins.encodePng(SL.makeTemplate('slim'), 64, 64) };
  const r = skins.applySkinPack({ gameDir: dir, skin: slimSkin, enable: true, releaseTime: '2023-06-07T00:00:00+00:00', gameLang: true });
  assert.equal(r.applied, true);
  const base = path.join(dir, 'resourcepacks', 'UnluckySkin');
  const meta = JSON.parse(fs.readFileSync(path.join(base, 'pack.mcmeta'), 'utf8'));
  assert.equal(meta.pack.pack_format, 4); // без jar берём таблицу по дате
  const e = (...p) => path.join(base, 'assets', 'minecraft', 'textures', 'entity', ...p);
  for (const p of [['steve.png'], ['alex.png'], ['player', 'wide', 'steve.png'], ['player', 'slim', 'zuri.png'], ['player', 'wide', 'ari.png']]) {
    assert.ok(fs.existsSync(e(...p)), p.join('/'));
  }
  // slim-скин: в slim-файле ширина передней грани руки 3px, в wide — 4px (конвертировано)
  const wide = skins.decodePng(fs.readFileSync(e('player', 'wide', 'steve.png'))).data;
  const slim = skins.decodePng(fs.readFileSync(e('player', 'slim', 'steve.png'))).data;
  assert.equal(get(slim, 47, 25)[3] > 0, true); // левая боковая грань начинается с x=47 у slim
  assert.equal(get(wide, 47, 25)[3] > 0, true);
  assert.equal(get(wide, 51, 25)[3] > 0, true); // а у wide — доходит до x=51

  // версия 1.7: 64x32
  const old = tmp();
  skins.applySkinPack({ gameDir: old, skin: slimSkin, enable: true, releaseTime: '2013-10-25T00:00:00+00:00', gameLang: false });
  const o = skins.decodePng(fs.readFileSync(path.join(old, 'resourcepacks', 'UnluckySkin', 'assets', 'minecraft', 'textures', 'entity', 'steve.png')));
  assert.equal(o.height, 32);
  assert.match(fs.readFileSync(path.join(old, 'options.txt'), 'utf8'), /resourcePacks:\["UnluckySkin"\]/);

  // отключение удаляет пак
  skins.applySkinPack({ gameDir: dir, skin: slimSkin, enable: false, releaseTime: '2023-06-07T00:00:00+00:00' });
  assert.equal(fs.existsSync(base), false);
});

test('options.txt: несовместимый пак не выкидывается, старый Kubik-пак вычищается, skin: для 1.6–1.7', () => {
  const dir = tmp();
  const f = path.join(dir, 'options.txt');
  fs.writeFileSync(f, 'resourcePacks:["vanilla","file/KubikSkin"]\nincompatibleResourcePacks:["file/Other"]\nskin:Default\n');
  skins.patchOptions(dir, { enable: true, legacyNames: false, incompat: true });
  assert.equal(fs.readFileSync(f, 'utf8'),
    'resourcePacks:["vanilla","file/UnluckySkin"]\nincompatibleResourcePacks:["file/Other","file/UnluckySkin"]\nskin:Default\n');

  // повторный вызов ничего не дублирует и не переписывает файл
  const before = fs.statSync(f).mtimeMs;
  skins.patchOptions(dir, { enable: true, legacyNames: false, incompat: true });
  assert.equal(fs.statSync(f).mtimeMs, before);
  assert.equal(fs.readFileSync(f, 'utf8').match(/UnluckySkin/g).length, 2);

  // отключение убирает пак из обоих списков
  skins.patchOptions(dir, { enable: false, legacyNames: false, incompat: true });
  assert.equal(fs.readFileSync(f, 'utf8'), 'resourcePacks:["vanilla"]\nincompatibleResourcePacks:["file/Other"]\nskin:Default\n');

  // 1.6–1.7: выбранный пак хранится строкой skin:
  const old = tmp();
  skins.patchOptions(old, { enable: true, legacyNames: true, oldSkin: true });
  const t = fs.readFileSync(path.join(old, 'options.txt'), 'utf8');
  assert.match(t, /^resourcePacks:\["UnluckySkin"\]$/m);
  assert.match(t, /^skin:UnluckySkin$/m);
  skins.patchOptions(old, { enable: false, legacyNames: true, oldSkin: true });
  assert.match(fs.readFileSync(path.join(old, 'options.txt'), 'utf8'), /^skin:Default$/m);

  // при отключении без нашего пака чужой options.txt не меняется
  const other = tmp();
  fs.writeFileSync(path.join(other, 'options.txt'), 'fov:90.0\n');
  skins.patchOptions(other, { enable: false, legacyNames: false });
  assert.equal(fs.readFileSync(path.join(other, 'options.txt'), 'utf8'), 'fov:90.0\n');
});

test('pack.mcmeta: широкий supported_formats, новые поля для 1.21.9+, пак от Kubik удаляется', () => {
  const skin = { id: 'x', name: 't', model: 'classic', png: skins.encodePng(SL.makeTemplate('classic'), 64, 64) };
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'resourcepacks', 'KubikSkin'), { recursive: true });
  const r = skins.applySkinPack({ gameDir: dir, skin, enable: true, releaseTime: '2023-06-07T00:00:00+00:00' });
  assert.equal(r.applied, true);
  assert.equal(fs.existsSync(path.join(dir, 'resourcepacks', 'KubikSkin')), false);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'resourcepacks', 'UnluckySkin', 'pack.mcmeta'), 'utf8')).pack;
  assert.equal(meta.pack_format, 4);
  assert.ok(meta.supported_formats.min_inclusive <= 4 && meta.supported_formats.max_inclusive >= 64);
  assert.match(fs.readFileSync(path.join(dir, 'options.txt'), 'utf8'), /incompatibleResourcePacks:\["file\/UnluckySkin"\]/);

  // версия 1.8: без incompat? нет — 2014-09-02 уже 1.8 (список паков), но skin: не нужен
  const v18 = tmp();
  skins.applySkinPack({ gameDir: v18, skin, enable: true, releaseTime: '2014-09-02T00:00:00+00:00' });
  assert.doesNotMatch(fs.readFileSync(path.join(v18, 'options.txt'), 'utf8'), /^skin:/m);
  // 1.7.10 — нужен skin:
  const v17 = tmp();
  skins.applySkinPack({ gameDir: v17, skin, enable: true, releaseTime: '2014-06-26T00:00:00+00:00' });
  assert.match(fs.readFileSync(path.join(v17, 'options.txt'), 'utf8'), /^skin:UnluckySkin$/m);
});
