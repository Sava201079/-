/*
 * Лёгкий WebGL-просмотрщик скина: персонаж из коробок, воксельная сетка пола, вращение мышью.
 * Без зависимостей. Если WebGL недоступен — рисует плоский вид спереди.
 */
(function () {
  'use strict';
  const SL = window.SkinLayout;

  const m4 = {
    ident() { return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]); },
    mul(a, b) {
      const o = new Float32Array(16);
      for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
        let s = 0;
        for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
        o[c * 4 + r] = s;
      }
      return o;
    },
    persp(fovy, aspect, n, f) {
      const t = 1 / Math.tan(fovy / 2), o = new Float32Array(16);
      o[0] = t / aspect; o[5] = t; o[10] = (f + n) / (n - f); o[11] = -1; o[14] = (2 * f * n) / (n - f);
      return o;
    },
    trans(x, y, z) { const o = m4.ident(); o[12] = x; o[13] = y; o[14] = z; return o; },
    rotX(a) { const c = Math.cos(a), s = Math.sin(a), o = m4.ident(); o[5] = c; o[6] = s; o[9] = -s; o[10] = c; return o; },
    rotY(a) { const c = Math.cos(a), s = Math.sin(a), o = m4.ident(); o[0] = c; o[2] = -s; o[8] = s; o[10] = c; return o; },
  };

  // Вершины граней (порядок: левый-верх, левый-низ, правый-низ, правый-верх, если смотреть снаружи).
  const FACES = [
    { key: 'front',  n: [0, 0, 1],  v: [[-1, 1, 1], [-1, -1, 1], [1, -1, 1], [1, 1, 1]] },
    { key: 'back',   n: [0, 0, -1], v: [[1, 1, -1], [1, -1, -1], [-1, -1, -1], [-1, 1, -1]] },
    { key: 'left',   n: [1, 0, 0],  v: [[1, 1, 1], [1, -1, 1], [1, -1, -1], [1, 1, -1]] },
    { key: 'right',  n: [-1, 0, 0], v: [[-1, 1, -1], [-1, -1, -1], [-1, -1, 1], [-1, 1, 1]] },
    { key: 'top',    n: [0, 1, 0],  v: [[-1, 1, -1], [-1, 1, 1], [1, 1, 1], [1, 1, -1]] },
    { key: 'bottom', n: [0, -1, 0], v: [[-1, -1, 1], [-1, -1, -1], [1, -1, -1], [1, -1, 1]], flipV: true },
  ];

  function buildGeometry(model) {
    const verts = [], idx = [], draws = [];
    for (const b of SL.layout(model)) {
      const start = idx.length;
      const hx = b.w / 2 + b.inflate, hy = b.h / 2 + b.inflate, hz = b.d / 2 + b.inflate;
      const F = SL.boxFaces(b.u, b.v, b.w, b.h, b.d);
      for (const f of FACES) {
        const r = F[f.key];
        const base = verts.length / 8;
        const x0 = r.x / 64, x1 = (r.x + r.w) / 64, y0 = r.y / 64, y1 = (r.y + r.h) / 64;
        const uv = f.flipV ? [[x0, y1], [x0, y0], [x1, y0], [x1, y1]] : [[x0, y0], [x0, y1], [x1, y1], [x1, y0]];
        for (let i = 0; i < 4; i++) {
          verts.push(b.cx + f.v[i][0] * hx, b.cy + f.v[i][1] * hy, f.v[i][2] * hz, f.n[0], f.n[1], f.n[2], uv[i][0], uv[i][1]);
        }
        idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      }
      draws.push({ part: b.part, layer: b.layer, pivot: b.pivot, first: start, count: idx.length - start });
    }
    return { verts: new Float32Array(verts), idx: new Uint16Array(idx), draws };
  }

  const VS = `
    attribute vec3 aPos; attribute vec3 aNormal; attribute vec2 aUv;
    uniform mat4 uMVP; uniform mat4 uRot;
    varying vec2 vUv; varying float vLight;
    void main() {
      vUv = aUv;
      vec3 n = normalize((uRot * vec4(aNormal, 0.0)).xyz);
      vec3 L = normalize(vec3(0.35, 0.8, 0.9));
      vLight = 0.6 + 0.4 * max(dot(n, L), 0.0);
      gl_Position = uMVP * vec4(aPos, 1.0);
    }`;
  const FS = `
    precision mediump float;
    uniform sampler2D uTex; varying vec2 vUv; varying float vLight;
    void main() {
      vec4 c = texture2D(uTex, vUv);
      if (c.a < 0.02) discard;
      gl_FragColor = vec4(c.rgb * vLight * c.a, c.a);
    }`;
  const GVS = `
    attribute vec3 aPos; uniform mat4 uMVP; varying vec3 vPos;
    void main() { vPos = aPos; gl_Position = uMVP * vec4(aPos, 1.0); }`;
  const GFS = `
    precision mediump float; varying vec3 vPos; uniform vec3 uColor; uniform float uAlpha;
    void main() {
      float d = length(vPos.xz);
      float a = uAlpha * (1.0 - smoothstep(14.0, 78.0, d));
      gl_FragColor = vec4(uColor * a, a);
    }`;

  function compile(gl, vs, fs) {
    const mk = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, mk(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    return p;
  }

  class SkinViewer {
    constructor(canvas, opts) {
      this.canvas = canvas;
      this.o = Object.assign({ overlay: true, swing: 0.1, autoRotate: true, grid: true, yaw: -0.55, pitch: 0.22, dist: 92, interactive: true }, opts);
      this.model = 'classic';
      this.source = null;
      this.dirty = false;
      this.yaw = this.o.yaw; this.pitch = this.o.pitch; this.dist = this.o.dist;
      this.dragging = false;
      this.t0 = performance.now();
      this.dead = false;
      this.readTheme();
      if (window.Theme) window.Theme.onChange(() => this.readTheme());
      try { this.initGL(); } catch (e) { console.warn('WebGL недоступен, плоский режим', e); this.gl = null; this.ctx2d = canvas.getContext('2d'); }
      this.bind();
      this.resize();
      this.loop = this.loop.bind(this);
      requestAnimationFrame(this.loop);
    }

    /** Цвет и яркость «пола» зависят от темы: на светлом фоне сетка тёмная, на тёмном — светлая. */
    readTheme() {
      const T = window.Theme;
      this.floor = T ? T.rgb01('--floor-rgb', [0.91, 0.9, 0.88]) : [0.91, 0.9, 0.88];
      this.floorA = T ? T.number('--floor-a', 0.3) : 0.3;
    }

    initGL() {
      const gl = this.canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: true });
      if (!gl) throw new Error('no webgl');
      this.gl = gl;
      this.prog = compile(gl, VS, FS);
      this.gprog = compile(gl, GVS, GFS);
      this.loc = {
        aPos: gl.getAttribLocation(this.prog, 'aPos'), aNormal: gl.getAttribLocation(this.prog, 'aNormal'), aUv: gl.getAttribLocation(this.prog, 'aUv'),
        uMVP: gl.getUniformLocation(this.prog, 'uMVP'), uRot: gl.getUniformLocation(this.prog, 'uRot'), uTex: gl.getUniformLocation(this.prog, 'uTex'),
        gPos: gl.getAttribLocation(this.gprog, 'aPos'), gMVP: gl.getUniformLocation(this.gprog, 'uMVP'), gColor: gl.getUniformLocation(this.gprog, 'uColor'), gAlpha: gl.getUniformLocation(this.gprog, 'uAlpha'),
      };
      this.vbo = gl.createBuffer(); this.ibo = gl.createBuffer();
      this.tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

      // Сетка пола: клетки по 16 единиц (один блок)
      const lines = [];
      for (let i = -5; i <= 5; i++) { lines.push(i * 16, 0, -80, i * 16, 0, 80, -80, 0, i * 16, 80, 0, i * 16); }
      this.gridBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.gridBuf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(lines), gl.STATIC_DRAW);
      this.gridCount = lines.length / 3;
      this.setModel(this.model);
    }

    setModel(model) {
      this.model = model === 'slim' ? 'slim' : 'classic';
      if (!this.gl) return;
      const gl = this.gl;
      this.geo = buildGeometry(this.model);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
      gl.bufferData(gl.ARRAY_BUFFER, this.geo.verts, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, this.geo.idx, gl.STATIC_DRAW);
    }

    /** source — canvas или img с текстурой 64x64. Можно вызывать при каждом изменении. */
    setTexture(source) { this.source = source; this.dirty = true; }
    set(o) { Object.assign(this.o, o); }

    bind() {
      const c = this.canvas;
      this.ro = new ResizeObserver(() => this.resize());
      this.ro.observe(c);
      if (!this.o.interactive) return;
      c.addEventListener('pointerdown', (e) => { this.dragging = true; this.lx = e.clientX; this.ly = e.clientY; c.setPointerCapture(e.pointerId); });
      c.addEventListener('pointermove', (e) => {
        if (!this.dragging) return;
        this.yaw += (e.clientX - this.lx) * 0.011;
        this.pitch = Math.max(0.02, Math.min(1.1, this.pitch + (e.clientY - this.ly) * 0.008));
        this.lx = e.clientX; this.ly = e.clientY;
      });
      const up = () => { this.dragging = false; };
      c.addEventListener('pointerup', up); c.addEventListener('pointercancel', up);
      c.addEventListener('wheel', (e) => { e.preventDefault(); this.dist = Math.max(48, Math.min(150, this.dist * (1 + e.deltaY * 0.001))); }, { passive: false });
      c.addEventListener('dblclick', () => { this.yaw = this.o.yaw; this.pitch = this.o.pitch; this.dist = this.o.dist; });
    }

    resize() {
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr)), h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
      if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    }

    destroy() { this.dead = true; if (this.ro) this.ro.disconnect(); }

    loop(now) {
      if (this.dead) return;
      requestAnimationFrame(this.loop);
      if (!this.canvas.offsetParent || document.hidden) return; // не видно — не рисуем
      const dt = Math.min(0.05, (now - (this.last || now)) / 1000);
      this.last = now;
      if (this.o.autoRotate && !this.dragging) this.yaw += dt * 0.35;
      this.draw((now - this.t0) / 1000);
    }

    draw(t) {
      if (!this.gl) return this.drawFlat();
      const gl = this.gl;
      this.resize();
      if (this.dirty && this.source) {
        gl.bindTexture(gl.TEXTURE_2D, this.tex);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.source);
        this.dirty = false;
      }
      const W = this.canvas.width, H = this.canvas.height;
      gl.viewport(0, 0, W, H);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

      const proj = m4.persp(0.5, W / H, 10, 400);
      const rotView = m4.mul(m4.rotX(this.pitch), m4.rotY(this.yaw));
      const view = m4.mul(m4.trans(0, -1, -this.dist), m4.mul(rotView, m4.trans(0, -16, 0)));
      const vp = m4.mul(proj, view);

      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

      if (this.o.grid) {
        gl.disable(gl.DEPTH_TEST);
        gl.useProgram(this.gprog);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.gridBuf);
        gl.enableVertexAttribArray(this.loc.gPos);
        gl.vertexAttribPointer(this.loc.gPos, 3, gl.FLOAT, false, 12, 0);
        gl.uniformMatrix4fv(this.loc.gMVP, false, vp);
        gl.uniform3f(this.loc.gColor, this.floor[0], this.floor[1], this.floor[2]);
        gl.uniform1f(this.loc.gAlpha, this.floorA);
        gl.drawArrays(gl.LINES, 0, this.gridCount);
      }

      gl.enable(gl.DEPTH_TEST);
      gl.enable(gl.CULL_FACE);
      gl.useProgram(this.prog);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
      const S = 32;
      gl.enableVertexAttribArray(this.loc.aPos); gl.vertexAttribPointer(this.loc.aPos, 3, gl.FLOAT, false, S, 0);
      gl.enableVertexAttribArray(this.loc.aNormal); gl.vertexAttribPointer(this.loc.aNormal, 3, gl.FLOAT, false, S, 12);
      gl.enableVertexAttribArray(this.loc.aUv); gl.vertexAttribPointer(this.loc.aUv, 2, gl.FLOAT, false, S, 24);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.uniform1i(this.loc.uTex, 0);

      const swing = this.o.swing * Math.sin(t * 2.2);
      const angle = { rightArm: swing, leftArm: -swing, rightLeg: -swing, leftLeg: swing };
      for (const layer of ['base', 'overlay']) {
        if (layer === 'overlay' && !this.o.overlay) continue;
        for (const d of this.geo.draws) {
          if (d.layer !== layer) continue;
          let model = m4.ident(), rot = rotView;
          const a = angle[d.part];
          if (d.pivot && a) {
            const p = d.pivot;
            model = m4.mul(m4.trans(p[0], p[1], p[2]), m4.mul(m4.rotX(a), m4.trans(-p[0], -p[1], -p[2])));
            rot = m4.mul(rotView, m4.rotX(a));
          }
          gl.uniformMatrix4fv(this.loc.uMVP, false, m4.mul(vp, model));
          gl.uniformMatrix4fv(this.loc.uRot, false, rot);
          gl.drawElements(gl.TRIANGLES, d.count, gl.UNSIGNED_SHORT, d.first * 2);
        }
      }
      gl.disable(gl.CULL_FACE);
    }

    /** Запасной вариант без WebGL: вид спереди. */
    drawFlat() {
      const ctx = this.ctx2d; if (!ctx || !this.source) return;
      this.resize();
      const W = this.canvas.width, H = this.canvas.height;
      ctx.clearRect(0, 0, W, H);
      ctx.imageSmoothingEnabled = false;
      const s = Math.floor(Math.min(W / 18, H / 34));
      const ox = Math.floor((W - 16 * s) / 2), oy = Math.floor((H - 32 * s) / 2);
      const armW = this.model === 'slim' ? 3 : 4;
      const draw = (sx, sy, sw, sh, dx, dy) => ctx.drawImage(this.source, sx, sy, sw, sh, ox + dx * s, oy + dy * s, sw * s, sh * s);
      const pass = (ov) => {
        draw(ov ? 40 : 8, 8, 8, 8, 4, 0);
        draw(20, ov ? 36 : 20, 8, 12, 4, 8);
        draw(44, ov ? 36 : 20, armW, 12, 4 - armW, 8);
        draw(ov ? 52 : 36, 52, armW, 12, 12, 8);
        draw(4, ov ? 36 : 20, 4, 12, 4, 20);
        draw(ov ? 4 : 20, 52, 4, 12, 8, 20);
      };
      pass(false);
      if (this.o.overlay) pass(true);
    }
  }

  window.SkinViewer = SkinViewer;
})();
