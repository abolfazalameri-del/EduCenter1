'use strict';
const assert = require('assert'); const T = require('../lib/themes.js');
let pass = 0, fail = 0; const t = (n, f) => { try { f(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + e.message); } };
console.log('— Colour palettes');
t('at least 16 ready palettes with unique ids/labels/colours; all dark enough for white text (contrast ≥ 4.5)', () => {
  assert(T.PALETTES.length >= 16); for (const k of ['id', 'label', 'c']) assert.strictEqual(new Set(T.PALETTES.map(p => p[k])).size, T.PALETTES.length, k + ' unique');
  T.PALETTES.forEach(p => { assert(/^#[0-9a-f]{6}$/.test(p.c), p.id); assert((1.05) / (T.lum(p.c) + 0.05) >= 4.5, p.id + ' contrast ' + (1.05 / (T.lum(p.c) + 0.05)).toFixed(2)); });
  ['navy', 'green', 'teal', 'purple', 'maroon', 'slate'].forEach(id => assert(T.PALETTES.some(p => p.id === id), 'legacy palette kept: ' + id));
});
t('isValid: known ids, empty (= reset), custom hex; rejects everything else (injection, short hex, unknown)', () => {
  for (const ok of ['', null, undefined, 'navy', 'emerald', 'custom:#7a1fa2', 'custom:#ABCDEF']) assert.strictEqual(T.isValid(ok), true, String(ok));
  for (const bad of ['nope', 'custom:#fff', 'custom:#zzzzzz', 'custom:red', '#7a1fa2', 'custom:#7a1fa2;}body{display:none', '<script>', 'NAVY', 'custom:#7a1fa2 ', 123, {}]) assert.strictEqual(T.isValid(bad), false, JSON.stringify(bad));
});
t('resolve: palette colour, custom colour (light colours are darkened until readable), null for junk', () => {
  assert.strictEqual(T.resolve('green'), '#14532d'); assert.strictEqual(T.resolve('custom:#102030'), '#102030'); assert.strictEqual(T.resolve('x'), null); assert.strictEqual(T.resolve(''), null);
  const light = T.resolve('custom:#ffff00'); assert(light !== '#ffff00' && T.lum(light) <= 0.18 + 1e-9 && 1.05 / (T.lum(light) + 0.05) >= 4.5, light); assert.strictEqual(T.resolve('custom:#ffffff') !== '#ffffff', true);
});
t('scale: navy-2/navy-3 are progressively lighter than the base', () => { const s = T.scale('#152341'); assert(T.lum(s.navy) < T.lum(s.navy2) && T.lum(s.navy2) < T.lum(s.navy3)); assert.strictEqual(T.mix('#000000', '#ffffff', 0.5), '#808080'); });
console.log('\n' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
