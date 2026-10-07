/* پالت‌های رنگی: فهرست آماده + رنگ دلخواه (custom:#rrggbb). مشترک بین main (اعتبارسنجی) و رندرر (نمایش).
   کل ظاهر برنامه با سه متغیر --navy / --navy-2 / --navy-3 ساخته می‌شود؛ پس هر پالت فقط یک رنگ پایه‌ی تیره دارد. */
(function (root) {
  'use strict';
  const PALETTES = [
    { id: 'navy', label: 'سرمه‌ای', c: '#152341' }, { id: 'blue', label: 'آبی', c: '#1e3a8a' }, { id: 'indigo', label: 'نیلی', c: '#312e81' },
    { id: 'cyan', label: 'آبی‌روشن', c: '#155e75' }, { id: 'teal', label: 'فیروزه‌ای', c: '#0f4c5c' }, { id: 'emerald', label: 'زمردی', c: '#065f46' },
    { id: 'green', label: 'سبز', c: '#14532d' }, { id: 'olive', label: 'زیتونی', c: '#3f4f1c' }, { id: 'gold', label: 'طلایی', c: '#7a5c0a' },
    { id: 'orange', label: 'نارنجی', c: '#9a3412' }, { id: 'red', label: 'قرمز', c: '#991b1b' }, { id: 'maroon', label: 'عنابی', c: '#5c1a1b' },
    { id: 'rose', label: 'گل‌سرخی', c: '#9d174d' }, { id: 'purple', label: 'بنفش', c: '#3b1f5e' }, { id: 'plum', label: 'آلویی', c: '#6b21a8' },
    { id: 'brown', label: 'قهوه‌ای', c: '#4e342e' }, { id: 'slate', label: 'خاکستری‌آبی', c: '#263238' }, { id: 'charcoal', label: 'ذغالی', c: '#1f2937' }
  ];
  const HEX = /^#[0-9a-fA-F]{6}$/, CUSTOM = /^custom:(#[0-9a-fA-F]{6})$/;
  function mix(a, b, t) { const x = parseInt(a.slice(1), 16), y = parseInt(b.slice(1), 16); let o = 0; [16, 8, 0].forEach(sh => { const ca = (x >> sh) & 255, cb = (y >> sh) & 255; o = (o << 8) | Math.round(ca + (cb - ca) * t); }); return '#' + ('000000' + o.toString(16)).slice(-6); }
  function lum(hex) { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; const n = parseInt(hex.slice(1), 16); return 0.2126 * f((n >> 16) & 255) + 0.7152 * f((n >> 8) & 255) + 0.0722 * f(n & 255); }
  // رنگ روشن را آن‌قدر تیره می‌کند که متن سفید روی آن خوانا بماند (کنتراست ≥ 4.5)
  function readable(hex) { let c = hex.toLowerCase(), t = 0; while (lum(c) > 0.18 && t < 1) { t += 0.05; c = mix(hex.toLowerCase(), '#000000', t); } return c; }
  function isValid(id) { if (id === '' || id === null || id === undefined) return true; id = String(id); return PALETTES.some(p => p.id === id) || CUSTOM.test(id); }
  function resolve(id) { id = String(id || ''); const p = PALETTES.find(q => q.id === id); if (p) return p.c; const m = CUSTOM.exec(id); return m ? readable(m[1]) : null; }
  function scale(c) { return { navy: c, navy2: mix(c, '#ffffff', 0.08), navy3: mix(c, '#ffffff', 0.16) }; }
  const api = { PALETTES, isValid, resolve, scale, mix, lum, readable };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Themes = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
