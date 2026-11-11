/*
 * Раскладка текстуры скина Minecraft (64x64) и операции над ней.
 * Модуль работает и в Node (main-процесс, тесты), и в браузере (window.SkinLayout).
 * Все функции работают с «сырым» RGBA-буфером (Uint8Array / Uint8ClampedArray / Buffer).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SkinLayout = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SIZE = 64;

  // Части тела. u/v — начало базового слоя, ou/ov — начало внешнего слоя.
  // cx/cy — центр части в «пикселях модели» (персонаж высотой 32, ноги стоят на y = 0).
  const PARTS = [
    { id: 'head',     name: 'Голова',    u: 0,  v: 0,  w: 8, h: 8,  d: 8, ou: 32, ov: 0,  cx: 0,  cy: 28, inflate: 0.5,  pivot: null },
    { id: 'body',     name: 'Тело',      u: 16, v: 16, w: 8, h: 12, d: 4, ou: 16, ov: 32, cx: 0,  cy: 18, inflate: 0.25, pivot: null },
    { id: 'rightArm', name: 'Пр. рука',  u: 40, v: 16, w: 4, h: 12, d: 4, ou: 40, ov: 32, cx: -6, cy: 18, inflate: 0.25, pivot: [-6, 24, 0], arm: true },
    { id: 'leftArm',  name: 'Лев. рука', u: 32, v: 48, w: 4, h: 12, d: 4, ou: 48, ov: 48, cx: 6,  cy: 18, inflate: 0.25, pivot: [6, 24, 0],  arm: true },
    { id: 'rightLeg', name: 'Пр. нога',  u: 0,  v: 16, w: 4, h: 12, d: 4, ou: 0,  ov: 32, cx: -2, cy: 6,  inflate: 0.25, pivot: [-2, 12, 0] },
    { id: 'leftLeg',  name: 'Лев. нога', u: 16, v: 48, w: 4, h: 12, d: 4, ou: 0,  ov: 48, cx: 2,  cy: 6,  inflate: 0.25, pivot: [2, 12, 0] },
  ];

  /** Прямоугольники шести граней коробки в текстуре. */
  function boxFaces(u, v, w, h, d) {
    return {
      top:    { x: u + d,         y: v,     w: w, h: d },
      bottom: { x: u + d + w,     y: v,     w: w, h: d },
      right:  { x: u,             y: v + d, w: d, h: h },
      front:  { x: u + d,         y: v + d, w: w, h: h },
      left:   { x: u + d + w,     y: v + d, w: d, h: h },
      back:   { x: u + 2 * d + w, y: v + d, w: w, h: h },
    };
  }

  /**
   * Список коробок для рендера и разметки.
   * model: 'classic' (руки 4px) | 'slim' (руки 3px)
   */
  function layout(model) {
    const slim = model === 'slim';
    const out = [];
    for (const p of PARTS) {
      const w = p.arm && slim ? 3 : p.w;
      let cx = p.cx;
      if (p.arm && slim) cx = p.cx < 0 ? p.cx + 0.5 : p.cx - 0.5;
      const pivot = p.pivot;
      out.push({ part: p.id, name: p.name, layer: 'base',    u: p.u,  v: p.v,  w, h: p.h, d: p.d, cx, cy: p.cy, inflate: 0, pivot });
      out.push({ part: p.id, name: p.name, layer: 'overlay', u: p.ou, v: p.ov, w, h: p.h, d: p.d, cx, cy: p.cy, inflate: p.inflate, pivot });
    }
    return out;
  }

  /** Все грани, занятые моделью (для разметки и маски). */
  function regions(model) {
    const res = [];
    for (const b of layout(model)) {
      const f = boxFaces(b.u, b.v, b.w, b.h, b.d);
      for (const k of Object.keys(f)) res.push(Object.assign({ part: b.part, name: b.name, layer: b.layer, face: k }, f[k]));
    }
    return res;
  }

  /** Маска используемых текселей: 1 — часть модели, 0 — пустое место. */
  function mask(model) {
    const m = new Uint8Array(SIZE * SIZE);
    for (const r of regions(model)) {
      for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) m[y * SIZE + x] = 1;
    }
    return m;
  }

  /** Грань, в которую попадает текcель (или null). Приоритет — последняя (внешний слой). */
  function faceAt(model, x, y) {
    let found = null;
    for (const r of regions(model)) {
      if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) found = r;
    }
    return found;
  }

  // ---------- Работа с буфером ----------

  function newBuffer(w, h) { return new Uint8ClampedArray((w || SIZE) * (h || SIZE) * 4); }

  function px(buf, x, y, rgba, width) {
    const i = (y * (width || SIZE) + x) * 4;
    buf[i] = rgba[0]; buf[i + 1] = rgba[1]; buf[i + 2] = rgba[2]; buf[i + 3] = rgba.length > 3 ? rgba[3] : 255;
  }

  function fillRect(buf, x, y, w, h, rgba) {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) px(buf, xx, yy, rgba);
  }

  function hex(c) {
    const n = parseInt(c.replace('#', ''), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255];
  }

  // ---------- Старый формат 64x32 -> 64x64 ----------

  /** Повторяет Mojang'овский processLegacySkin: зеркалит правые руку и ногу в левые. */
  function upgradeLegacy(src) {
    const dst = newBuffer(SIZE, SIZE);
    dst.set(src.subarray(0, SIZE * 32 * 4), 0);

    // «Хак Нотча»: если во внешнем слое головы нет прозрачности — убираем её целиком.
    let hasAlpha = false;
    for (let y = 0; y < 16 && !hasAlpha; y++) for (let x = 32; x < 64; x++) if (dst[(y * SIZE + x) * 4 + 3] < 128) { hasAlpha = true; break; }
    if (!hasAlpha) for (let y = 0; y < 16; y++) for (let x = 32; x < 64; x++) dst[(y * SIZE + x) * 4 + 3] = 0;

    const copyRect = (sx, sy, ox, oy, w, h) => {
      for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
        const s = ((sy + yy) * SIZE + (sx + xx)) * 4;
        const dx = sx + ox + (w - 1 - xx), dy = sy + oy + yy;
        const d = (dy * SIZE + dx) * 4;
        dst[d] = dst[s]; dst[d + 1] = dst[s + 1]; dst[d + 2] = dst[s + 2]; dst[d + 3] = dst[s + 3];
      }
    };
    copyRect(4, 16, 16, 32, 4, 4);
    copyRect(8, 16, 16, 32, 4, 4);
    copyRect(0, 20, 24, 32, 4, 12);
    copyRect(4, 20, 16, 32, 4, 12);
    copyRect(8, 20, 8, 32, 4, 12);
    copyRect(12, 20, 16, 32, 4, 12);
    copyRect(44, 16, -8, 32, 4, 4);
    copyRect(48, 16, -8, 32, 4, 4);
    copyRect(40, 20, 0, 32, 4, 12);
    copyRect(44, 20, -8, 32, 4, 12);
    copyRect(48, 20, -16, 32, 4, 12);
    copyRect(52, 20, -8, 32, 4, 12);
    return dst;
  }

  // ---------- classic <-> slim ----------

  function resampleCols(srcCols, dstW) {
    // srcCols.length -> dstW столбцов, симметричная выборка
    const n = srcCols.length, res = [];
    for (let i = 0; i < dstW; i++) {
      let s = Math.floor(((i + 0.5) * n) / dstW);
      if (dstW < n && n === 4 && dstW === 3) s = [0, 2, 3][i];
      res.push(srcCols[Math.min(n - 1, s)]);
    }
    return res;
  }

  function readRect(buf, r) {
    const cols = [];
    for (let x = 0; x < r.w; x++) {
      const col = [];
      for (let y = 0; y < r.h; y++) {
        const i = ((r.y + y) * SIZE + (r.x + x)) * 4;
        col.push([buf[i], buf[i + 1], buf[i + 2], buf[i + 3]]);
      }
      cols.push(col);
    }
    return cols;
  }

  function writeCols(buf, x0, y0, cols) {
    for (let x = 0; x < cols.length; x++) for (let y = 0; y < cols[x].length; y++) {
      px(buf, x0 + x, y0 + y, cols[x][y]);
    }
  }

  /** Преобразует ширину рук скина: from/to — 'classic' | 'slim'. Возвращает новую копию. */
  function convertArms(buf, from, to) {
    const out = new Uint8ClampedArray(buf);
    if (from === to) return out;
    const wFrom = from === 'slim' ? 3 : 4, wTo = to === 'slim' ? 3 : 4;
    const boxes = [[40, 16], [40, 32], [32, 48], [48, 48]];
    for (const [u, v] of boxes) {
      const a = boxFaces(u, v, wFrom, 12, 4);
      const faces = {};
      for (const k of Object.keys(a)) faces[k] = readRect(out, a[k]);
      // очищаем всю область коробки
      fillRect(out, u, v, 2 * 4 + 2 * 4, 16, [0, 0, 0, 0]);
      const b = boxFaces(u, v, wTo, 12, 4);
      for (const k of Object.keys(b)) {
        let cols = faces[k];
        if (k === 'top' || k === 'bottom' || k === 'front' || k === 'back') cols = resampleCols(cols, wTo);
        writeCols(out, b[k].x, b[k].y, cols);
      }
    }
    return out;
  }

  /** Обрезает 64x64 до 64x32 (для версий до 1.8). */
  function toLegacy(buf) { return new Uint8ClampedArray(buf.subarray(0, SIZE * 32 * 4)); }

  // ---------- Шаблон нового скина (оригинальный, не копия стандартных скинов) ----------

  function makeTemplate(model) {
    const buf = newBuffer();
    const skin = hex('#f0c7a2'), skinShade = hex('#dcae88');
    const hair = hex('#3a2a22'), hairLight = hex('#4b372c');
    const shirt = hex('#2f7f86'), shirtDark = hex('#27696f'), shirtLight = hex('#3a929a');
    const pants = hex('#3a4670'), pantsDark = hex('#30395c');
    const shoes = hex('#24262b');
    const slim = model === 'slim';
    const L = layout(model).filter(b => b.layer === 'base');
    const by = {}; for (const b of L) by[b.part] = boxFaces(b.u, b.v, b.w, b.h, b.d);

    const paint = (rect, color) => fillRect(buf, rect.x, rect.y, rect.w, rect.h, color);

    // Голова
    const hd = by.head;
    for (const k of ['right', 'front', 'left', 'back', 'top', 'bottom']) paint(hd[k], skin);
    paint(hd.top, hair); paint(hd.back, hair);
    // волосы по бокам: сзади (правая сторона — слева в текстуре, левая — справа), симметрично
    fillRect(buf, hd.right.x, hd.right.y, 8, 3, hair); fillRect(buf, hd.right.x, hd.right.y + 3, 3, 2, hair);
    fillRect(buf, hd.left.x, hd.left.y, 8, 3, hair); fillRect(buf, hd.left.x + 5, hd.left.y + 3, 3, 2, hair);
    fillRect(buf, hd.front.x, hd.front.y, 8, 2, hair);
    fillRect(buf, hd.front.x, hd.front.y + 2, 1, 1, hair); fillRect(buf, hd.front.x + 7, hd.front.y + 2, 1, 1, hair);
    px(buf, hd.front.x + 1, hd.front.y + 4, hex('#ffffff')); px(buf, hd.front.x + 2, hd.front.y + 4, hex('#2b4a8a'));
    px(buf, hd.front.x + 5, hd.front.y + 4, hex('#2b4a8a')); px(buf, hd.front.x + 6, hd.front.y + 4, hex('#ffffff'));
    fillRect(buf, hd.front.x + 3, hd.front.y + 6, 2, 1, hex('#b0695a'));
    paint(hd.bottom, skinShade);
    px(buf, hd.top.x + 2, hd.top.y + 3, hairLight); px(buf, hd.top.x + 5, hd.top.y + 2, hairLight);

    // Тело
    const bd = by.body;
    for (const k of ['right', 'front', 'left', 'back']) paint(bd[k], shirt);
    paint(bd.top, shirtLight); paint(bd.bottom, shirtDark);
    fillRect(buf, bd.front.x + 2, bd.front.y + 7, 4, 4, shirtDark);
    fillRect(buf, bd.front.x + 3, bd.front.y, 2, 1, skinShade);

    // Руки
    for (const id of ['rightArm', 'leftArm']) {
      const a = by[id];
      for (const k of ['right', 'front', 'left', 'back']) { paint(a[k], shirt); fillRect(buf, a[k].x, a[k].y + 9, a[k].w, 3, skin); }
      paint(a.top, shirtLight); paint(a.bottom, skin);
    }

    // Ноги
    for (const id of ['rightLeg', 'leftLeg']) {
      const l = by[id];
      for (const k of ['right', 'front', 'left', 'back']) { paint(l[k], pants); fillRect(buf, l[k].x, l[k].y + 10, l[k].w, 2, shoes); }
      paint(l.top, pantsDark); paint(l.bottom, shoes);
    }
    void slim;
    return buf;
  }

  return {
    SIZE, PARTS, boxFaces, layout, regions, mask, faceAt,
    newBuffer, upgradeLegacy, convertArms, toLegacy, makeTemplate,
  };
});
