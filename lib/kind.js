/* منطق مشترک «نوع خروجی»: تشخیص خودکار Word/Excel، تبدیل عدد، و ساخت CSV از مدل سند.
   بدون وابستگی؛ هم در main (require) و هم در رندرر (<script src="lib/kind.js"> ⇒ window.Kind). */
(function (root) {
  'use strict';
  const DIG = { '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9', '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9' };
  const reEsc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  function textOf(blocks) { return (blocks || []).map(b => b.t === 'p' ? (b.runs || []).map(r => r.text || '').join('') : (b.t === 'table' ? (b.rows || []).map(r => (r.cells || []).map(c => textOf(cellBlocks(c))).join(' ')).join(' ') : '')).filter(Boolean).join('\n'); }
  function cellBlocks(c) { return c.blocks && c.blocks.length ? c.blocks : [{ t: 'p', runs: [{ text: c.text === undefined || c.text === null ? '' : String(c.text), b: c.b }], align: c.align }]; }
  // رشته‌ی عددی (ارقام فارسی/عربی، جداکننده‌ی هزارگان، واحد پولِ انتهایی) ⇒ عدد؛ تلفن/کد با صفر ابتدایی و رشته‌های طولانی متن می‌مانند
  function parseNumber(str, unit) {
    let s = String(str).trim(); if (!s || s.length > 30) return null;
    if (unit) { const m = new RegExp('^(.*?)\\s*' + reEsc(unit) + '$').exec(s); if (m) s = m[1].trim(); else unit = ''; }
    s = s.replace(/[۰-۹٠-٩]/g, d => DIG[d]).replace(/[٬,\s]/g, '').replace(/٫/g, '.');
    if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
    if (/^-?0\d/.test(s)) return null; if (s.replace(/[-.]/g, '').length > 15) return null;
    return { n: Number(s), unit: unit || '' };
  }
  // جدول‌محور (فهرست/گزارش) ⇒ xlsx؛ سند (رسید، کارت، قرارداد، کارنامه، نامه) ⇒ docx. hint از طرف فراخواننده در اولویت است.
  function chooseKind(model, hint) {
    if (hint === 'docx' || hint === 'xlsx') return hint;
    let tableText = 0, other = 0, maxCols = 0, tables = 0;
    model.blocks.forEach(b => {
      if (b.t === 'table') { tables++; b.rows.forEach(r => { maxCols = Math.max(maxCols, r.cells.reduce((n, c) => n + (c.colspan || 1), 0)); r.cells.forEach(c => { tableText += textOf(cellBlocks(c)).length; }); }); }
      else if (b.t === 'p') other += (b.runs || []).map(r => (r.text || '').length).reduce((a, c) => a + c, 0);
    });
    const total = tableText + other; if (!tables || !total) return 'docx';
    const rowsN = Math.max(...model.blocks.filter(b => b.t === 'table').map(b => b.rows.length));
    return (tableText / total >= 0.6 && maxCols >= 3 && rowsN >= 2) ? 'xlsx' : 'docx';
  }
  function hasTable(model) { return !!(model && model.blocks && model.blocks.some(b => b.t === 'table' && b.rows && b.rows.length)); }
  // CSV (UTF-8؛ BOM را main اضافه می‌کند تا Excel فارسی را درست بخواند). عددها ماشین‌خوان می‌شوند (ارقام لاتین، بدون جداکننده/واحد).
  function toCsv(model) {
    const q = (v) => { const s = String(v === undefined || v === null ? '' : v); return /[",\r\n;]/.test(s) || /^\s|\s$/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const lines = [], cur = (model && model.currency) || '';
    (model.blocks || []).forEach(b => {
      if (b.t === 'p') { const t = (b.runs || []).map(r => r.text || '').join('').replace(/\s+/g, ' ').trim(); if (t) lines.push(q(t)); }
      else if (b.t === 'table') {
        if (lines.length) lines.push('');
        b.rows.forEach((r, ri) => {
          const isHead = r.header === true || (b.header && ri === 0 && r.header !== false), out = [];
          r.cells.forEach(c => { const txt = textOf(cellBlocks(c)).replace(/[ \t]+/g, ' ').replace(/\n+/g, ' ').trim(); const num = !isHead && !(c.colspan > 1) ? parseNumber(txt, cur) : null; out.push(q(num ? String(num.n) : txt)); for (let k = 1; k < (c.colspan || 1); k++) out.push(''); });
          lines.push(out.join(','));
        });
      }
    });
    return lines.join('\r\n') + '\r\n';
  }
  const PRINT_MODES = ['ask', 'auto', 'docx', 'xlsx', 'pdf', 'png', 'csv', 'html'];   // ask = هر بار بپرس؛ auto = قالب پیشنهادی (Word/Excel)
  const api = { PRINT_MODES, textOf, cellBlocks, parseNumber, chooseKind, hasTable, toCsv };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Kind = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
