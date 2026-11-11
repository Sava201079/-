(function () {
  'use strict';
  // Тема: <html data-theme="light|dark">. Предпочтение (light | dark | system) приходит из настроек синхронно
  // через preload, поэтому атрибут ставится до первой отрисовки — без вспышки не той темы.
  // Модуль также отдаёт цвета тем тем, кто рисует на canvas/WebGL и не может брать их из CSS напрямую.
  const root = document.documentElement;
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const subs = [];
  let pref = (window.api && window.api.theme) || 'light';

  const resolve = () => (pref === 'dark' || (pref === 'system' && mq.matches) ? 'dark' : 'light');
  const apply = () => { root.dataset.theme = resolve(); };
  const css = (name) => getComputedStyle(root).getPropertyValue(name).trim();

  const Theme = {
    isDark: () => resolve() === 'dark',
    pref: () => pref,
    /** Применяет предпочтение сразу и сообщает подписчикам. */
    set(p) { pref = ['light', 'dark', 'system'].includes(p) ? p : 'light'; apply(); Theme.notify(); },
    css,
    /** "52, 58, 66" -> [0.2, 0.23, 0.26] */
    rgb01(name, fallback) {
      const m = css(name).match(/[\d.]+/g);
      return m && m.length >= 3 ? m.slice(0, 3).map((n) => Number(n) / 255) : fallback;
    },
    number(name, fallback) { const v = parseFloat(css(name)); return Number.isFinite(v) ? v : fallback; },
    onChange(fn) { subs.push(fn); },
    notify() { subs.slice().forEach((fn) => { try { fn(); } catch (e) { console.warn(e); } }); },
  };
  mq.addEventListener('change', () => { if (pref === 'system') { apply(); Theme.notify(); } });
  apply();
  window.Theme = Theme;
})();
