'use strict';
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path'), { spawnSync } = require('child_process');
const O = require('../lib/office.js');
let pass = 0, fail = 0; const t = (n, f) => { try { f(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + e.message); } };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'office-')); let seq = 0;
const P = (text, x) => Object.assign({ t: 'p', runs: [{ text }] }, x || {});
const T = (rows, x) => Object.assign({ t: 'table', header: true, rows: rows.map(r => ({ cells: r.map(c => typeof c === 'object' ? c : { text: String(c) }) })) }, x || {});
const write = (kind, model) => { const r = O.exportDocument({ kind, title: model.title || 'سند', model, dir: TMP }); return r; };
const validate = (file) => { const r = spawnSync('python3', [path.join(__dirname, 'validate_office.py'), file], { encoding: 'utf8' }); assert(r.stdout, 'validator failed: ' + r.stderr); return JSON.parse(r.stdout); };
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAEklEQVR4nGP4z8Dwn4GBgYEBAB8CAgFNeR3LAAAAAElFTkSuQmCC';
const toPdf = (file) => { const r = spawnSync('soffice', ['--headless', '--convert-to', 'pdf', '--outdir', TMP, file], { encoding: 'utf8', timeout: 90000 }); const pdf = file.replace(/\.(docx|xlsx)$/, '.pdf'); assert(fs.existsSync(pdf), 'soffice conversion failed: ' + r.stderr + r.stdout); const tx = spawnSync('pdftotext', ['-layout', pdf, '-'], { encoding: 'utf8' }).stdout; return { pdf, text: tx, size: fs.statSync(pdf).size }; };
const HAVE_SOFFICE = spawnSync('soffice', ['--version'], { encoding: 'utf8' }).status === 0;

console.log('— Office export (Word / Excel)');
t('zip + docx: valid package, Persian text, special characters escaped, RTL paragraphs, footer page field', () => {
  const m = { title: 'قرارداد', blocks: [P('مرکز آموزشی نمونه', { align: 'center', size: 16, b: true }), P('علی & «احمد» <b> "q" \u0001\u0007 ok'), T([['نام', 'مبلغ'], ['علی & <ب>', '1500']])] };
  const r = write('docx', m); assert.strictEqual(r.kind, 'docx'); const v = validate(r.path); assert(v.ok, JSON.stringify(v.errors));
  assert(v.paragraphs.includes('مرکز آموزشی نمونه')); assert(v.paragraphs.some(p => p === 'علی & «احمد» <b> "q"  ok'), 'control chars removed, & < > kept: ' + JSON.stringify(v.paragraphs));
  assert.deepStrictEqual(v.tables[0], [['نام', 'مبلغ'], ['علی & <ب>', '1500']]); assert(v.bidi_paragraphs >= 2, 'bidi'); assert(v.footer_has_page_field); assert(v.bold_runs >= 1);
});
t('docx: images embedded (PNG), bad/foreign data URLs ignored, oversize image scaled to page', () => {
  const m = { blocks: [{ t: 'img', data: PNG, w: 5000, h: 5000, align: 'center' }, { t: 'img', data: 'data:image/svg+xml;base64,AAAA' }, { t: 'img', data: 'javascript:alert(1)' }, P('x')] };
  const r = write('docx', m); const v = validate(r.path); assert(v.ok, JSON.stringify(v.errors)); assert.strictEqual(v.images, 1); assert(v.parts.some(p => /^word\/media\/image\d+\.png$/.test(p)));
  const o = require('child_process').spawnSync('unzip', ['-p', r.path, 'word/document.xml'], { encoding: 'utf8' }).stdout; const cx = Number(/<wp:extent cx="(\d+)"/.exec(o)[1]); assert(cx <= 698 * 9525 + 10, 'scaled to the content width: ' + cx);
});
t('docx: cards layout = table whose cells hold paragraphs + image; colspan header; nested blocks', () => {
  const card = (n) => ({ blocks: [{ t: 'img', data: PNG, w: 40, h: 40 }, P('کارت ' + n, { b: true }), P('شماره: ST-000' + n)] });
  const m = { blocks: [T([[card(1), card(2)], [card(3), card(4)]], { header: false, widths: [1, 1] }), T([[{ text: 'عنوان', colspan: 2 }], ['a', 'b']])] };
  const r = write('docx', m); const v = validate(r.path); assert(v.ok, JSON.stringify(v.errors)); assert.strictEqual(v.images, 4); assert(v.tables[0][0][0].includes('کارت 1') && v.tables[0][1][1].includes('ST-0004'));
});
t('docx: wide tables switch to landscape; explicit landscape flag respected', () => {
  const wide = T([Array.from({ length: 9 }, (_, i) => 'c' + i), Array.from({ length: 9 }, (_, i) => String(i))]);
  assert.strictEqual(validate(write('docx', { blocks: [wide] }).path).landscape, true); assert.strictEqual(validate(write('docx', { blocks: [T([['a', 'b'], ['1', '2']])] }).path).landscape, false); assert.strictEqual(validate(write('docx', { blocks: [T([['a'], ['1']])], landscape: true }).path).landscape, true);
});
t('xlsx: title rows merged, header bold + frozen + filter, RTL sheet, widths, landscape for wide sheets', () => {
  const m = { title: 'گزارش بدهکاران', blocks: [P('مرکز نمونه', { b: true }), P('گزارش بدهکاران', { b: true }), T([['شماره', 'نام', 'صنف', 'مبلغ', 'تماس'], ['ST-1', 'علی', 'الف', '1,500', '0799123456'], ['ST-2', 'سارا', 'ب', '۲٬۵۰۰٫۵۰', '0700']])] };
  const r = write('xlsx', m); assert.strictEqual(r.kind, 'xlsx'); const v = validate(r.path); assert(v.ok, JSON.stringify(v.errors));
  assert.strictEqual(v.rtl, true); assert(v.freeze, 'frozen header'); assert(v.merged.length >= 2, 'title merged'); assert.strictEqual(v.orientation, 'landscape'); assert(v.filter && v.filter.includes(':'));
  const hdr = v.cells.findIndex(r => r[0] === 'شماره'); assert(hdr >= 0 && v.bold[hdr].every(Boolean), 'header bold'); assert.strictEqual(v.cells[hdr + 1][3], 1500); assert.strictEqual(v.types[hdr + 1][3], 'int'); assert.strictEqual(v.cells[hdr + 2][3], 2500.5, 'Persian digits and separators parsed');
  assert.strictEqual(v.cells[hdr + 1][4], '0799123456', 'phone stays text'); assert.strictEqual(v.cells[hdr + 2][4], '0700'); assert.strictEqual(v.cells[hdr + 1][0], 'ST-1'); assert(v.widths.B >= 8);
});
t('xlsx: currency suffix becomes a numeric cell with a number format; ids / long numbers / percents stay text', () => {
  const m = { title: 'مالی', currency: 'افغانی', blocks: [T([['شماره', 'مبلغ', 'درصد', 'کد'], ['1', '1,500 افغانی', '85٪', '1234567890123456789'], ['2', '3000 افغانی', '90٪', '007']])] };
  const v = validate(write('xlsx', m).path); assert(v.ok, JSON.stringify(v.errors)); const rows = v.cells.filter(r => r[0] === 1 || r[0] === 2 || r[0] === '1');
  const r1 = v.cells.find(r => r[1] === 1500); assert(r1, 'unit stripped → number'); assert(v.numfmt.flat().some(f => f.includes('افغانی')), 'currency number format'); assert.strictEqual(v.cells.find(r => r[1] === 3000)[3], '007', 'leading zeros kept as text');
  assert(v.cells.some(r => r[2] === '85٪')); assert(v.cells.some(r => r[3] === '1234567890123456789'), 'too long → text');
});
t('xlsx: sheet name sanitised (31 chars, no []:*?/\\); colspan merges; empty table handled; 3000 rows × 8 cols', () => {
  const v = validate(write('xlsx', { title: 'گزارش [مالی]: سال/۱۴۰۴ ' + 'x'.repeat(40), blocks: [T([[{ text: 'سرتیتر', colspan: 3 }], ['a', 'b', 'c']])] }).path); assert(v.ok, JSON.stringify(v.errors)); assert(v.sheet.length <= 31 && !/[\[\]:*?\/\\]/.test(v.sheet), v.sheet); assert(v.merged.some(m => m.startsWith('A1')));
  assert(validate(write('xlsx', { blocks: [{ t: 'table', header: true, rows: [] }] }).path).ok, 'empty table');
  const big = T([Array.from({ length: 8 }, (_, i) => 'ستون' + i)].concat(Array.from({ length: 3000 }, (_, r) => Array.from({ length: 8 }, (_, c) => c === 3 ? String(r * 10) : 'مقدار ' + r + '-' + c)))); const t0 = Date.now(); const rb = write('xlsx', { blocks: [big] }); assert(Date.now() - t0 < 5000, 'fast'); const vb = validate(rb.path); assert(vb.ok && vb.cells.length >= 3001);
});
t('chooseKind: table-heavy lists → xlsx; documents (receipt/contract/card/with images) → docx; hints win', () => {
  const list = { blocks: [P('گزارش'), T([['a', 'b', 'c'], ['1', '2', '3'], ['4', '5', '6']])] }; assert.strictEqual(O.chooseKind(list), 'xlsx');
  const receipt = { blocks: [P('مرکز', { b: true }), P('رسید پرداخت فیس'), P('نام: علی'), P('مبلغ: 1500'), P('تاریخ: 1405/01/01'), P('امضا'), T([['a', 'b'], ['1', '2']])] }; assert.strictEqual(O.chooseKind(receipt), 'docx');
  assert.strictEqual(O.chooseKind({ blocks: [P('گزارش'), T([['شماره', 'نام شاگرد', 'صنف'], ['ST-0001', 'علی احمدی', 'صنف اول']])] }), 'xlsx', 'a list with a single data row is still a list');
  const kv = { blocks: [P('مشخصات'), T([['نام', 'علی'], ['پدر', 'احمد'], ['تلفن', '07']])] }; assert.strictEqual(O.chooseKind(kv), 'docx', '2 columns = key/value form');
  const longText = { blocks: [P('x'.repeat(2000)), T([['a', 'b', 'c'], ['1', '2', '3'], ['4', '5', '6']])] }; assert.strictEqual(O.chooseKind(longText), 'docx', 'mostly prose');
  assert.strictEqual(O.chooseKind(list, 'docx'), 'docx'); assert.strictEqual(O.chooseKind(receipt, 'xlsx'), 'xlsx'); assert.strictEqual(O.chooseKind({ blocks: [P('فقط متن')] }), 'docx');
});
t('exportDocument: unique safe file names, folder auto-created, bad models rejected with a clear error', () => {
  const dir = path.join(TMP, 'sub', 'deep'); const m = { blocks: [P('x')] };
  const a = O.exportDocument({ kind: 'docx', title: 'a/b:c*?"<>|', model: m, dir }), b = O.exportDocument({ kind: 'docx', title: 'a/b:c*?"<>|', model: m, dir, name: 'a/b:c*?"<>|' });
  assert(fs.existsSync(a.path) && fs.existsSync(b.path) && a.path !== b.path); assert(!/[\\/:*?"<>|]/.test(path.basename(a.path))); assert(a.size > 500);
  for (const bad of [null, {}, { blocks: 'x' }, { blocks: [{ t: 'table', rows: 5 }] }, { blocks: [{ t: 'table', rows: [{ cells: 5 }] }] }]) assert.throws(() => O.exportDocument({ kind: 'docx', title: 'x', model: bad, dir }), /نامعتبر/);
  assert.throws(() => O.exportDocument({ kind: 'docx', title: 'x', model: { blocks: new Array(5001).fill(P('a')) }, dir }), /بزرگ/);
});
t('imageSize reads PNG and JPEG headers; garbage returns null', () => {
  assert.deepStrictEqual(O.imageSize(Buffer.from(PNG.split(',')[1], 'base64'), 'png'), { w: 4, h: 4 }); assert.strictEqual(O.imageSize(Buffer.from('not an image at all, really'), 'png'), null);
  const jpg = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/yQALCAABAAEBAREA/8wABgAQEAX/2gAIAQEAAD8A0s8g/9k=', 'base64'); const s = O.imageSize(jpg, 'jpeg'); assert(s && s.w === 1 && s.h === 1, JSON.stringify(s));
});

const Kind = require('../lib/kind.js');
t('CSV: title lines, header, quoting of commas/quotes/newlines, numbers become machine-readable (Latin digits, no separators/unit), ids and phones stay text', () => {
  const m = { currency: 'افغانی', blocks: [P('مرکز نمونه'), T([['شماره', 'نام', 'مبلغ', 'تلفن'], ['ST-1', 'علی, "احمد"', '۱٬۵۰۰٫۵ افغانی', '0799123456'], ['2', 'خط\nدوم', '3000', '007']]), P('پایان')] };
  const csv = Kind.toCsv(m).split('\r\n'); assert.strictEqual(csv[0], 'مرکز نمونه'); assert.strictEqual(csv[1], ''); assert.strictEqual(csv[2], 'شماره,نام,مبلغ,تلفن');
  assert.strictEqual(csv[3], 'ST-1,"علی, ""احمد""",1500.5,0799123456'); assert.strictEqual(csv[4], '2,خط دوم,3000,007'); assert.strictEqual(csv[csv.length - 2], 'پایان');
  assert.strictEqual(Kind.toCsv({ blocks: [] }), '\r\n'); assert.strictEqual(Kind.hasTable(m), true); assert.strictEqual(Kind.hasTable({ blocks: [P('x')] }), false); assert.strictEqual(Kind.hasTable({ blocks: [{ t: 'table', rows: [] }] }), false);
});
t('CSV: colspan cells pad the row; multiple tables are separated by a blank line', () => {
  const m = { blocks: [T([[{ text: 'عنوان', colspan: 3 }], ['a', 'b', 'c']]), T([['x', 'y']])] }; const c = Kind.toCsv(m).split('\r\n'); assert.strictEqual(c[0], 'عنوان,,'); assert.strictEqual(c[1], 'a,b,c'); assert.strictEqual(c[2], ''); assert.strictEqual(c[3], 'x,y');
});
t('saveFiles: PNG pages, CSV/HTML with BOM; safe unique names; folder auto-created; multi-file naming', () => {
  const dir = path.join(TMP, 'save', 'x'); const png = PNG;
  const one = O.saveFiles({ files: [{ ext: 'png', data: png }], dir, name: 'a/b:c' }); assert.strictEqual(one.count, 1); assert(one.paths[0].endsWith('.png') && !/[\\/:*?"<>|]/.test(path.basename(one.paths[0]))); assert.strictEqual(fs.readFileSync(one.paths[0]).readUInt32BE(0), 0x89504e47);
  const many = O.saveFiles({ files: [{ ext: 'png', data: png }, { ext: 'png', data: png }, { ext: 'png', data: png }], dir, name: 'doc' }); assert.strictEqual(many.count, 3); assert(/-1\.png$/.test(many.paths[0]) && /-3\.png$/.test(many.paths[2])); assert.strictEqual(new Set(many.paths).size, 3);
  const csv = O.saveFiles({ files: [{ ext: 'csv', text: 'a,b\r\nعلی,1' }], dir, name: 'l' }); const buf = fs.readFileSync(csv.paths[0]); assert.deepStrictEqual([...buf.slice(0, 3)], [0xEF, 0xBB, 0xBF], 'UTF-8 BOM so Excel reads Persian'); assert(buf.toString('utf8').includes('علی'));
  const html = O.saveFiles({ files: [{ ext: 'html', text: '<html><body>سلام</body></html>' }], dir, name: 'h' }); assert(fs.readFileSync(html.paths[0], 'utf8').includes('سلام'));
  const a = O.saveFiles({ files: [{ ext: 'txt', text: 'x' }], dir, name: 'same' }), b = O.saveFiles({ files: [{ ext: 'txt', text: 'y' }], dir, name: 'same' }); assert.notStrictEqual(a.paths[0], b.paths[0], 'no overwrite within the same second');
});
t('saveFiles: only png/csv/html/txt; PNG must really be a PNG; limits enforced; nothing written on rejection', () => {
  const dir = path.join(TMP, 'rej'); const bad = (files) => assert.throws(() => O.saveFiles({ files, dir, name: 'x' }));
  bad([{ ext: 'exe', text: 'MZ' }]); bad([{ ext: 'js', text: 'alert(1)' }]); bad([{ ext: '../png', data: PNG }]); bad([{ ext: 'png', data: 'data:image/png;base64,AAAA' }]); bad([{ ext: 'png', data: 'not base64 !!!' }]); bad([{ ext: 'png', data: 'data:image/jpeg;base64,/9j/4AAQ' }]); bad([]); bad('x'); bad(new Array(61).fill({ ext: 'txt', text: 'x' }));
  assert(!fs.existsSync(dir) || fs.readdirSync(dir).length === 0, 'nothing written');
});
if (HAVE_SOFFICE) {
  t('real office suite opens the files: LibreOffice converts the DOCX (Persian text, table, image) and XLSX to PDF with the text intact', () => {
    const doc = write('docx', { title: 'رسید', blocks: [{ t: 'img', data: PNG, w: 60, h: 60, align: 'center' }, P('مرکز آموزشی نمونه', { align: 'center', b: true, size: 16 }), P('رسید پرداخت فیس'), T([['شاگرد', 'مبلغ'], ['احمد یوسفی', '1500 افغانی']])] });
    const d = toPdf(doc.path); assert(d.size > 3000 && d.text.includes('احمد') || /[\u0600-\u06FF]/.test(d.text), 'docx rendered: ' + d.text.slice(0, 100)); assert(d.text.includes('1500'), 'table value present');
    const xl = write('xlsx', { title: 'لیست', blocks: [P('گزارش شاگردان', { b: true }), T([['شماره', 'نام', 'مبلغ'], ['ST-1', 'علی', '1,500'], ['ST-2', 'سارا', '2,500']])] });
    const x = toPdf(xl.path); assert(x.text.includes('ST-1') && x.text.includes('2,500'), 'xlsx rendered: ' + x.text.slice(0, 120));
  });
} else console.log('  (skipped: LibreOffice not installed)');
fs.rmSync(TMP, { recursive: true, force: true });
console.log('\n' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
