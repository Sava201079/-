/*
 * Пиксельный редактор текстуры скина 64x64.
 * Рисует на скрытом холсте-текстуре, показывает увеличенную копию + слой с разметкой.
 */
(function () {
  'use strict';
  const SL = window.SkinLayout;
  const N = 64;
  const MAX_HISTORY = 80;

  function hexToRgb(h) {
    const m = /^#?([0-9a-f]{6})$/i.exec(h || '');
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const rgbToHex = (r, g, b) => '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');

  class SkinEditor {
    /**
     * els: { stage, view, guides } — контейнер и два canvas (рисунок и разметка поверх него)
     * cb: { onChange(), onPick(hex), onHistory({canUndo, canRedo}), onTexture(canvas) }
     */
    constructor(els, cb) {
      this.els = els;
      this.cb = cb || {};
      this.model = 'classic';
      this.tool = 'pencil';
      this.brush = 1;
      this.color = [84, 194, 169];
      this.showGuides = true;
      this.showGrid = true;
      this.readColors();

      this.tex = document.createElement('canvas');
      this.tex.width = this.tex.height = N;
      this.tctx = this.tex.getContext('2d', { willReadFrequently: true });
      this.data = this.tctx.createImageData(N, N);
      this.hist = []; this.hi = -1;
      this.mask = SL.mask(this.model);
      this.hover = null;
      this.scale = 7;
      this.vctx = els.view.getContext('2d');
      this.gctx = els.guides.getContext('2d');

      this.bind();
      this.ro = new ResizeObserver(() => this.layout());
      this.ro.observe(els.stage);
      this.layout();
    }

    // ------------------------------------------------------------ загрузка / выгрузка

    load(src, model) {
      return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          this.tctx.clearRect(0, 0, N, N);
          this.tctx.drawImage(img, 0, 0, N, N);
          this.data = this.tctx.getImageData(0, 0, N, N);
          if (model) this.setModel(model, true);
          this.hist = [new Uint8ClampedArray(this.data.data)]; this.hi = 0;
          this.emitHistory();
          this.renderAll();
          if (this.cb.onTexture) this.cb.onTexture(this.tex);
          resolve();
        };
        img.onerror = () => reject(new Error('Не удалось прочитать скин'));
        img.src = src;
      });
    }

    toDataURL() { this.tctx.putImageData(this.data, 0, 0); return this.tex.toDataURL('image/png'); }

    setModel(model, silent) {
      this.model = model === 'slim' ? 'slim' : 'classic';
      this.mask = SL.mask(this.model);
      this.guideDirty = true;
      if (!silent) this.renderAll();
    }

    setTool(t) { this.tool = t; }
    setBrush(n) { this.brush = n; }
    setColor(hex) { const c = hexToRgb(hex); if (c) this.color = c; }
    getColorHex() { return rgbToHex(...this.color); }
    setGuides(v) { this.showGuides = v; this.guideDirty = true; this.renderGuides(); }
    setGrid(v) { this.showGrid = v; this.guideDirty = true; this.renderGuides(); }

    // ------------------------------------------------------------ размеры

    layout() {
      const { stage, view, guides } = this.els;
      const w = stage.clientWidth, h = stage.clientHeight;
      const scale = Math.max(4, Math.floor(Math.min(w, h) / N));
      this.scale = scale;
      const dpr = window.devicePixelRatio || 1;
      this.k = scale * dpr;
      const css = N * scale;
      for (const c of [view, guides]) {
        c.style.width = css + 'px'; c.style.height = css + 'px';
        c.width = Math.round(css * dpr); c.height = Math.round(css * dpr);
      }
      this.guideDirty = true;
      this.renderAll();
    }

    // ------------------------------------------------------------ рисование

    inMask(x, y) { return x >= 0 && y >= 0 && x < N && y < N && this.mask[y * N + x] === 1; }

    setPx(x, y, rgba) {
      if (!this.inMask(x, y)) return false;
      const d = this.data.data, i = (y * N + x) * 4;
      if (d[i] === rgba[0] && d[i + 1] === rgba[1] && d[i + 2] === rgba[2] && d[i + 3] === rgba[3]) return false;
      d[i] = rgba[0]; d[i + 1] = rgba[1]; d[i + 2] = rgba[2]; d[i + 3] = rgba[3];
      return true;
    }

    stamp(x, y, rgba) {
      const n = this.brush, o = Math.floor(n / 2);
      let ch = false;
      for (let dy = 0; dy < n; dy++) for (let dx = 0; dx < n; dx++) ch = this.setPx(x - o + dx, y - o + dy, rgba) || ch;
      return ch;
    }

    line(x0, y0, x1, y1, rgba) {
      let ch = false;
      const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
      let err = dx + dy;
      for (;;) {
        ch = this.stamp(x0, y0, rgba) || ch;
        if (x0 === x1 && y0 === y1) break;
        const e2 = 2 * err;
        if (e2 >= dy) { err += dy; x0 += sx; }
        if (e2 <= dx) { err += dx; y0 += sy; }
      }
      return ch;
    }

    fill(x, y, rgba) {
      const face = SL.faceAt(this.model, x, y);
      if (!face) return false;
      const d = this.data.data;
      const at = (px, py) => { const i = (py * N + px) * 4; return [d[i], d[i + 1], d[i + 2], d[i + 3]]; };
      const same = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
      const target = at(x, y);
      if (same(target, rgba)) return false;
      const stack = [[x, y]];
      let ch = false;
      while (stack.length) {
        const [px, py] = stack.pop();
        if (px < face.x || py < face.y || px >= face.x + face.w || py >= face.y + face.h) continue;
        if (!same(at(px, py), target)) continue;
        this.setPx(px, py, rgba); ch = true;
        stack.push([px + 1, py], [px - 1, py], [px, py + 1], [px, py - 1]);
      }
      return ch;
    }

    pick(x, y) {
      if (!this.inMask(x, y)) return;
      const d = this.data.data, i = (y * N + x) * 4;
      if (d[i + 3] === 0) return;
      this.color = [d[i], d[i + 1], d[i + 2]];
      if (this.cb.onPick) this.cb.onPick(this.getColorHex());
    }

    cell(e) {
      const r = this.els.guides.getBoundingClientRect();
      return [Math.floor(((e.clientX - r.left) / r.width) * N), Math.floor(((e.clientY - r.top) / r.height) * N)];
    }

    bind() {
      const g = this.els.guides;
      g.addEventListener('contextmenu', (e) => e.preventDefault());
      g.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 && e.button !== 2) return;
        g.setPointerCapture(e.pointerId);
        const [x, y] = this.cell(e);
        let tool = e.button === 2 ? 'eraser' : this.tool;
        if (e.altKey && e.button === 0) tool = 'picker';
        this.stroke = { tool, lx: x, ly: y, changed: false };
        const rgba = tool === 'eraser' ? [0, 0, 0, 0] : [...this.color, 255];
        if (tool === 'picker') { this.pick(x, y); this.stroke = null; return; }
        if (tool === 'fill') this.stroke.changed = this.fill(x, y, rgba);
        else this.stroke.changed = this.stamp(x, y, rgba);
        this.renderTexture();
      });
      g.addEventListener('pointermove', (e) => {
        const [x, y] = this.cell(e);
        this.hover = [x, y];
        if (this.stroke && (this.stroke.tool === 'pencil' || this.stroke.tool === 'eraser')) {
          const rgba = this.stroke.tool === 'eraser' ? [0, 0, 0, 0] : [...this.color, 255];
          if (this.line(this.stroke.lx, this.stroke.ly, x, y, rgba)) this.stroke.changed = true;
          this.stroke.lx = x; this.stroke.ly = y;
          this.renderTexture();
        }
        this.renderHover();
      });
      g.addEventListener('pointerleave', () => { this.hover = null; this.renderHover(); });
      const end = () => { if (this.stroke) { if (this.stroke.changed) this.commit(); this.stroke = null; } };
      g.addEventListener('pointerup', end); g.addEventListener('pointercancel', end);
    }

    // ------------------------------------------------------------ история

    commit() {
      const snap = new Uint8ClampedArray(this.data.data);
      this.hist = this.hist.slice(0, this.hi + 1);
      this.hist.push(snap);
      if (this.hist.length > MAX_HISTORY) this.hist.shift();
      this.hi = this.hist.length - 1;
      this.emitHistory();
      if (this.cb.onChange) this.cb.onChange();
    }

    restore() {
      this.data.data.set(this.hist[this.hi]);
      this.emitHistory();
      this.renderTexture();
      if (this.cb.onChange) this.cb.onChange();
    }

    undo() { if (this.hi > 0) { this.hi--; this.restore(); } }
    redo() { if (this.hi < this.hist.length - 1) { this.hi++; this.restore(); } }
    emitHistory() { if (this.cb.onHistory) this.cb.onHistory({ canUndo: this.hi > 0, canRedo: this.hi < this.hist.length - 1 }); }

    // ------------------------------------------------------------ отрисовка

    /** Цвета разметки берём из CSS-переменных темы. */
    readColors() {
      const T = window.Theme, v = (n, d) => (T ? T.css(n) : '') || d;
      this.colors = {
        mask: v('--ed-mask', 'rgba(14,16,20,0.78)'), grid: v('--ed-grid', 'rgba(255,255,255,0.07)'),
        guide: v('--ed-guide', 'rgba(255,255,255,0.42)'), guideOver: v('--ed-guide-over', 'rgba(84,194,169,0.75)'),
        label: v('--ed-label', 'rgba(255,255,255,0.88)'), labelOver: v('--ed-label-over', 'rgba(130,225,205,0.95)'),
        halo: v('--ed-halo', 'rgba(0,0,0,0.85)'), hover: v('--ed-hover', 'rgba(255,255,255,0.95)'),
      };
    }

    /** Тема сменилась — перечитываем цвета и перерисовываем разметку. */
    refreshTheme() { this.readColors(); this.guideDirty = true; this.renderGuides(); }

    renderAll() { this.renderTexture(); this.renderGuides(); }

    renderTexture() {
      this.tctx.putImageData(this.data, 0, 0);
      const c = this.vctx, size = this.els.view.width;
      c.clearRect(0, 0, size, size);
      c.imageSmoothingEnabled = false;
      c.drawImage(this.tex, 0, 0, N, N, 0, 0, size, size);
      if (this.cb.onTexture) this.cb.onTexture(this.tex);
    }

    buildGuides() {
      const k = this.k, size = Math.round(N * k);
      const cv = document.createElement('canvas'); cv.width = cv.height = size;
      const c = cv.getContext('2d');
      // пустые области, не входящие в модель
      c.fillStyle = this.colors.mask;
      for (let y = 0; y < N; y++) {
        let x = 0;
        while (x < N) {
          if (this.mask[y * N + x]) { x++; continue; }
          let x2 = x; while (x2 < N && !this.mask[y * N + x2]) x2++;
          c.fillRect(Math.round(x * k), Math.round(y * k), Math.round(x2 * k) - Math.round(x * k), Math.round((y + 1) * k) - Math.round(y * k));
          x = x2;
        }
      }
      if (this.showGrid && this.scale >= 6) {
        c.strokeStyle = this.colors.grid; c.lineWidth = 1; c.beginPath();
        for (let i = 1; i < N; i++) { const p = Math.round(i * k) + 0.5; c.moveTo(p, 0); c.lineTo(p, size); c.moveTo(0, p); c.lineTo(size, p); }
        c.stroke();
      }
      if (this.showGuides) {
        const dpr = window.devicePixelRatio || 1;
        for (const r of SL.regions(this.model)) {
          const x = Math.round(r.x * k) + 0.5, y = Math.round(r.y * k) + 0.5;
          const w = Math.round(r.w * k) - 1, h = Math.round(r.h * k) - 1;
          c.setLineDash(r.layer === 'overlay' ? [4 * dpr, 3 * dpr] : []);
          c.strokeStyle = r.layer === 'overlay' ? this.colors.guideOver : this.colors.guide;
          c.lineWidth = 1;
          c.strokeRect(x, y, w, h);
          if (r.face === 'front') this.label(c, r, k, dpr);
        }
        c.setLineDash([]);
      }
      this.guideCache = cv; this.guideDirty = false;
    }

    label(c, r, k, dpr) {
      const text = r.name;
      c.save();
      c.font = `500 ${Math.round(10.5 * dpr)}px Onest, "Segoe UI", sans-serif`;
      c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillStyle = r.layer === 'overlay' ? this.colors.labelOver : this.colors.label;
      c.shadowColor = this.colors.halo; c.shadowBlur = 3 * dpr;
      const cx = (r.x + r.w / 2) * k, cy = (r.y + r.h / 2) * k;
      const fitsH = c.measureText(text).width < r.w * k - 6 * dpr;
      if (fitsH) c.fillText(text, cx, cy);
      else { c.translate(cx, cy); c.rotate(-Math.PI / 2); c.fillText(text, 0, 0); }
      c.restore();
    }

    renderGuides() {
      if (this.guideDirty || !this.guideCache) this.buildGuides();
      this.renderHover();
    }

    renderHover() {
      const c = this.gctx, g = this.els.guides;
      c.clearRect(0, 0, g.width, g.height);
      if (this.guideCache) c.drawImage(this.guideCache, 0, 0);
      if (!this.hover) return;
      const [x, y] = this.hover;
      if (!this.inMask(x, y)) return;
      const n = this.tool === 'fill' || this.tool === 'picker' ? 1 : this.brush, o = Math.floor(n / 2), k = this.k;
      c.strokeStyle = this.colors.hover; c.lineWidth = Math.max(1, Math.round(k / 8));
      c.strokeRect(Math.round((x - o) * k) + 0.5, Math.round((y - o) * k) + 0.5, Math.round(n * k) - 1, Math.round(n * k) - 1);
    }
  }

  window.SkinEditor = SkinEditor;
  window.SkinEditor.hexToRgb = hexToRgb;
})();
