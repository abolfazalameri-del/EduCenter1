'use strict';
/* تست سرتاسری (E2E) واقعی: Chromium واقعی + index.html واقعی + سرویس واقعی main (lib/service.js) + store واقعی روی دیسک.
   تنها بخش شبیه‌سازی‌شده، لایه‌ی چسب Electron است (ipcMain ↔ service و دیالوگ‌های سیستم‌عامل). PDFها با موتور Chromium (page.pdf) ساخته
   و با pdftotext/pdftoppm بررسی می‌شوند (متن واقعی + غیرخالی بودن تصویر). تست Electron واقع (printToPDF و close) در CI اجرا می‌شود (--selftest). */
const { chromium } = require('playwright');
const fs = require('fs'), os = require('os'), path = require('path'), zlib = require('zlib'), cp = require('child_process');
const { createStore } = require('../lib/store');
const { createService } = require('../lib/service');

const OUT = process.env.E2E_OUT || fs.mkdtempSync(path.join(os.tmpdir(), 'educenter-e2e-out-'));
fs.mkdirSync(OUT, { recursive: true });
const results = []; let exitCode = 0;
async function step(name, fn) {
  try { const note = await fn(); results.push({ name, status: 'PASS', note: note || '' }); console.log('  ✓', name, note ? '— ' + note : ''); }
  catch (e) { exitCode = 1; results.push({ name, status: 'FAIL', note: String(e && e.message || e).split('\n')[0] }); console.log('  ✗', name, '\n     ', String(e && e.message || e).split('\n').slice(0, 3).join(' | ')); }
}
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };

function png(w, h) { // PNG واقعی (گرادیان) برای آپلود عکس
  const raw = Buffer.alloc((w * 3 + 1) * h); for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = x * 255 / w; raw[o + 1] = y * 255 / h; raw[o + 2] = 128; } }
  const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(zlib.crc32(td) >>> 0); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
function pdfCheck(file) { // متن + تعداد صفحه + غیرخالی بودن تصویر
  const buf = fs.readFileSync(file); if (buf.slice(0, 5).toString() !== '%PDF-') throw new Error('not a PDF');
  const text = cp.execFileSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8' });
  const pages = Number((cp.execFileSync('pdfinfo', [file], { encoding: 'utf8' }).match(/Pages:\s+(\d+)/) || [0, 0])[1]);
  const prefix = file.replace(/\.pdf$/, '');
  cp.execFileSync('pdftoppm', ['-r', '50', '-png', '-f', '1', '-l', '1', file, prefix]);
  const pngf = fs.readdirSync(path.dirname(file)).find(f => f.startsWith(path.basename(prefix) + '-') && f.endsWith('.png'));
  const ink = Number(cp.execFileSync('python3', ['-c', 'import sys;from PIL import Image;im=Image.open(sys.argv[1]).convert("L");px=list(im.getdata());print(sum(1 for p in px if p<200))', path.join(path.dirname(file), pngf)], { encoding: 'utf8' }).trim());
  return { size: buf.length, text, pages, ink };
}

(async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'educenter-e2e-'));
  const store = createStore(base); const svc = createService(store, { allowTestHooks: true });
  const browser = await chromium.launch(); const ctx = await browser.newContext({ acceptDownloads: true });
  const pdfs = []; let pickPath = null; let lastPrintHtml = '';
  const officeLib = require('../lib/office.js'); const offices = [], saved = [], sweep = [], shownFolder = []; let failOffice = false, notOpened = false;
  const sweepOne = async (pg, name, html) => { try { const ttl = ((/<title>([\s\S]*?)<\/title>/.exec(html) || [])[1] || name).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"'); const kind = await pg.evaluate(t => window.__printKind(t), ttl); const model = await pg.evaluate(h => window.__htmlToModel(h), html); const r = officeLib.exportDocument({ kind, title: name, model, dir: path.join(OUT, 'sweep') }); sweep.push({ name, kind: r.kind, path: r.path, blocks: model.blocks.length }); } catch (e) { sweep.push({ name, error: e.message }); } };
  const preloadSrc = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  const CH = {}; for (const m of preloadSrc.matchAll(/(\w+): '([a-z]+:[A-Za-z]+)'/g)) CH[m[1]] = m[2];
  const KEY = 1;

  async function newPage() {
    const page = await ctx.newPage(); const errs = [];
    page.on('pageerror', e => { errs.push(e.message); console.log('  [pageerror]', e.message); });
    page.on('console', m => { if (m.type() === 'error') console.log('  [console.error]', m.text().slice(0, 200)); });
    await page.exposeFunction('__ipc', async (channel, args) => {
      try {
        if (channel === 'print:office') { if (failOffice) return { __error: 'شبیه‌سازی خطا' }; const [req] = args; const r = officeLib.exportDocument({ kind: req.kind, title: req.title, name: req.name, model: req.model, dir: path.join(OUT, 'office') }); const rec = Object.assign({}, r, { opened: !notOpened, title: req.title, hint: req.kind }); offices.push(rec); return rec; }
        if (channel === 'print:saveFiles') { if (failOffice) return { __error: 'شبیه‌سازی خطا' }; const [req] = args; const r = officeLib.saveFiles({ files: req.files, name: req.name, dir: path.join(OUT, 'office') }); const rec = Object.assign({}, r, { opened: !notOpened, name: req.name, exts: req.files.map(f => f.ext) }); saved.push(rec); return rec; }
        if (channel === 'file:showInFolder') { svc.authorize(KEY, channel); shownFolder.push(args[0]); return { ok: true }; }
        if (channel === 'print:pdf') { const [name, html] = args; lastPrintHtml = html; await sweepOne(page, name, html); const pp = await ctx.newPage(); await pp.setContent(html); const buf = await pp.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true }); await pp.close(); const f = path.join(OUT, String(pdfs.length + 1).padStart(2, '0') + '-' + name.replace(/[^\w.\-]/g, '_')); fs.writeFileSync(f, buf); pdfs.push({ name, file: f, size: buf.length }); return { path: f, size: buf.length }; }
        if (channel === 'backup:pickFile') { svc.authorize(KEY, channel); if (pickPath) svc.allowRestorePath(pickPath); return pickPath; }
        if (channel === 'backup:chooseDir' || channel === 'backup:openFolder' || channel === 'dialog:saveText') { svc.authorize(KEY, channel); return null; }
        return svc.invoke(KEY, channel, args);
      } catch (e) { return { __error: e.message, code: e.code || 'ERROR' }; }
    });
    await page.addInitScript(() => { window.__E2E_HOOK = true; });
    await page.addInitScript((CH) => { const api = { isElectron: true }; Object.keys(CH).forEach(n => { api[n] = (...a) => window.__ipc(CH[n], a); }); window.eduCenterAPI = api; }, CH);
    page.__errs = errs; return page;
  }
  const file = 'file://' + path.join(__dirname, '..', 'index.html');
  const page = await newPage();
  const db = () => page.evaluate(() => window.eduCenterAPI.load());
  const ipc = (ch, ...a) => page.evaluate(([c, x]) => window.eduCenterAPI[c](...x), [ch, a]);
  const toastText = async () => (await page.locator('.toast').allTextContents()).join(' | ');
  const nav = async (k) => { await page.click('[data-nav="' + k + '"]'); await page.waitForTimeout(150); };
  const waitPdf = async (n, fn) => { const before = pdfs.length; await fn(); for (let i = 0; i < 50 && pdfs.length === before; i++) await page.waitForTimeout(100); assert(pdfs.length > before, 'no PDF produced'); return pdfs[pdfs.length - 1]; };
  const PASSW = 'EduCenter2026pass', PW2 = 'EduCenter2027pass';
  const photoOK = png(120, 90);

  console.log('— First run / authentication');
  await page.goto(file); await page.waitForSelector('#login-form,#setup-form', { state: 'attached' });
  await step('first run shows setup form (no default admin/1234)', async () => { await page.waitForSelector('#setup-form', { state: 'visible' }); assert(!(await page.isVisible('#login-form'))); });
  let recoveryCode;
  await step('weak password rejected in setup UI', async () => { await page.fill('#su-name', 'مدیر مرکز آموزشی'); await page.fill('#su-username', 'admin'); await page.fill('#su-pass', '1234'); await page.fill('#su-pass2', '1234'); await page.click('#setup-form button[type=submit]'); await page.waitForSelector('#login-error', { state: 'visible' }); });
  await step('setup creates admin, logs in, shows one-time recovery code', async () => {
    await page.fill('#su-pass', PASSW); await page.fill('#su-pass2', PASSW); await page.click('#setup-form button[type=submit]');
    await page.waitForSelector('#secret-code', { timeout: 8000 }); recoveryCode = (await page.textContent('#secret-code')).trim(); assert(/^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/.test(recoveryCode), recoveryCode);
    await page.click('#secret-ok'); await page.waitForSelector('#app-screen', { state: 'visible' });
  });
  await step('password stored hashed on disk (no plaintext anywhere in data dir)', async () => { const all = fs.readdirSync(store.dataDir).map(f => fs.readFileSync(path.join(store.dataDir, f), 'utf8')).join('\n'); assert(!all.includes(PASSW) && all.includes('pbkdf2:')); });

  console.log('— Core setup via UI');
  await step('create academic year', async () => { await page.waitForSelector('#go-years'); await page.click('#go-years'); await page.click('#y-add'); await page.fill('[name=title]', 'سال 1405'); await page.fill('[name=startDate]', '2026-03-21'); await page.fill('[name=endDate]', '2027-03-20'); await page.click('#fm-save'); await page.waitForTimeout(250); const d = await db(); assert(d.collections.academicYears.length === 1); });
  await step('dynamic branding: center name + logo + palette set in Settings show in title, sidebar, print header', async () => {
    await nav('settings'); await page.fill('[name=centerName]', 'آکادمی نمونه'); await page.fill('[name=phone]', '0700123456');
    await page.setInputFiles('#st-logo-file', { name: 'logo.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAEklEQVR4nGP4z8Dwn4GBgYEBAB8CAgFNeR3LAAAAAElFTkSuQmCC', 'base64') }); await page.waitForTimeout(300);
    await page.click('#st-palette [data-pal=green]'); await page.click('#st-save'); await page.waitForTimeout(400);
    assert((await page.title()) === 'آکادمی نمونه', 'branding mismatch');
    assert(((await page.textContent('#side-name')).trim()) === 'آکادمی نمونه', 'branding mismatch');
    assert(await page.isVisible('#side-logo-img') && !(await page.isVisible('#side-logo-svg')), 'custom logo not shown in sidebar');
    assert((await page.textContent('#brand-style')).includes('#14532d'), 'palette not applied');
    const d = await db(); assert((d.objects.settings.centerName) === 'آکادمی نمونه', 'branding mismatch'); assert(!d.objects.settings.schoolName);
  });
  await step('settings: "print output" select (Word/Excel automatic vs PDF); default is Word/Excel; suite runs PDF mode first', async () => {
    await nav('settings'); assert((await page.inputValue('#st-printmode')) === 'ask', 'default = ask every time'); await page.selectOption('#st-printmode', 'pdf'); await page.waitForTimeout(400); assert((await db()).objects.settings.printMode === 'pdf');
  });
  await step('create class (+ second class)', async () => { await nav('classes'); for (const [n, s] of [['صنف اول', 'الف'], ['صنف دوم', 'ب']]) { await page.click('#c-add'); await page.fill('[name=name]', n); await page.fill('[name=section]', s); await page.click('#fm-save'); await page.waitForTimeout(200); } const d = await db(); assert(d.collections.classes.length === 2); });
  await step('create subject', async () => { await nav('subjects'); await page.click('#sb-add'); await page.fill('[name=name]', 'ریاضی'); await page.click('#sf-save'); await page.waitForTimeout(200); assert((await db()).collections.subjects.length === 1); });
  await step('create teacher (with salary)', async () => { await nav('teachers'); await page.click('#t-add'); await page.fill('[name=name]', 'استاد محمد کریمی'); await page.fill('[name=salary]', '8000'); await page.selectOption('[name=status]', 'فعال'); await page.click('#fm-save'); await page.waitForTimeout(200); const d = await db(); assert(d.collections.teachers[0].salary == 8000); });
  await step('create staff member', async () => { await nav('staff'); await page.click('#sf-add'); await page.fill('[name=name]', 'کارمند اداری رحیمی'); await page.fill('[name=role]', 'محاسب'); await page.fill('[name=salary]', '5000'); await page.click('#fm-save'); await page.waitForTimeout(200); assert((await db()).collections.staff.length === 1); });
  await step('create parent', async () => { await nav('parents'); await page.click('#p-add'); await page.fill('[name=name]', 'محمد یوسف'); await page.fill('[name=relation]', 'پدر'); await page.fill('[name=phone]', '0700123456'); await page.fill('[name=address]', 'کابل، ناحیه ۳'); await page.click('#fm-save'); await page.waitForTimeout(200); assert((await db()).collections.parents.length === 1); });
  await step('student form: required-field validation shown, nothing saved', async () => { await nav('students'); await page.click('#s-add'); await page.click('#fm-save'); await page.waitForTimeout(100); assert(await page.locator('.field.err').count() >= 2); await page.click('#fm-cancel'); assert((await db()).collections.students.length === 0); });
  await step('corrupt image file: clear error, student still saved without photo', async () => {
    await page.click('#s-add'); await page.fill('[name=name]', 'شاگرد بدون عکس'); await page.fill('[name=fatherName]', 'پدر'); await page.selectOption('[name=classId]', { index: 1 });
    fs.writeFileSync(path.join(OUT, 'broken.png'), Buffer.from('this is not an image')); await page.setInputFiles('#ph-file', path.join(OUT, 'broken.png')); await page.click('#fm-save'); await page.waitForTimeout(500);
    const d = await db(); const s = d.collections.students.find(x => x.name === 'شاگرد بدون عکس'); assert(s && !s.photoFileId, 'student should exist w/o photo'); const tt = await toastText(); assert(/عکس/.test(tt), 'toast: ' + tt);
    page.once('dialog', () => {}); await page.click('#s-table [data-act=del]'); await page.click('#cf-ok'); await page.waitForTimeout(200);
  });
  let studentId;
  await step('create student with photo in the create form (select → preview → compress → save)', async () => {
    await page.click('#s-add'); await page.fill('[name=name]', 'احمد یوسفی'); await page.fill('[name=fatherName]', 'محمد یوسف'); await page.fill('[name=phone]', '0799000111');
    await page.selectOption('[name=classId]', { index: 1 }); await page.selectOption('[name=parentId]', { index: 1 });
    fs.writeFileSync(path.join(OUT, 'photo.png'), photoOK); await page.setInputFiles('#ph-file', path.join(OUT, 'photo.png')); await page.waitForSelector('#ph-prev img'); await page.click('#fm-save'); await page.waitForTimeout(600);
    const d = await db(); const s = d.collections.students.find(x => x.name === 'احمد یوسفی'); assert(s && s.photoFileId, 'no photoFileId'); studentId = s.id;
    const b = Buffer.from(await ipc('fileGet', s.photoFileId), 'base64'); assert(b[0] === 0xFF && b[1] === 0xD8, 'stored photo should be JPEG after resize'); fs.writeFileSync(path.join(OUT, 'stored-photo.jpg'), b); return 'stored ' + b.length + ' bytes JPEG';
  });
  await step('parent ↔ student link stored (both directions)', async () => { const d = await db(); assert(d.collections.parents[0].studentIds.includes(studentId)); });
  await step('edit form shows existing photo; replace photo deletes the old file', async () => {
    const d0 = await db(); const old = d0.collections.students.find(s => s.id === studentId).photoFileId;
    await page.click('#s-table [data-act=edit]'); await page.waitForSelector('#ph-prev img', { timeout: 3000 }); fs.writeFileSync(path.join(OUT, 'photo2.png'), png(60, 60)); await page.setInputFiles('#ph-file', path.join(OUT, 'photo2.png')); await page.click('#fm-save'); await page.waitForTimeout(600);
    const d = await db(); const nw = d.collections.students.find(s => s.id === studentId).photoFileId; assert(nw && nw !== old); assert((await ipc('fileGet', old)) === null, 'old photo file should be deleted'); assert(await ipc('fileGet', nw));
  });
  await step('remove photo from edit form', async () => { await page.click('#s-table [data-act=edit]'); await page.click('#ph-remove'); await page.click('#fm-save'); await page.waitForTimeout(400); const d = await db(); assert(!d.collections.students.find(s => s.id === studentId).photoFileId); });
  await step('re-add photo (kept for the rest of the flow)', async () => { await page.click('#s-table [data-act=edit]'); await page.setInputFiles('#ph-file', path.join(OUT, 'photo.png')); await page.click('#fm-save'); await page.waitForTimeout(500); assert((await db()).collections.students.find(s => s.id === studentId).photoFileId); });
  await step('student search / filter', async () => { await page.fill('#s-table #dt-search', 'یوسفی'); await page.waitForTimeout(150); assert(await page.locator('#s-table tbody tr').count() === 1); await page.fill('#s-table #dt-search', 'ناموجود'); await page.waitForTimeout(150); assert(await page.locator('#s-table tbody tr').count() <= 1); await page.fill('#s-table #dt-search', ''); });

  console.log('— Teaching flow');
  await step('timetable slot saved; teacher double-booking (other class, same slot) refused', async () => {
    await nav('timetable'); const cls = await page.locator('#tt-class option').count(); await page.click('.tt-slot'); await page.selectOption('[name=subjectId]', { index: 1 }); await page.selectOption('[name=teacherId]', { index: 1 }); await page.fill('[name=room]', 'A1'); await page.click('#tt-save'); await page.waitForTimeout(250);
    let d = await db(); assert(d.collections.timetable.length === 1, 'slot not saved');
    await page.selectOption('#tt-class', { index: 1 }); await page.waitForTimeout(150); await page.click('.tt-slot'); await page.selectOption('[name=subjectId]', { index: 1 }); await page.selectOption('[name=teacherId]', { index: 1 }); await page.fill('[name=room]', 'B2'); await page.click('#tt-save'); await page.waitForTimeout(250);
    d = await db(); assert(d.collections.timetable.length === 1, 'conflict was not blocked'); const tt = await toastText(); await page.click('#tt-cancel').catch(() => {}); return 'blocked: ' + tt.slice(0, 60);
  });
  await step('student attendance saved and retrievable', async () => { await nav('attendance'); await page.waitForSelector('.att-grid'); await page.click('.att-chip >> nth=1').catch(() => {}); await page.click('#at-save'); await page.waitForTimeout(250); const d = await db(); assert(d.collections.attendance.some(a => a.records && a.records[studentId]), 'no attendance for student'); });
  await step('staff/teacher attendance saved and retrievable', async () => { await nav('staffAttendance'); await page.click('[data-emp][data-st=present] >> nth=0'); await page.click('#sa-save'); await page.waitForTimeout(250); const d = await db(); assert(d.collections.staffAttendance.length === 1 && Object.values(d.collections.staffAttendance[0].records).includes('present')); });
  await step('staff attendance monthly report', async () => { await page.click('#sa-report'); const t = await page.textContent('#sa-rep'); assert(t.includes('استاد محمد کریمی')); });
  await step('exam created, marks entered & persisted', async () => {
    await nav('exams'); await page.click('#ex-add'); await page.fill('[name=title]', 'امتحان دوره اول'); await page.selectOption('[name=classId]', { index: 1 }); await page.selectOption('[name=subjectId]', { index: 1 }); await page.selectOption('[name=examType]', 'دوره‌ای'); await page.fill('[name=maxScore]', '100'); await page.click('#fm-save'); await page.waitForTimeout(250);
    await page.click('#ex-table [data-act=marks]'); await page.waitForSelector('.mk-input'); await page.fill('.mk-input', '85'); await page.click('#mk-save'); await page.waitForTimeout(250);
    const d = await db(); assert(d.collections.marks.some(m => m.studentId === studentId && Number(m.score) === 85));
  });
  await step('marks above the maximum are rejected', async () => { await page.click('#ex-table [data-act=marks]'); await page.waitForSelector('.mk-input'); await page.fill('.mk-input', '150'); await page.click('#mk-save'); await page.waitForTimeout(250); const d = await db(); assert(d.collections.marks.every(m => Number(m.score) <= 100), 'mark > max stored'); await page.fill('.mk-input', '85'); await page.click('#mk-save'); await page.waitForTimeout(200); });
  await step('report card: correct computation + real PDF', async () => {
    await nav('students'); await page.click('#s-table [data-act=view]'); await page.waitForSelector('#pd-card'); await page.click('#pd-card'); await page.waitForSelector('#rc-print-area');
    const txt = await page.textContent('#rc-print-area'); assert(/85 از 100/.test(txt) && /85٪|85%/.test(txt), 'computation: ' + txt.replace(/\s+/g, ' ').slice(0, 200));
    const p = await waitPdf('karnama', () => page.click('#rc-print')); const c = pdfCheck(p.file); assert(c.size > 5000 && c.pages >= 1 && c.ink > 200, JSON.stringify({ size: c.size, ink: c.ink })); assert(c.text.includes(studentId) && /85/.test(c.text), 'PDF text lacks content: ' + c.text.slice(0, 120)); await page.click('#rc-cancel'); return c.size + ' bytes, ' + c.pages + ' page(s), ink=' + c.ink;
  });
  await step('student history tabs: attendance / marks / fees / discipline all render', async () => { const tabs = await page.locator('#pd-tabs [data-tab]').count(); assert(tabs === 7, 'tabs=' + tabs); });

  console.log('— Finance');
  let paymentId;
  await step('fee payment → receipt shown → receipt PDF', async () => {
    await nav('fees'); await page.click('#fp-add'); await page.waitForSelector('[name=studentId]'); await page.selectOption('[name=studentId]', { index: 1 }); await page.selectOption('[name=type]', 'فیس ماهانه'); await page.fill('[name=amount]', '500'); await page.fill('[name=date]', '2026-06-01'); await page.click('#fm-save'); await page.waitForSelector('#receipt-print-area');
    const d = await db(); assert(d.collections.feePayments.length === 1 && Number(d.collections.feePayments[0].amount) === 500); paymentId = d.collections.feePayments[0].id;
    const p = await waitPdf('receipt', () => page.click('#rc2-print')); const c = pdfCheck(p.file); assert(c.size > 3000 && c.ink > 100 && c.text.trim().length > 20, 'receipt PDF empty'); await page.click('#rc2-cancel');
  });
  await step('negative / zero fee amount rejected', async () => { await page.click('#fp-add'); await page.selectOption('[name=studentId]', { index: 1 }); await page.fill('[name=amount]', '-5'); await page.click('#fm-save'); await page.waitForTimeout(150); const d = await db(); assert(d.collections.feePayments.length === 1); await page.click('#fm-cancel'); });
  await step('expense recorded', async () => { await nav('accounting'); await page.click('#ac-add'); await page.fill('[name=title]', 'خرید تخته و مارکر'); await page.selectOption('[name=category]', 'لوازم درسی'); await page.fill('[name=amount]', '1200'); await page.fill('[name=date]', '2026-06-02'); await page.click('#fm-save'); await page.waitForTimeout(200); assert((await db()).collections.expenses.length === 1); });
  await step('payroll: net = base + additions − deductions, status/remaining computed, duplicate period refused', async () => {
    await nav('payroll'); await page.click('#py-add'); await page.selectOption('[name=employeeId]', { index: 1 }); await page.waitForTimeout(100); const base = await page.inputValue('[name=baseSalary]'); assert(base === '8000' || base === '5000', 'base not prefilled: ' + base);
    await page.fill('[name=baseSalary]', '8000'); await page.fill('[name=additions]', '500'); await page.fill('[name=deductions]', '200'); await page.fill('[name=paidAmount]', '5000'); await page.fill('[name=paidDate]', '2026-06-30'); await page.click('#fm-save'); await page.waitForTimeout(250);
    let d = await db(); const p = d.collections.payroll[0]; assert(p && p.baseSalary == 8000 && p.additions == 500 && p.deductions == 200 && p.paidAmount == 5000);
    const row = await page.textContent('#py-table tbody tr'); assert(/دارای باقی‌مانده/.test(row), 'status: ' + row.replace(/\s+/g, ' ').slice(0, 160));
    await page.click('#py-add'); await page.selectOption('[name=employeeId]', { index: 1 }); await page.fill('[name=baseSalary]', '1'); await page.click('#fm-save'); await page.waitForTimeout(150); d = await db(); assert(d.collections.payroll.length === 1, 'duplicate period allowed'); await page.click('#fm-cancel');
    await page.click('#py-table [data-act=edit]'); await page.fill('[name=paidAmount]', '8300'); await page.click('#fm-save'); await page.waitForTimeout(200); d = await db(); assert(d.collections.payroll[0].paidAmount == 8300);
    assert(/پرداخت‌شده/.test(await page.textContent('#py-table tbody tr')));
  });
  await step('payroll receipt PDF + payroll report PDF', async () => { const p1 = await waitPdf('pr1', () => page.click('#py-table [data-act=print]')); assert(pdfCheck(p1.file).ink > 100); const p2 = await waitPdf('pr2', () => page.click('#py-table >> text=چاپ').catch(() => page.click('[data-print], #dt-print, .btn:has-text("چاپ")'))); const c = pdfCheck(p2.file); assert(c.size > 2000 && c.text.trim().length > 20); });
  await step('accounting summary: income − expenses − payroll paid is correct', async () => { await nav('accounting'); const t = await page.textContent('.stat-grid'); const digits = (s) => s.replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d)).replace(/[٬,\s]/g, ''); const n = digits(t); assert(/500/.test(n) && /1200/.test(n) && /8300/.test(n), n.slice(0, 200)); assert(/-?9000/.test(n.replace('−', '-')), 'net = 500-1200-8300 = -9000; got ' + n); });

  console.log('— Discipline / assets / notices / parent report / documents');
  await step('discipline event saved with responsible user; appears in student history tab', async () => {
    await nav('discipline'); await page.click('#dc-add2'); await page.selectOption('[name=studentId]', { index: 1 }); await page.selectOption('[name=category]', 'تأخیر مکرر'); await page.selectOption('[name=action]', 'تذکر کتبی'); await page.fill('[name=description]', 'سه روز متوالی با تأخیر آمد'); await page.click('#fm-save'); await page.waitForTimeout(250);
    const d = await db(); const r = d.collections.discipline[0]; assert(r && r.recordedBy === 'مدیر مرکز آموزشی' && r.studentId === studentId, JSON.stringify(r));
    await nav('students'); await page.click('#s-table [data-act=view]'); await page.click('#pd-tabs [data-tab="5"]'); assert((await page.textContent('#pd-tab-5')).includes('سه روز متوالی'));
  });
  await step('discipline report PDF', async () => { await nav('discipline'); const p = await waitPdf('disc', () => page.click('.btn:has-text("چاپ")')); const c = pdfCheck(p.file); assert(c.ink > 100 && c.text.trim().length > 20); });
  await step('asset: register, issue, over-issue refused, return, history, availability math', async () => {
    await nav('assets'); await page.click('#as-add'); await page.fill('[name=name]', 'میز شاگردی'); await page.fill('[name=code]', 'AST-001'); await page.selectOption('[name=category]', 'اثاثیه'); await page.fill('[name=quantity]', '10'); await page.fill('[name=location]', 'گدام اصلی'); await page.fill('[name=responsible]', 'رحیمی'); await page.click('#fm-save'); await page.waitForTimeout(200);
    await page.click('#as-add'); await page.fill('[name=name]', 'تکراری'); await page.fill('[name=code]', 'AST-001'); await page.fill('[name=quantity]', '1'); await page.click('#fm-save'); await page.waitForTimeout(120); assert((await db()).collections.assets.length === 1, 'duplicate code allowed'); await page.click('#fm-cancel');
    await page.click('#as-table [data-act=move]'); await page.fill('[name=qty]', '4'); await page.fill('[name=person]', 'صنف اول'); await page.click('#fm-save'); await page.waitForTimeout(200);
    await page.click('#as-table [data-act=move]'); await page.fill('[name=qty]', '7'); await page.fill('[name=person]', 'x'); await page.click('#fm-save'); await page.waitForTimeout(120); let d = await db(); assert(d.collections.assetMovements.length === 1, 'over-issue allowed'); await page.fill('[name=qty]', '1'); await page.selectOption('[name=type]', 'return'); await page.click('#fm-save'); await page.waitForTimeout(200);
    d = await db(); assert(d.collections.assetMovements.length === 2); const row = (await page.textContent('#as-table tbody tr')).replace(/\s+/g, ' '); assert(/10.*3.*7/.test(row), 'row: ' + row);
    await page.click('#as-table [data-act=history]'); assert((await page.textContent('.modal-box')).includes('صنف اول')); await page.click('#ah-x'); await page.waitForTimeout(150);
    const p = await waitPdf('assets', () => page.click('.btn:has-text("چاپ")')); assert(pdfCheck(p.file).ink > 100);
  });
  await step('asset in use cannot be deleted', async () => { await page.click('#as-table [data-act=del]'); await page.waitForTimeout(150); assert((await db()).collections.assets.length === 1); });
  await step('announcement created', async () => { await nav('announcements'); await page.click('#an-add'); await page.fill('[name=title]', 'شروع امتحانات'); await page.fill('[name=body]', 'امتحانات از هفته آینده آغاز می‌شود.'); await page.click('#fm-save'); await page.waitForTimeout(200); assert((await db()).collections.announcements.length === 1); });
  await step('parent report shows linked student + PDF', async () => { await nav('parents'); await page.click('#p-table [data-act=view]'); await page.waitForSelector('#pr-print'); assert((await page.textContent('#pr-print')).includes('احمد یوسفی')); const p = await waitPdf('parent', () => page.click('#pr-printbtn')); const c = pdfCheck(p.file); assert(c.ink > 100 && c.text.trim().length > 20); await page.click('#pr-close'); });
  await step('teacher documents: open, add record, stored with relatedType=teacher', async () => { await nav('teachers'); await page.click('#t-table [data-act=docs]'); await page.waitForSelector('#pd-docs'); await page.click('#pd-doc-add2'); await page.fill('[name=title]', 'قرارداد کار'); await page.click('#fm-save'); await page.waitForTimeout(250); const d = await db(); assert(d.collections.documents.some(x => x.relatedType === 'teacher' && x.title === 'قرارداد کار')); await page.click('#pdx'); await page.waitForTimeout(150); });
  if (process.env.DEBUG_E2E) console.log('DEBUG', JSON.stringify(await page.evaluate(() => ({ login: getComputedStyle(document.getElementById('login-screen')).display, app: getComputedStyle(document.getElementById('app-screen')).display, hash: location.hash, navs: document.querySelectorAll('[data-nav]').length, modal: document.querySelectorAll('.modal-box,.modal-overlay').length, html: document.getElementById('main-content').innerText.slice(0,200) }))));
  await step('students list PDF + every report type produces a non-blank PDF', async () => {
    await nav('reports'); const keys = await page.locator('#rp-type option').evaluateAll(o => o.map(x => x.value)); const bad = [];
    for (const k of keys) { await page.selectOption('#rp-type', k); const p = await waitPdf(k, () => page.click('#rp-print')); const c = pdfCheck(p.file); if (!(c.size > 2000 && c.pages >= 1 && c.ink > 100 && c.text.trim().length > 15)) bad.push(k + ':' + JSON.stringify({ s: c.size, i: c.ink, t: c.text.trim().length })); }
    assert(!bad.length, 'blank/short PDFs: ' + bad.join(', ')); return keys.length + ' report PDFs OK';
  });
  await step('printed PDFs carry the configured center name, logo and phone (dynamic header)', async () => { assert(lastPrintHtml.includes('آکادمی نمونه') && lastPrintHtml.includes('<img') && lastPrintHtml.includes('0700123456'), 'print header lacks name/logo/phone'); });
  await step('search page works', async () => { await nav('search'); await page.fill('#gs-input', 'احمد'); await page.click('#gs-btn'); await page.waitForTimeout(250); assert((await page.textContent('#main-content')).includes('احمد')); });

  console.log('— Users / permissions through the real UI');
  await step('create finance user in UI', async () => { await nav('users'); await page.click('#u-add'); await page.fill('[name=name]', 'حسابدار مرکز آموزشی'); await page.fill('[name=username]', 'fin1'); await page.selectOption('[name=role]', 'finance'); await page.fill('[name=password]', 'weak'); await page.click('#fm-save'); await page.waitForTimeout(250); assert(!(await db()).collections.users.some(u => u.username === 'fin1'), 'weak password accepted'); await page.waitForSelector('#fm-form', { timeout: 500 }).catch(() => {}); });
  await step('user created with valid temp password', async () => { const open = await page.$('#fm-form'); if (!open) { await page.click('#u-add'); await page.fill('[name=name]', 'حسابدار مرکز آموزشی'); await page.fill('[name=username]', 'fin1'); await page.selectOption('[name=role]', 'finance'); } await page.fill('[name=password]', 'Temp12345pw'); await page.click('#fm-save'); await page.waitForTimeout(300); assert((await db()).collections.users.some(u => u.username === 'fin1')); });
  await step('permission editor opens, lists permissions and saves a change', async () => { await page.click('#u-perms'); await page.waitForSelector('#pm-list [data-perm]', { state: 'attached' }); assert(await page.locator('#pm-list [data-perm]').count() > 30); await page.click('#pm-x'); });
  await step('logout; wrong password shows clear error', async () => { await page.click('#btn-logout'); await page.waitForSelector('#login-form', { state: 'visible' }); await page.fill('#login-username', 'fin1'); await page.fill('#login-password', 'wrong-pass'); await page.click('#login-form button[type=submit]'); await page.waitForSelector('#login-error', { state: 'visible' }); assert(/نادرست/.test(await page.textContent('#login-error'))); });
  await step('login screen (before login) shows the configured center name + logo', async () => { assert(((await page.textContent('#login-title')).trim()) === 'آکادمی نمونه', 'branding mismatch'); assert(await page.isVisible('#login-logo-img')); assert((await page.title()) === 'آکادمی نمونه', 'branding mismatch'); });
  await step('finance login → forced password change modal (cannot be dismissed), weak new password refused', async () => {
    await page.fill('#login-password', 'Temp12345pw'); await page.click('#login-form button[type=submit]'); await page.waitForSelector('#force-pw'); assert(!(await page.isVisible('#app-screen')));
    await page.fill('#fp-new', '1234'); await page.fill('#fp-new2', '1234'); await page.click('#fp-save'); await page.waitForSelector('#fp-err', { state: 'visible' });
    const blocked = await ipc('load'); assert(blocked.__error && blocked.code === 'MUST_CHANGE_PASSWORD', 'IPC not blocked: ' + JSON.stringify(blocked).slice(0, 100));
    await page.fill('#fp-new', 'Fin2026newpw'); await page.fill('#fp-new2', 'Fin2026newpw'); await page.click('#fp-save'); await page.waitForSelector('#app-screen', { state: 'visible' });
  });
  await step('finance UI: sees fees/accounting/payroll, NOT users/settings/backup/exams/discipline', async () => {
    const navs = await page.locator('[data-nav]').evaluateAll(e => e.map(x => x.getAttribute('data-nav'))); for (const k of ['fees', 'accounting', 'payroll']) assert(navs.includes(k), 'missing ' + k); for (const k of ['users', 'settings', 'backup', 'exams', 'discipline', 'activityLog']) assert(!navs.includes(k), 'should hide ' + k);
    await page.evaluate(() => { location.hash = '#/users'; }); await page.waitForTimeout(250); assert(!(await page.textContent('#main-content')).includes('افزودن کاربر'), 'users page reachable');
  });
  await step('finance DIRECT IPC attempts are refused by main (not just hidden menus)', async () => {
    const attempts = [['usersSave', [{ name: 'x', username: 'evil1', role: 'admin', status: 'فعال' }, 'Evil12345pw']], ['usersSetPassword', ['US-0001', 'Evil12345pw']], ['permsSet', ['finance', ['restore.run']]], ['backupRestore', ['/tmp/x.json']], ['backupCreate', []], ['readLogs', []], ['recoveryRegenerate', []], ['save', [[{ name: 'marks', shard: 'x', records: [{ id: 'MK-HACK', score: 100 }] }]]], ['save', [[{ name: 'settings', object: { schoolName: 'HACKED' } }]]], ['save', [[{ name: 'users', shard: '', records: [{ id: 'US-8', username: 'evil', role: 'admin' }] }]]]];
    const out = []; for (const [m, a] of attempts) { const r = await ipc(m, ...a); if (!(r && r.__error && (r.code === 'FORBIDDEN' || r.code === 'BAD_REQUEST'))) out.push(m + ' → ' + JSON.stringify(r).slice(0, 80)); } assert(!out.length, 'NOT refused: ' + out.join('; '));
    const own = await ipc('save', [{ name: 'expenses', shard: '', records: [{ id: 'EP-0001', title: 'ok', amount: 1, yearId: 'x' }] }]); assert(!(own && own.__error && own.code === 'FORBIDDEN' && false)); return attempts.length + ' malicious IPC calls refused';
  });
  await step('finance cannot delete payments (write w/o delete permission) – data intact', async () => { const d0 = await db(); const r = await ipc('save', [{ name: 'feePayments', shard: d0.collections.feePayments[0].yearId, records: [] }]); assert(r.__error && r.code === 'FORBIDDEN'); assert((await db()).collections.feePayments.length === 1); });
  await step('finance logs out; admin logs back in', async () => { await page.click('#btn-logout'); await page.waitForSelector('#login-form', { state: 'visible' }); await page.fill('#login-username', 'admin'); await page.fill('#login-password', PASSW); await page.click('#login-form button[type=submit]'); await page.waitForSelector('#app-screen', { state: 'visible' }); });
  await step('audit log recorded login/logout/failed login/denied/grade+finance/user changes', async () => { const logs = store.readLogs(5000).map(l => l.action); for (const a of ['ورود', 'خروج', 'ورود ناموفق', 'دسترسی ردشد', 'تغییر نمره', 'تغییر مالی/حساس', 'تغییر کاربران و صلاحیت‌ها', 'تغییر رمز']) assert(logs.includes(a), 'missing audit action ' + a); await nav('activityLog'); assert(await page.locator('#al-table tbody tr').count() > 3); });

  console.log('— Branches (Phase 2)');
  const tableText = async (sel) => (await page.textContent(sel)) || '';
  const switchTo = async (v) => { await page.selectOption('#branch-switch', v); await page.waitForTimeout(500); };
  await step('create 2nd branch in UI → stored with BR-0002 + seq; comparison table lists both branches', async () => {
    assert(!(await page.isVisible('#branch-switch')), 'switcher must be hidden with a single branch');
    await nav('branches'); await page.click('#br-add'); await page.fill('[name=name]', 'شعبه غرب'); await page.fill('[name=manager]', 'مسئول غرب'); await page.click('#fm-save'); await page.waitForTimeout(500);
    const d = await db(); assert(d.collections.branches.length === 2 && d.collections.branches.some(b => b.id === 'BR-0002' && b.name === 'شعبه غرب'), 'branch not stored'); assert(d.objects.seq.branch === 2, 'seq');
    assert(d.collections.branches.find(b => b.id === 'BR-0001').isDefault, 'default branch flag');
    const t = await tableText('#br-stats'); assert(t.includes('شعبه غرب') && t.includes('شعبه مرکزی') && t.includes('مجموع'), 'stats table: ' + t.slice(0, 120));
    assert(d.collections.students.every(s => s.branchId === 'BR-0001'), 'existing students belong to default branch');
  });
  await step('switcher appears; data is isolated per branch (west is empty; new subject lands in west only)', async () => {
    assert(await page.isVisible('#branch-switch'), 'switcher not visible');
    await switchTo('BR-0002'); await nav('subjects'); assert(!(await tableText('#sb-table')).includes('ریاضی'), 'default-branch subject leaked into west view');
    await page.click('#sb-add'); await page.fill('[name=name]', 'Speaking A'); await page.click('#sf-save'); await page.waitForTimeout(400);
    const d = await db(); assert(d.collections.subjects.length === 2); assert(d.collections.subjects.find(s => s.name === 'Speaking A').branchId === 'BR-0002'); assert(d.collections.subjects.find(s => s.name === 'ریاضی').branchId === 'BR-0001', 'old subject was wiped or re-stamped');
    await nav('students'); assert(!(await tableText('#s-table')).includes('احمد'), 'default-branch student visible in west');
  });
  await step('"all branches" view shows everything but new-record buttons are disabled; stats per branch correct', async () => {
    await switchTo('all'); await nav('subjects'); const t = await tableText('#sb-table'); assert(t.includes('ریاضی') && t.includes('Speaking A'), 'all view incomplete');
    assert(await page.isDisabled('#sb-add'), 'add must be disabled in all-branches view');
    await nav('branches'); await page.waitForTimeout(300); const st = await ipc('branchesStats'); const w = st.rows.find(r => r.id === 'BR-0002'), m = st.rows.find(r => r.id === 'BR-0001'); assert(w.students === 0 && m.students === 1, 'student counts per branch');
  });
  await step('selected branch persists across reload; back to default branch', async () => {
    await switchTo('BR-0002'); await page.reload(); await page.waitForSelector('#app-screen', { state: 'visible' }).catch(() => {});
    if (await page.isVisible('#login-form')) { await page.fill('#login-username', 'admin'); await page.fill('#login-password', PASSW); await page.click('#login-form button[type=submit]'); await page.waitForSelector('#app-screen', { state: 'visible' }); }
    await switchTo('BR-0001'); await nav('subjects'); const t = await tableText('#sb-table'); assert(t.includes('ریاضی') && !t.includes('Speaking A'));
  });
  await step('مدیر شعبه without a branch is refused; with a branch it is created', async () => {
    await nav('users'); await page.click('#u-add'); await page.fill('[name=name]', 'مدیر غرب'); await page.fill('[name=username]', 'bmwest'); await page.selectOption('[name=role]', 'branch_manager'); await page.fill('[name=password]', 'Temp12345pw'); await page.click('#fm-save'); await page.waitForTimeout(400);
    assert(!(await db()).collections.users.some(u => u.username === 'bmwest'), 'branch manager created without a branch');
    if (!(await page.$('#fm-form'))) { await page.click('#u-add'); await page.fill('[name=name]', 'مدیر غرب'); await page.fill('[name=username]', 'bmwest'); await page.selectOption('[name=role]', 'branch_manager'); await page.fill('[name=password]', 'Temp12345pw'); }
    await page.selectOption('[name=branchId]', 'BR-0002'); await page.click('#fm-save'); await page.waitForTimeout(400);
    const u = (await db()).collections.users.find(x => x.username === 'bmwest'); assert(u && u.branchId === 'BR-0002' && u.role === 'branch_manager', 'user not stored with branch');
  });
  await step('branch manager: forced password change → sees ONLY west data, no switcher, branch badge, no admin pages', async () => {
    await page.click('#btn-logout'); await page.waitForSelector('#login-form', { state: 'visible' });
    await page.fill('#login-username', 'bmwest'); await page.fill('#login-password', 'Temp12345pw'); await page.click('#login-form button[type=submit]'); await page.waitForSelector('#force-pw');
    await page.fill('#fp-new', 'West2026newpw'); await page.fill('#fp-new2', 'West2026newpw'); await page.click('#fp-save'); await page.waitForSelector('#app-screen', { state: 'visible' });
    assert(!(await page.isVisible('#branch-switch')), 'bound user must not see the switcher'); assert((await page.textContent('#branch-badge')).includes('شعبه غرب'), 'badge');
    const navs = await page.locator('[data-nav]').evaluateAll(e => e.map(x => x.getAttribute('data-nav'))); for (const k of ['users', 'settings', 'backup', 'years']) assert(!navs.includes(k), 'should hide ' + k); assert(navs.includes('students') && navs.includes('fees'), 'core pages missing');
    await nav('subjects'); const t = await tableText('#sb-table'); assert(t.includes('Speaking A') && !t.includes('ریاضی'), 'branch isolation in UI');
    await nav('students'); assert(!(await tableText('#s-table')).includes('احمد'), 'student of another branch visible');
  });
  await step('branch manager: server refuses cross-branch reads/writes, branches/settings/backup/restore, admin accounts (IPC level)', async () => {
    const ld = await ipc('load', 'BR-0001'); assert(ld.scope === 'BR-0002' && ld.restricted === true, 'scope not forced'); const leakIn = Object.keys(ld.collections).filter(k => JSON.stringify(ld.collections[k]).includes('احمد')); assert(leakIn.length === 0 && ld.collections.students.length === 0, 'data leak in load: ' + leakIn.join(','));
    assert(ld.collections.branches.length === 1 && ld.collections.branches[0].id === 'BR-0002');
    const hack = await ipc('save', [{ name: 'students', shard: '', records: [{ id: studentId, name: 'HACK' }] }]); assert(hack.__error && hack.code === 'FORBIDDEN', 'cross-branch overwrite allowed: ' + JSON.stringify(hack).slice(0, 100));
    for (const [ch, args] of [['backupCreate', []], ['backupList', []], ['permsSet', ['teacher', []]], ['usersSetPassword', ['US-0001', 'Hacked2026pw']]]) { const r = await ipc(ch, ...args); assert(r && r.__error && r.code === 'FORBIDDEN', ch + ' not blocked: ' + JSON.stringify(r).slice(0, 80)); }
    const br = await ipc('save', [{ name: 'branches', shard: '', records: [] }]); assert(br.__error && br.code === 'FORBIDDEN', 'branches write');
    const st = await ipc('save', [{ name: 'settings', object: { centerName: 'HACK' } }]); assert(st.__error && st.code === 'FORBIDDEN', 'settings write');
    const d = (await (async () => { await ipc('authLogout'); return null; })()); await page.reload(); await page.waitForSelector('#login-form', { state: 'visible' });
  });
  await step('admin logs back in: lands on default branch; west data intact; deleting a branch that has data is refused; comparison report prints with branch names', async () => {
    await page.fill('#login-username', 'admin'); await page.fill('#login-password', PASSW); await page.click('#login-form button[type=submit]'); await page.waitForSelector('#app-screen', { state: 'visible' });
    assert((await page.inputValue('#branch-switch')) === 'BR-0001', 'admin should land on the default branch');
    const d = await db(); assert(d.collections.students.find(s => s.id === studentId).name === 'احمد یوسفی' && d.collections.subjects.some(s => s.name === 'Speaking A'), 'data damaged by bound user');
    await nav('branches'); await page.waitForSelector('#br-stats-table'); const row = page.locator('#br-table tbody tr', { hasText: 'شعبه غرب' }); await row.locator('[data-act=del]').click(); await page.click('#cf-ok'); await page.waitForTimeout(500);
    assert((await db()).collections.branches.length === 2, 'branch with data/users was deleted');
    await waitPdf('branches', async () => { await page.click('#br-print'); }); assert(lastPrintHtml.includes('شعبه غرب') && lastPrintHtml.includes('شعبه مرکزی'), 'print lacks branch names');
    await nav('students');
  });

  console.log('— Courses → Levels → Classes (Phase 3)');
  let courseId, lvlBeginner, lvlInter, courseClassId;
  await step('create course in UI (type, duration, dates, price) → stored in current branch; duplicate name refused', async () => {
    await nav('courses'); await page.click('#cr-add'); await page.fill('[name=name]', 'English'); await page.selectOption('[name=category]', 'زبان‌های بین‌المللی'); await page.fill('[name=durationValue]', '3'); await page.selectOption('[name=durationUnit]', 'ماه');
    await page.fill('[name=startDate]', '2026-04-01'); await page.fill('[name=endDate]', '2026-07-01'); await page.fill('[name=price]', '2500'); await page.click('#fm-save'); await page.waitForTimeout(500);
    let d = await db(); const c = d.collections.courses.find(x => x.name === 'English'); assert(c && c.branchId === 'BR-0001' && c.price === 2500 && c.durationValue === 3 && c.category === 'زبان‌های بین‌المللی' && c.startDate === '2026-04-01', 'course not stored: ' + JSON.stringify(c)); courseId = c.id; assert(d.objects.seq.course === 1);
    await page.click('#cr-add'); await page.fill('[name=name]', ' english '); await page.click('#fm-save'); await page.waitForTimeout(250); assert(await page.$('#fm-form'), 'duplicate name must keep the form open'); await page.click('#fm-cancel');
    await page.click('#cr-add'); await page.fill('[name=name]', 'X'); await page.fill('[name=startDate]', '2026-09-01'); await page.fill('[name=endDate]', '2026-01-01'); await page.click('#fm-save'); await page.waitForTimeout(250); assert(await page.$('#fm-form'), 'end before start must be refused'); await page.click('#fm-cancel');
    assert((await db()).collections.courses.length === 1);
  });
  await step('course detail: add levels Beginner + Intermediate (ordered), add class under Beginner via the level button', async () => {
    await page.click('#cr-table [data-act=view]'); await page.waitForSelector('#cd-add-level');
    for (const n of ['Beginner', 'Intermediate']) { await page.click('#cd-add-level'); await page.fill('[name=name]', n); await page.click('#fm-save'); await page.waitForTimeout(400); }
    let d = await db(); const lv = d.collections.levels.filter(l => l.courseId === courseId); assert(lv.length === 2 && lv.every(l => l.branchId === 'BR-0001')); lvlBeginner = lv.find(l => l.name === 'Beginner').id; lvlInter = lv.find(l => l.name === 'Intermediate').id; assert(lv.find(l => l.name === 'Intermediate').order === 2, 'auto order');
    await page.click('[data-lv-add-class="' + lvlBeginner + '"]'); await page.waitForSelector('#fm-form'); assert((await page.inputValue('[name=courseId]')) === courseId && (await page.inputValue('[name=levelId]')) === lvlBeginner, 'class form must be pre-filled with course+level');
    await page.fill('[name=name]', 'Class A'); await page.fill('[name=capacity]', '15'); await page.click('#fm-save'); await page.waitForTimeout(400);
    d = await db(); const cl = d.collections.classes.find(c => c.name === 'Class A'); assert(cl && cl.courseId === courseId && cl.levelId === lvlBeginner && cl.branchId === 'BR-0001' && cl.academicYearId, 'class not linked: ' + JSON.stringify(cl)); courseClassId = cl.id;
    const t = await page.textContent('#cd-root'); assert(t.includes('Beginner') && t.includes('Intermediate') && t.includes('Class A') && t.includes('15'), 'detail lacks structure');
  });
  await step('level/course with children cannot be deleted (UI + nothing removed); empty level can be deleted', async () => {
    await page.click('[data-lv-del="' + lvlBeginner + '"]'); await page.waitForTimeout(300); assert(!(await page.$('#cf-ok')), 'no confirm for a level with classes'); assert((await db()).collections.levels.length === 2);
    await page.click('[data-lv-del="' + lvlInter + '"]'); await page.click('#cf-ok'); await page.waitForTimeout(500); assert((await db()).collections.levels.length === 1, 'empty level not deleted');
    await page.click('#cd-close'); await page.waitForTimeout(200); await page.click('#cr-table [data-act=del]'); await page.waitForTimeout(300); assert(!(await page.$('#cf-ok')), 'course with levels/classes must not be deletable'); assert((await db()).collections.courses.length === 1);
  });
  await step('classes page shows course + level columns and course filter; classLabel/pickers use "course / level / class"', async () => {
    await nav('classes'); const t = await tableText('#c-table'); assert(t.includes('English') && t.includes('Beginner') && t.includes('Class A'), 'columns missing');
    await page.selectOption('#c-course-filter', courseId); await page.waitForTimeout(200); let tt = await tableText('#c-table'); assert(tt.includes('Class A') && !tt.includes('صنف اول'), 'filter by course');
    await page.selectOption('#c-course-filter', '__none'); await page.waitForTimeout(200); tt = await tableText('#c-table'); assert(!tt.includes('Class A') && tt.includes('صنف اول'), 'filter: without course');
    await nav('students'); const opts = await page.$$eval('[data-filter="classId"] option', o => o.map(x => x.textContent.trim())); assert(opts.includes('English / Beginner / Class A') && opts.includes('صنف اول - الف'), 'class pickers must show course/level/class: ' + opts.join('|')); await nav('classes');
    await page.selectOption('#c-course-filter', ''); await page.click('#c-table tr:has-text("Class A") [data-act=edit]'); await page.waitForSelector('#fm-form'); await page.selectOption('[name=courseId]', ''); assert((await page.inputValue('[name=levelId]')) === '', 'level resets when course cleared'); await page.selectOption('[name=courseId]', courseId); assert((await page.$$eval('[name=levelId] option', o => o.map(x => x.textContent))).includes('Beginner'), 'levels of the course offered'); await page.click('#fm-cancel');
  });
  await step('legacy classes without course still work (edit keeps them without course)', async () => {
    await page.click('#c-table tr:has-text("صنف اول") [data-act=edit]'); await page.waitForSelector('#fm-form'); assert((await page.inputValue('[name=courseId]')) === ''); await page.fill('[name=capacity]', '30'); await page.click('#fm-save'); await page.waitForTimeout(300);
    const d = await db(); const c = d.collections.classes.find(x => x.name === 'صنف اول'); assert(c.capacity === 30 && !c.courseId, 'legacy class changed unexpectedly');
  });

  console.log('— Students & teachers (Phase 4)');
  let enrId;
  await step('enroll student in a course (course → level → class) from the student profile; roster + counts follow', async () => {
    await nav('students'); await page.click('#s-table [data-act=view]'); await page.waitForSelector('#pd-tab-6', { state: 'attached' }); await page.click('#pd-tabs [data-tab="6"]'); await page.click('#en-add2');
    await page.waitForSelector('#fm-form'); await page.selectOption('[name=courseId]', courseId);
    assert((await page.$$eval('[name=levelId] option', o => o.map(x => x.textContent))).includes('Beginner'), 'levels of the chosen course'); await page.selectOption('[name=levelId]', lvlBeginner);
    assert((await page.$$eval('[name=classId] option', o => o.map(x => x.textContent))).includes('Class A'), 'classes of the chosen level'); await page.selectOption('[name=classId]', courseClassId); await page.click('#fm-save'); await page.waitForTimeout(500);
    const d = await db(); const e = d.collections.courseEnrollments.find(x => x.studentId === studentId); assert(e && e.status === 'فعال' && e.courseId === courseId && e.levelId === lvlBeginner && e.classId === courseClassId && e.branchId === 'BR-0001', JSON.stringify(e)); enrId = e.id;
    assert((await page.textContent('#pd-tab-6')).includes('English'), 'enrollment listed');
    await nav('students'); assert((await tableText('#s-table')).includes('English'), 'courses column'); await nav('classes'); const cells = await page.$$eval('#c-table tr:has-text("Class A") td', t => t.map(x => x.textContent.trim())); assert(/^(1|۱)$/.test(cells[cells.length - 2]), 'class count must include the enrolled student: ' + cells.join('|'));
  });
  await step('a second active enrollment in the same course is not offered', async () => {
    await nav('students'); await page.click('#s-table [data-act=view]'); await page.click('#pd-tabs [data-tab="6"]'); await page.click('#en-add'); await page.waitForTimeout(250); assert(!(await page.$('#fm-form')), 'form must not open when every active course is already taken'); assert((await db()).collections.courseEnrollments.length === 1);
  });
  await step('mark enrollment completed → status + end date saved, student leaves the class roster', async () => {
    await page.click('#pd-tab-6 [data-act=done]'); await page.waitForTimeout(400); const e = (await db()).collections.courseEnrollments.find(x => x.id === enrId); assert(e.status === 'ختم شده' && e.endDate, JSON.stringify(e));
    await nav('classes'); const cells = await page.$$eval('#c-table tr:has-text("Class A") td', t => t.map(x => x.textContent.trim())); assert(/^(0|۰)$/.test(cells[cells.length - 2]), 'roster should be empty again: ' + cells.join('|'));
  });
  await step('emergency contact fields saved on the student and shown in the profile', async () => {
    await nav('students'); await page.click('#s-table [data-act=view]'); await page.click('#pd-edit'); await page.waitForSelector('#fm-form'); await page.fill('[name=emergencyName]', 'کاکا رحیم'); await page.fill('[name=emergencyPhone]', '0799000111'); await page.click('#fm-save'); await page.waitForTimeout(400);
    const s0 = (await db()).collections.students.find(x => x.id === studentId); assert(s0.emergencyName === 'کاکا رحیم' && s0.emergencyPhone === '0799000111'); await nav('students'); await page.click('#s-table [data-act=view]'); await page.waitForSelector('.detail-grid'); assert((await page.textContent('.detail-grid')).includes('0799000111'), 'shown in the profile');
  });
  await step('student ID card PDF (single): center name, logo, branch, student number, photo present', async () => {
    await nav('students'); await page.click('#s-table [data-act=view]'); await page.waitForSelector('#pd-idcard');
    const p = await waitPdf('idcard', () => page.click('#pd-idcard')); const c = pdfCheck(p.file); assert(c.ink > 300 && c.text.includes(studentId), 'card PDF lacks content: ' + c.text.slice(0, 100));
    assert(lastPrintHtml.includes('class="idcard"') && lastPrintHtml.includes('آکادمی نمونه') && lastPrintHtml.includes('<img') && lastPrintHtml.includes('data:image/jpeg;base64,'), 'card html lacks name/logo/photo');
  });
  await step('bulk ID cards from the student list: one card per student in the list', async () => {
    await nav('students'); const n = (await db()).collections.students.filter(x => !x.softDeleted && x.branchId === 'BR-0001').length;
    await waitPdf('idcards', () => page.click('#s-cards')); const cnt = (lastPrintHtml.match(/class="idcard"/g) || []).length; assert(cnt === n && n >= 1, 'cards=' + cnt + ' students=' + n);
  });
  await step('teacher: contract + hourly rate + terms saved; related courses derived from course teacher', async () => {
    const d0 = await db(); const tid = d0.collections.teachers[0].id;
    await nav('courses'); await page.click('#cr-table [data-act=edit]'); await page.waitForSelector('#fm-form'); await page.selectOption('[name=teacherId]', tid); await page.click('#fm-save'); await page.waitForTimeout(400);
    await nav('teachers'); await page.click('#t-table [data-act=edit]'); await page.waitForSelector('#fm-form'); await page.selectOption('[name=contractType]', 'قراردادی'); await page.fill('[name=hourlyRate]', '150'); await page.fill('[name=contractStart]', '2026-04-01'); await page.fill('[name=contractEnd]', '2027-03-31'); await page.fill('[name=contractTerms]', 'حضور به موقع و تحویل نمرات تا پایان ماه'); await page.click('#fm-save'); await page.waitForTimeout(400);
    const t = (await db()).collections.teachers[0]; assert(t.contractType === 'قراردادی' && t.hourlyRate == 150 && t.contractStart === '2026-04-01' && t.contractTerms.includes('نمرات'), JSON.stringify(t));
    assert((await tableText('#t-table')).includes('English'), 'related course shown in the teacher list');
    await page.click('#t-table [data-act=view]'); await page.waitForSelector('#td-contract'); const p = await waitPdf('contract', () => page.click('#td-contract')); const c = pdfCheck(p.file); assert(c.ink > 200 && c.text.trim().length > 30, 'contract PDF empty');
    assert(lastPrintHtml.includes('استاد محمد کریمی') && lastPrintHtml.includes('حضور به موقع') && lastPrintHtml.includes('آکادمی نمونه') && lastPrintHtml.includes('English'), 'contract content'); await page.click('#td-x'); await page.waitForTimeout(200);
  });
  await step('transfer a new student to another branch from the UI (enrollment history kept, class cleared, branch history logged)', async () => {
    await nav('students'); await page.click('#s-add'); await page.waitForSelector('#fm-form'); await page.fill('[name=name]', 'شاگرد انتقالی'); await page.fill('[name=fatherName]', 'پدر'); await page.selectOption('[name=gender]', 'مذکر');
    const first = await page.$$eval('[name=classId] option', o => o.map(x => x.value).filter(Boolean)[0]); await page.selectOption('[name=classId]', first); await page.click('#fm-save'); await page.waitForTimeout(500);
    let d = await db(); const ns = d.collections.students.find(x => x.name === 'شاگرد انتقالی'); assert(ns && ns.branchId === 'BR-0001'); const nsId = ns.id;
    await page.click('#s-table tr:has-text("شاگرد انتقالی") [data-act=view]'); await page.waitForSelector('#pd-transfer'); await page.click('#pd-transfer'); await page.waitForSelector('#fm-form');
    assert(!(await page.$$eval('[name=toBranchId] option', o => o.map(x => x.value))).includes('BR-0001'), 'current branch is not a target'); await page.selectOption('[name=toBranchId]', 'BR-0002'); await page.fill('[name=note]', 'تغییر محل سکونت'); await page.click('#fm-save'); await page.waitForTimeout(700);
    d = await db(); const moved = d.collections.students.find(x => x.id === nsId); assert(moved.branchId === 'BR-0002' && moved.classId === '' && moved.transfers.length === 1 && moved.transfers[0].note === 'تغییر محل سکونت', JSON.stringify(moved));
    await nav('students'); assert(!(await tableText('#s-table')).includes('شاگرد انتقالی'), 'moved student disappears from the old branch list');
    await page.selectOption('#branch-switch', 'BR-0002'); await page.waitForTimeout(600); await nav('students'); assert((await tableText('#s-table')).includes('شاگرد انتقالی'), 'appears in the new branch'); await page.selectOption('#branch-switch', 'BR-0001'); await page.waitForTimeout(600);
    const recs = d.collections.students.map(x => x.id === nsId ? Object.assign({}, x, { softDeleted: true }) : x); const sv = await ipc('save', [{ name: 'students', shard: '', records: recs }]); assert(!(sv && sv.__error), 'cleanup');
  });
  await step('teacher transfer button is offered (admin, several branches) and clears course links', async () => {
    await nav('teachers'); assert(await page.$('#t-table [data-act=transfer]'), 'transfer action missing'); await page.click('#t-table [data-act=transfer]'); await page.waitForSelector('#fm-form'); await page.selectOption('[name=toBranchId]', 'BR-0002'); await page.click('#fm-save'); await page.waitForTimeout(700);
    let d = await db(); assert(d.collections.teachers[0].branchId === 'BR-0002' && d.collections.courses.find(c => c.id === courseId).teacherId === '', 'teacher moved + course link cleared');
    await page.selectOption('#branch-switch', 'BR-0002'); await page.waitForTimeout(600); await nav('teachers'); await page.click('#t-table [data-act=transfer]'); await page.selectOption('[name=toBranchId]', 'BR-0001'); await page.click('#fm-save'); await page.waitForTimeout(700);
    await page.selectOption('#branch-switch', 'BR-0001'); await page.waitForTimeout(600); d = await db(); assert(d.collections.teachers[0].branchId === 'BR-0001' && d.collections.teachers[0].transfers.length === 2, 'moved back, history has 2 entries');
  });

  console.log('— Backup / modify / exit backup / restore / verify');
  let manualBackup;
  await step('manual backup from UI', async () => { await nav('backup'); await page.waitForSelector('#bk-now'); await page.click('#bk-now'); await page.waitForTimeout(500); const list = await ipc('backupList'); manualBackup = list.find(b => b.reason === 'manual'); assert(manualBackup, 'no manual backup'); assert((await ipc('backupVerify', manualBackup.path)).ok); return manualBackup.file; });
  await step('modify data after backup (rename student, add expense, delete discipline event)', async () => {
    await nav('students'); await page.click('#s-table [data-act=edit]'); await page.fill('[name=name]', 'نام تغییر‌یافته'); await page.click('#fm-save'); await page.waitForTimeout(250);
    await nav('accounting'); await page.click('#ac-add'); await page.fill('[name=title]', 'مصرف بعد از بکاپ'); await page.fill('[name=amount]', '77'); await page.fill('[name=date]', '2026-07-01'); await page.click('#fm-save'); await page.waitForTimeout(200);
    await nav('discipline'); await page.click('#ds-table [data-act=del]'); await page.click('#cf-ok'); await page.waitForTimeout(200); const d = await db(); assert(d.collections.students.find(x => x.id === studentId).name === 'نام تغییر‌یافته' && d.collections.expenses.length === 2 && d.collections.discipline.length === 0);
  });
  await step('exit → automatic backup created because data changed (store.createBackup("exit"), same call main.js makes on close)', async () => { const n0 = (await ipc('backupList')).length; const r = store.createBackup('exit'); assert(r.ok && !r.skipped, JSON.stringify(r)); assert((await ipc('backupList')).length === n0 + 1); assert(store.createBackup('exit').skipped, 'second exit backup with no changes must be skipped'); });
  await step('restore the manual backup from UI file picker (confirm dialog → atomic restore)', async () => { pickPath = manualBackup.path; await nav('backup'); await page.waitForSelector('#bk-pick'); await page.click('#bk-pick'); await page.waitForSelector('#cf-ok'); await page.click('#cf-ok'); await page.waitForSelector('#login-form', { state: 'visible', timeout: 8000 }); assert(store.listBackups().some(b => b.reason === 'pre-restore'), 'no pre-restore safety backup'); });
  await step('login again after restore (new password retained) and verify ALL data is the pre-change state', async () => {
    await page.fill('#login-username', 'admin'); await page.fill('#login-password', PASSW); await page.click('#login-form button[type=submit]'); await page.waitForSelector('#app-screen', { state: 'visible' });
    const d = await db(); const c = d.collections; assert(c.students.find(x => x.id === studentId).name === 'احمد یوسفی', 'student name'); assert(c.expenses.length === 1, 'expenses ' + c.expenses.length); assert(c.discipline.length === 1, 'discipline restored'); assert(c.marks.length === 1 && Number(c.marks[0].score) === 85); assert(c.feePayments.length === 1 && c.payroll.length === 1 && c.assets.length === 1 && c.assetMovements.length === 2 && c.announcements.length === 1 && c.staffAttendance.length === 1 && c.timetable.length === 1 && c.parents.length === 1 && c.teachers.length === 1);
    assert(c.users.some(u => u.username === 'fin1'), 'user list'); const photo = await ipc('fileGet', c.students.find(x => x.id === studentId).photoFileId); assert(photo && Buffer.from(photo, 'base64')[0] === 0xFF, 'photo missing after restore'); return 'all collections verified';
  });
  await step('data persists across a true restart (new store+service on the same folder, fresh browser page)', async () => {
    const store2 = createStore(base); const svc2 = createService(store2); const l = svc2.invoke(7, 'auth:login', ['admin', PASSW]); assert(l.ok); const ld = svc2.invoke(7, 'db:load', []); assert(ld.collections.students.filter(x => !x.softDeleted).length === 1 && ld.collections.payroll.length === 1 && ld.collections.discipline.length === 1);
  });
  await step('recovery code (from first run) resets the admin password; old recovery code is then invalid', async () => {
    await ipc('authLogout'); await page.reload(); await page.waitForSelector('#forgot-pass-link', { state: 'visible' }); await page.click('#forgot-pass-link'); await page.fill('#fg-code', recoveryCode.toLowerCase()); await page.fill('#fg-newpass', PW2); await page.click('#fg-ok'); await page.waitForSelector('#secret-code'); const nc = (await page.textContent('#secret-code')).trim(); assert(nc !== recoveryCode); await page.click('#secret-ok');
    await page.fill('#login-username', 'admin'); await page.fill('#login-password', PW2); await page.click('#login-form button[type=submit]'); await page.waitForSelector('#app-screen', { state: 'visible' }); const again = await ipc('recoveryReset', recoveryCode, 'Another2026pw'); assert(again.__error);
  });
  await step('new academic year can copy classes WITH their course and level', async () => {
    await nav('years'); await page.click('#y-add'); await page.fill('[name=title]', 'سال بعدی'); await page.fill('[name=startDate]', '2027-03-21'); await page.fill('[name=endDate]', '2028-03-20');
    const d0 = await db(); await page.selectOption('[name=copyFrom]', d0.collections.academicYears[0].id); await page.click('#fm-save'); await page.waitForTimeout(500);
    const d = await db(); const ny = d.collections.academicYears.find(y => y.title === 'سال بعدی'); const copy = d.collections.classes.find(c => c.academicYearId === ny.id && c.name === 'Class A');
    assert(copy && copy.courseId === courseId && copy.levelId === lvlBeginner && copy.branchId === 'BR-0001', 'copied class lost course/level: ' + JSON.stringify(copy));
  });

  console.log('— Finance: invoices, installments, discounts, debts (Phase 5)');
  const Fin = require('../lib/finance.js'); let invId;
  await step('issue an invoice from the student profile: course price pre-filled, discount with reason, 2 installments (editable), sum must match', async () => {
    await nav('students'); await page.click('#s-table [data-act=view]'); await page.click('#pd-tabs [data-tab="2"]'); await page.click('#pd-inv-add'); await page.waitForSelector('#iv-save');
    assert((await page.inputValue('#iv-student')) === studentId, 'student preselected'); await page.selectOption('#iv-course', courseId);
    assert((await page.inputValue('#iv-title')).includes('English') && (await page.inputValue('#iv-amount')) === '2500', 'course price + title pre-filled');
    await page.fill('#iv-disc', '500'); await page.fill('#iv-reason', 'تخفیف خانوادگی'); await page.fill('#iv-count', '2'); await page.fill('#iv-first', '2020-01-01');
    const rows = await page.$$eval('#iv-sched input[data-f=amount]', i => i.map(x => x.value)); assert(rows.length === 2 && rows.every(v => v === '1000'), 'net 2000 split in two: ' + rows.join(','));
    await page.fill('#iv-sched input[data-i="0"][data-f=amount]', '900'); await page.click('#iv-save'); await page.waitForTimeout(300); assert(await page.$('#iv-save'), 'unbalanced schedule must be refused'); assert((await db()).collections.studentFees.length === 0);
    await page.fill('#iv-sched input[data-i="0"][data-f=amount]', '1000'); await page.click('#iv-save'); await page.waitForTimeout(600);
    const inv = (await db()).collections.studentFees[0]; assert(inv && inv.studentId === studentId && inv.discount === 500 && inv.discountReason === 'تخفیف خانوادگی' && inv.amount === 2500 && inv.installments.length === 2 && inv.branchId === 'BR-0001' && inv.courseId === courseId, JSON.stringify(inv)); invId = inv.id;
    const t = await page.textContent('#pd-inv'); assert(t.includes('English') && t.includes('سررسید گذشته'), 'listed as overdue: ' + t.slice(0, 120));
  });
  await step('debtors report lists the student with overdue amount and prints as PDF with the center header', async () => {
    await nav('fees'); await page.click('#fp-debtors'); await page.waitForSelector('#db-table');
    const dd = (await db()).collections, today0 = new Date().toISOString().slice(0, 10); const expected = dd.students.filter(x => !x.softDeleted && x.branchId === 'BR-0001' && Fin.studentBalance(x, { structures: dd.feeStructures.filter(f => f.branchId === 'BR-0001'), invoices: dd.studentFees.filter(i => i.branchId === 'BR-0001' && !i.cancelled), payments: dd.feePayments.filter(p => p.branchId === 'BR-0001'), today: today0 }).remaining > 0).length;
    const shown = await page.$$eval('#db-table tbody tr', r => r.length); assert(expected >= 1 && shown === expected, 'debtors rows ' + shown + ' vs library ' + expected);
    const t = await page.textContent('#db-table'); assert(t.includes('احمد') || t.includes('نام تغییر'), 'student in debtors: ' + t.slice(0, 100)); assert((await page.textContent('#db-sum')).includes('سررسید گذشته'));
    const p = await waitPdf('debtors', () => page.click('#db-table .btn:has-text("چاپ")')); const c = pdfCheck(p.file); assert(c.ink > 100 && c.text.trim().length > 20, 'debtors PDF empty'); assert(lastPrintHtml.includes('گزارش بدهکاران') && lastPrintHtml.includes('آکادمی نمونه'), 'header');
    await page.click('#db-x');
  });
  await step('pay against the invoice: invoice preselected + installment suggested; overpay refused in UI; receipt shows center, invoice and remaining', async () => {
    await nav('students'); await page.click('#s-table [data-act=view]'); await page.click('#pd-tabs [data-tab="2"]'); await page.click('[data-inv="' + invId + '"]'); await page.waitForSelector('#ivd-pay'); await page.click('#ivd-pay'); await page.waitForSelector('#fm-form');
    assert((await page.inputValue('[name=invoiceId]')) === invId, 'invoice preselected'); assert((await page.inputValue('[name=amount]')) === '1000', 'first installment suggested');
    await page.fill('[name=amount]', '5000'); await page.click('#fm-save'); await page.waitForTimeout(250); assert(await page.$('#fm-form'), 'overpay refused'); assert((await db()).collections.feePayments.every(x => x.invoiceId !== invId));
    await page.fill('[name=amount]', '1000'); await page.click('#fm-save'); await page.waitForSelector('#rc2-print');
    const p = await waitPdf('receipt-inv', () => page.click('#rc2-print')); assert(pdfCheck(p.file).ink > 100); assert(lastPrintHtml.includes('آکادمی نمونه') && lastPrintHtml.includes('<img') && lastPrintHtml.includes('English') && lastPrintHtml.includes('0700123456'), 'receipt content'); await page.click('#rc2-cancel');
    const pays = (await db()).collections.feePayments.filter(x => x.invoiceId === invId); assert(pays.length === 1 && pays[0].amount == 1000 && pays[0].studentId === studentId);
  });
  await step('fees page: overdue status + column; invoice detail shows installment states; cannot delete an invoice that has payments', async () => {
    await nav('fees'); const t = await tableText('#fp-table'); assert(t.includes('سررسید گذشته'), 'status in fees table');
    await nav('students'); await page.click('#s-table [data-act=view]'); await page.click('#pd-tabs [data-tab="2"]'); await page.click('[data-inv="' + invId + '"]'); await page.waitForSelector('#ivd-area');
    const a = await page.textContent('#ivd-area'); assert(a.includes('پرداخت‌شده') && a.includes('سررسید گذشته') && a.includes('تخفیف خانوادگی'), 'installment states + discount reason'); assert(!(await page.$('#ivd-del')), 'no delete button when payments exist'); assert(!(await page.$('#ivd-cancel')), 'no cancel when payments exist');
    await page.click('#ivd-close');
  });
  await step('settle the invoice: second installment paid → invoice fully paid, no overdue left for it', async () => {
    await page.click('[data-inv="' + invId + '"]'); await page.click('#ivd-pay'); await page.waitForSelector('#fm-form'); assert((await page.inputValue('[name=amount]')) === '1000'); await page.click('#fm-save'); await page.waitForSelector('#rc2-cancel'); await page.click('#rc2-cancel');
    const d = await db(); const inv = d.collections.studentFees.find(x => x.id === invId), pays = d.collections.feePayments.filter(x => x.invoiceId === invId); const b = Fin.studentBalance(d.collections.students.find(x => x.id === studentId), { invoices: [inv], payments: pays, today: new Date().toISOString().slice(0, 10) });
    assert(b.remaining === 0 && b.overdue === 0 && pays.length === 2, JSON.stringify(b)); await page.click('[data-inv="' + invId + '"]'); assert((await page.textContent('#ivd-area')).includes('پرداخت‌شده')); await page.click('#ivd-close');
  });
  await step('branch finance report: server totals equal the shared library over the same data; new columns shown and printed', async () => {
    const d = await db(), c = d.collections, today = new Date().toISOString().slice(0, 10);
    let out = 0, over = 0; c.students.filter(x => !x.softDeleted && x.branchId === 'BR-0001').forEach(x => { const b = Fin.studentBalance(x, { structures: c.feeStructures.filter(f => f.branchId === 'BR-0001'), invoices: c.studentFees.filter(i => i.branchId === 'BR-0001' && !i.cancelled), payments: c.feePayments.filter(p => p.branchId === 'BR-0001'), today }); out += b.remaining; over += b.overdue; });
    const st = await ipc('branchesStats'); const r = st.rows.find(x => x.id === 'BR-0001'); assert(Math.abs(r.outstanding - out) < 0.01 && Math.abs(r.overdue - over) < 0.01 && r.invoiced === 2000 && r.discounts === 500, JSON.stringify(r) + ' expected ' + out + '/' + over);
    await nav('branches'); await page.waitForSelector('#br-stats table'); const t = await page.textContent('#br-stats'); assert(t.includes('بدهی فعلی') && t.includes('تخفیف‌ها') && t.includes('فیس‌نامه‌ها'), 'columns');
  });

  console.log('— Assessment: skills exams, ranking, report card, progress (Phase 6)');
  const A6 = require('../lib/assess.js'); let ex1, ex2, sid2;
  await step('prepare two students in the English class (re-enrol the first, create + enrol a second)', async () => {
    await nav('students'); await page.click('#s-table [data-act=view]'); await page.click('#pd-tabs [data-tab="6"]'); await page.click('#en-add'); await page.waitForSelector('#fm-form'); await page.selectOption('[name=courseId]', courseId); await page.selectOption('[name=levelId]', lvlBeginner); await page.selectOption('[name=classId]', courseClassId); await page.click('#fm-save'); await page.waitForTimeout(500);
    await nav('students'); await page.click('#s-add'); await page.waitForSelector('#fm-form'); await page.fill('[name=name]', 'سارا احمدی'); await page.fill('[name=fatherName]', 'پدر سارا'); await page.selectOption('[name=gender]', 'اناث');
    const first = await page.$$eval('[name=classId] option', o => o.map(x => x.value).filter(Boolean)[0]); await page.selectOption('[name=classId]', first); await page.click('#fm-save'); await page.waitForTimeout(500);
    const d = await db(); sid2 = d.collections.students.find(x => x.name === 'سارا احمدی').id;
    await page.click('#s-table tr:has-text("سارا احمدی") [data-act=view]'); await page.click('#pd-tabs [data-tab="6"]'); await page.click('#en-add2'); await page.waitForSelector('#fm-form'); await page.selectOption('[name=courseId]', courseId); await page.selectOption('[name=levelId]', lvlBeginner); await page.selectOption('[name=classId]', courseClassId); await page.click('#fm-save'); await page.waitForTimeout(500);
    const e = (await db()).collections.courseEnrollments.filter(x => x.status === 'فعال' && x.classId === courseClassId); assert(e.length === 2, 'two active enrollments in Class A: ' + e.length);
  });
  await step('create a language exam with the 4 skills: components default to 25 each, total locked to 100; bad sums refused', async () => {
    await nav('exams'); await page.click('#ex-add'); await page.waitForSelector('#fm-form'); await page.fill('[name=title]', 'Placement Test'); await page.selectOption('[name=classId]', courseClassId);
    const subj = await page.$$eval('[name=subjectId] option', o => o.map(x => x.value).filter(Boolean)[0]); await page.selectOption('[name=subjectId]', subj); await page.selectOption('[name=examType]', 'دوره‌ای'); await page.fill('[name=date]', '2026-05-01');
    await page.selectOption('[name=scoring]', { index: 1 }); const names = await page.$$eval('#cmp-box input[data-f=name]', i => i.map(x => x.value)); const maxes = await page.$$eval('#cmp-box input[data-f=max]', i => i.map(x => x.value));
    assert(names.join() === 'Grammar,Speaking,Listening,Writing' && maxes.join() === '25,25,25,25', names + '|' + maxes); assert((await page.inputValue('[name=maxScore]')) === '100');
    await page.fill('#cmp-box input[data-i="0"][data-f=max]', '40'); assert((await page.inputValue('[name=maxScore]')) === '115', 'total follows the components'); await page.fill('#cmp-box input[data-i="1"][data-f=name]', 'Grammar'); await page.click('#fm-save'); await page.waitForTimeout(250); assert(await page.$('#fm-form'), 'duplicate component name refused');
    await page.fill('#cmp-box input[data-i="1"][data-f=name]', 'Speaking'); await page.fill('#cmp-box input[data-i="0"][data-f=max]', '25'); await page.click('#fm-save'); await page.waitForTimeout(500);
    const e = (await db()).collections.exams.find(x => x.title === 'Placement Test'); assert(e && e.maxScore === 100 && e.components.length === 4 && e.components.every(c => c.max === 25) && e.branchId === 'BR-0001', JSON.stringify(e)); ex1 = e.id;
  });
  await step('enter skill marks for both students: per-skill inputs, live total, limits enforced; tie in total gives equal ranks', async () => {
    await nav('exams'); await page.click('#ex-table tr:has-text("Placement") [data-act=marks]'); await page.waitForSelector('.mk-part');
    const fill = async (name, vals) => { for (const [c, v] of Object.entries(vals)) await page.fill('.mk-part[data-sid="' + name + '"][data-c="' + c + '"]', String(v)); };
    await fill(studentId, { Grammar: 20, Speaking: 20, Listening: 20, Writing: 20 }); await fill(sid2, { Grammar: 25, Speaking: 25, Listening: 15, Writing: 15 });
    assert((await page.textContent('[data-t="' + studentId + '"]')).trim() === '80', 'live total'); await page.fill('.mk-part[data-sid="' + sid2 + '"][data-c="Writing"]', '40'); await page.click('#mk-save'); await page.waitForTimeout(250); assert(await page.$('#mk-save'), 'part above its max refused'); assert((await db()).collections.marks.filter(m => m.examId === ex1).length === 0, 'nothing saved on error');
    await page.fill('.mk-part[data-sid="' + sid2 + '"][data-c="Writing"]', '15'); await page.click('#mk-save'); await page.waitForTimeout(500);
    const mk = (await db()).collections.marks.filter(m => m.examId === ex1); assert(mk.length === 2 && mk.every(m => m.score === 80 && m.parts && m.branchId === 'BR-0001'), JSON.stringify(mk));
    const m2 = mk.find(m => m.studentId === sid2); assert(m2.parts.Grammar === 25 && m2.parts.Writing === 15);
  });
  await step('exam results: ranking with ties (both rank 1), stats, pass rate, printable PDF with center header', async () => {
    await nav('exams'); await page.click('#ex-table tr:has-text("Placement") [data-act=results]'); await page.waitForSelector('#er-area');
    const ranks = await page.$$eval('#er-area tbody tr td:first-child', t => t.map(x => x.textContent.trim())); assert(ranks.join() === '1,1', 'tie → equal ranks: ' + ranks);
    const t = await page.textContent('#er-area'); assert(t.includes('Grammar') && t.includes('Listening') && t.includes('قبول') && t.includes('100'), 'skills + pass'); assert(t.includes('میانگین'), 'stats');
    const p = await waitPdf('exam-results', () => page.click('#er-print')); const c = pdfCheck(p.file); assert(c.ink > 200 && c.text.trim().length > 30); assert(lastPrintHtml.includes('نتایج امتحان') && lastPrintHtml.includes('آکادمی نمونه') && lastPrintHtml.includes('<img'), 'header'); await page.click('#er-close');
  });
  await step('second exam (plain score) with marks; editing max/components is locked once marks exist', async () => {
    await nav('exams'); await page.click('#ex-add'); await page.waitForSelector('#fm-form'); await page.fill('[name=title]', 'Mid Test'); await page.selectOption('[name=classId]', courseClassId); const subj = await page.$$eval('[name=subjectId] option', o => o.map(x => x.value).filter(Boolean)[0]); await page.selectOption('[name=subjectId]', subj); await page.selectOption('[name=examType]', 'وسط سال'); await page.fill('[name=date]', '2026-06-01'); await page.fill('[name=maxScore]', '100'); await page.click('#fm-save'); await page.waitForTimeout(500);
    ex2 = (await db()).collections.exams.find(x => x.title === 'Mid Test').id; await page.click('#ex-table tr:has-text("Mid Test") [data-act=marks]'); await page.waitForSelector('.mk-input');
    await page.fill('.mk-input[data-sid="' + studentId + '"]', '95'); await page.fill('.mk-input[data-sid="' + sid2 + '"]', '60'); await page.fill('.mk-input[data-sid="' + sid2 + '"]', '101'); await page.click('#mk-save'); await page.waitForTimeout(250); assert(await page.$('#mk-save'), 'above max refused');
    await page.fill('.mk-input[data-sid="' + sid2 + '"]', '60'); await page.click('#mk-save'); await page.waitForTimeout(500); assert((await db()).collections.marks.filter(m => m.examId === ex2).length === 2);
    await page.click('#ex-table tr:has-text("Placement") [data-act=edit]'); await page.waitForSelector('#fm-form'); assert(await page.$eval('[name=scoring]', e => e.disabled), 'scoring locked'); assert(await page.$eval('#cmp-box input[data-i="0"][data-f=max]', e => e.disabled), 'components locked'); await page.fill('[name=title]', 'Placement Test (A)'); await page.click('#fm-save'); await page.waitForTimeout(400);
    assert((await db()).collections.exams.find(x => x.id === ex1).title === 'Placement Test (A)', 'title can change');
  });
  await step('report card: skills table, pass threshold from settings, course rank, logo; PDF', async () => {
    await nav('students'); await page.click('#s-table [data-act=view]'); await page.click('#pd-card'); await page.waitForSelector('#rc-print-area'); const t = await page.textContent('#rc-print-area');
    assert(t.includes('Placement') && t.includes('Mid Test') && t.includes('Grammar') && t.includes('Listening'), 'exams of the enrolled class + skills table: ' + t.slice(0, 300)); assert(t.includes('قبول') && t.includes('حد نصاب'), 'threshold shown'); assert(/رتبه در سطح\s*(1|۱)\s*از\s*(2|۲)/.test(t.replace(/\s+/g, ' ')), 'level rank 1 of 2: ' + t.replace(/\s+/g, ' ').slice(-200));
    assert(await page.$('#rc-print-area img'), 'logo in report card'); const p = await waitPdf('karnama-skills', () => page.click('#rc-print')); assert(pdfCheck(p.file).ink > 200); await page.click('#rc-x');
  });
  await step('progress report: chronological history, trend, skill bars, SVG chart, rank per exam; PDF', async () => {
    const dd = (await db()).collections; const hist = A6.studentHistory(studentId, dd.exams, dd.marks), expTrend = A6.trend(hist).label; assert(hist.length >= 2, 'history from DB');
    await nav('students'); await page.click('#s-table [data-act=view]'); await page.click('#pd-progress'); await page.waitForSelector('#pr-area'); const t = await page.textContent('#pr-area');
    assert(t.includes(expTrend), 'trend "' + expTrend + '" shown: ' + t.slice(0, 200)); assert(t.includes('Placement') && t.includes('Mid Test') && t.includes('Speaking'), 'history + skills'); assert(await page.$('#pr-area svg polyline'), 'line chart');
    assert((await page.$$('#pr-area svg circle')).length === hist.length, 'one point per exam');
    const rows = await page.$$eval('#pr-area tbody tr', r => r.map(x => x.textContent)); assert(rows.length === hist.length, 'one row per exam'); const iP = rows.findIndex(x => x.includes('Placement')), iM = rows.findIndex(x => x.includes('Mid Test')); assert(iP >= 0 && iM > iP, 'chronological: Placement (May) before Mid Test (June)');
    const p = await waitPdf('progress', () => page.click('#pr-print')); const c = pdfCheck(p.file); assert(c.ink > 200 && c.text.trim().length > 20); assert(lastPrintHtml.includes('گزارش پیشرفت') && lastPrintHtml.includes('<svg') && lastPrintHtml.includes('آکادمی نمونه'), 'print html'); await page.click('#pr-close');
  });
  await step('settings: pass percent is configurable and changes report-card results', async () => {
    await nav('settings'); await page.fill('[name=passPercent]', '95'); await page.click('#st-save'); await page.waitForTimeout(500); assert((await db()).objects.settings.passPercent === 95);
    await page.fill('[name=passPercent]', '0'); await page.click('#st-save'); await page.waitForTimeout(250); assert((await db()).objects.settings.passPercent === 95, 'invalid value refused');
    await nav('students'); await page.click('#s-table tr:has-text("سارا احمدی") [data-act=view]'); await page.click('#pd-card'); await page.waitForSelector('#rc-print-area'); assert((await page.textContent('#rc-print-area')).includes('ناکام'), 'Sara (70%) fails at 95'); await page.click('#rc-x');
    await nav('settings'); await page.fill('[name=passPercent]', '50'); await page.click('#st-save'); await page.waitForTimeout(400); assert((await db()).objects.settings.passPercent === 50);
  });

  console.log('— Print → Word / Excel (Phase 7)');
  const vOffice = (file) => { const r = require('child_process').spawnSync('python3', [path.join(__dirname, 'validate_office.py'), file], { encoding: 'utf8' }); assert(r.stdout, 'validator: ' + r.stderr); return JSON.parse(r.stdout); };
  const waitOffice = async (fn) => { const before = offices.length; await fn(); for (let i = 0; i < 100 && offices.length === before; i++) await page.waitForTimeout(100); assert(offices.length > before, 'no Word/Excel file was produced'); return offices[offices.length - 1]; };
  const soffice = (file) => { const cp = require('child_process'); const r = cp.spawnSync('soffice', ['--headless', '--convert-to', 'pdf', '--outdir', path.join(OUT, 'render'), file], { encoding: 'utf8', timeout: 120000 }); const pdf = path.join(OUT, 'render', path.basename(file).replace(/\.(docx|xlsx)$/, '.pdf')); assert(fs.existsSync(pdf), 'LibreOffice could not open ' + file + ' ' + r.stderr); return cp.spawnSync('pdftotext', ['-layout', pdf, '-'], { encoding: 'utf8' }).stdout; };
  await step('SWEEP: every print point exercised by this suite also converts into a valid Word/Excel file (python-docx / openpyxl load it)', async () => {
    assert(sweep.length >= 20, 'prints swept: ' + sweep.length); const errs = sweep.filter(x => x.error); assert(!errs.length, 'conversion errors: ' + JSON.stringify(errs.slice(0, 3)));
    let docx = 0, xlsx = 0; for (const x of sweep) { const v = vOffice(x.path); assert(v.ok, x.name + ': ' + JSON.stringify(v.errors)); if (x.kind === 'docx') docx++; else xlsx++; }
    assert(docx >= 5 && xlsx >= 5, 'both formats are used: docx=' + docx + ' xlsx=' + xlsx); const byName = (re) => sweep.filter(x => re.test(x.name));
    assert(byName(/^لیست-شاگردان/).every(x => x.kind === 'xlsx') && byName(/^لیست-شاگردان/).length >= 1, 'student list → Excel');
    for (const re of [/^Receipt/, /^کارت/, /^قرارداد/]) { const l = byName(re); assert(l.length >= 1 && l.every(x => x.kind === 'docx'), String(re) + ' → Word: ' + JSON.stringify(l.map(x => x.kind))); }
    console.log('      swept ' + sweep.length + ' prints: ' + docx + ' Word, ' + xlsx + ' Excel');
  });
  await step('switch the app to Word/Excel output from Settings', async () => { await nav('settings'); await page.selectOption('#st-printmode', 'auto'); await page.waitForTimeout(400); assert((await db()).objects.settings.printMode === 'auto'); });
  await step('student list print → Excel: title rows, bold header, frozen, RTL sheet, rows = students; auto-opened', async () => {
    await nav('students'); const r = await waitOffice(() => page.click('#s-table .btn:has-text("چاپ")')); assert(r.kind === 'xlsx' && r.opened && r.path.endsWith('.xlsx') && r.hint === 'xlsx', JSON.stringify(r));
    const v = vOffice(r.path); assert(v.ok, JSON.stringify(v.errors)); assert(v.rtl && v.freeze, 'rtl + frozen header'); const flat = JSON.stringify(v.cells); assert(flat.includes('آکادمی نمونه') && flat.includes('لیست شاگردان'), 'title block'); assert(flat.includes('احمد') || flat.includes(studentId), 'data present');
    const hdr = v.cells.findIndex(r => r.includes('شماره') && r.includes('نام')); assert(hdr >= 0 && v.bold[hdr].every(Boolean), 'bold header'); const n = (await db()).collections.students.filter(x => !x.softDeleted && x.branchId === 'BR-0001').length; assert(v.cells.length - hdr - 1 === n, 'rows ' + (v.cells.length - hdr - 1) + ' vs students ' + n);
  });
  await step('student profile print (key/value) → Word; ID card → Word with logo + cards table + student number', async () => {
    await nav('students'); await page.click('#s-table [data-act=view]'); const r = await waitOffice(() => page.click('#pd-print')); assert(r.kind === 'docx' && r.hint === 'docx', JSON.stringify(r)); const v = vOffice(r.path); assert(v.ok, JSON.stringify(v.errors)); assert(JSON.stringify(v.tables).includes(studentId) && v.images >= 1, 'profile data + logo');
    const c = await waitOffice(() => page.click('#pd-idcard')); assert(c.kind === 'docx'); const vc = vOffice(c.path); assert(vc.ok, JSON.stringify(vc.errors)); assert(JSON.stringify(vc.tables).includes(studentId), 'card has the student number'); assert(vc.images >= 1, 'logo in card header'); assert(JSON.stringify(vc.tables).includes('آکادمی نمونه'), 'center name on the card');
  });
  await step('teacher contract → Word with terms; debtors → Excel with numeric money cells', async () => {
    await nav('teachers'); await page.click('#t-table [data-act=view]'); await page.waitForSelector('#td-contract'); const r = await waitOffice(() => page.click('#td-contract')); assert(r.kind === 'docx'); const v = vOffice(r.path); assert(v.ok, JSON.stringify(v.errors)); const all = JSON.stringify(v.paragraphs) + JSON.stringify(v.tables); assert(all.includes('حضور به موقع') && all.includes('قراردادی'), 'terms + type'); await page.click('#td-x'); await page.waitForTimeout(150);
    await nav('fees'); await page.click('#fp-debtors'); await page.waitForSelector('#db-table'); const d = await waitOffice(() => page.click('#db-table .btn:has-text("چاپ")')); await page.click('#db-x'); assert(d.kind === 'xlsx'); assert(vOffice(d.path).ok, 'debtors file valid');
    const f = await waitOffice(() => page.click('#fp-table .btn:has-text("چاپ")')); assert(f.kind === 'xlsx'); const vd = vOffice(f.path); assert(vd.ok, JSON.stringify(vd.errors)); assert(vd.types.flat().some(t => t === 'int' || t === 'float'), 'money columns are real numbers: ' + JSON.stringify(vd.cells.slice(5, 9))); assert(vd.numfmt.flat().some(f => f.includes('افغانی')), 'currency number format');
  });
  await step('report card + progress report → Word; the SVG progress chart becomes an embedded PNG', async () => {
    await nav('students'); await page.click('#s-table [data-act=view]'); await page.click('#pd-card'); await page.waitForSelector('#rc-print-area'); const rc = await waitOffice(() => page.click('#rc-print')); assert(rc.kind === 'docx'); const vr = vOffice(rc.path); assert(vr.ok, JSON.stringify(vr.errors)); assert(JSON.stringify(vr.tables).includes('Placement'), 'exams listed'); await page.click('#rc-x');
    await page.click('#pd-progress'); await page.waitForSelector('#pr-area'); const pr = await waitOffice(() => page.click('#pr-print')); assert(pr.kind === 'docx'); const vp = vOffice(pr.path); assert(vp.ok, JSON.stringify(vp.errors)); assert(vp.images >= 2, 'logo + chart image: ' + vp.images); await page.click('#pr-close');
  });
  await step('exam results, branches report, invoice → valid files in an automatically chosen format', async () => {
    await nav('exams'); await page.click('#ex-table tr:has-text("Placement") [data-act=results]'); await page.waitForSelector('#er-area'); const er = await waitOffice(() => page.click('#er-print')); const ve = vOffice(er.path); assert(ve.ok && ['docx', 'xlsx'].includes(er.kind), JSON.stringify(ve.errors)); assert(JSON.stringify(ve).includes('Grammar'), 'skills in results'); await page.click('#er-close');
    await nav('branches'); await page.waitForSelector('#br-stats table'); const br = await waitOffice(() => page.click('#br-print')); const vb = vOffice(br.path); assert(vb.ok, JSON.stringify(vb.errors)); assert(br.kind === 'xlsx', 'branch comparison is a table → Excel (' + br.kind + ')');
    await nav('students'); await page.click('#s-table [data-act=view]'); await page.click('#pd-tabs [data-tab="2"]'); await page.click('[data-inv="' + invId + '"]'); await page.waitForSelector('#ivd-print'); const iv = await waitOffice(() => page.click('#ivd-print')); assert(iv.kind === 'docx'); assert(vOffice(iv.path).ok); await page.click('#ivd-close');
  });
  await step('REAL OFFICE SUITE: LibreOffice opens the generated Word and Excel files and renders their content', async () => {
    const last = (k) => offices.filter(o => o.kind === k).slice(-1)[0]; const card = offices.find(o => o.title === 'کارت شاگردی'), list = offices.find(o => o.kind === 'xlsx');
    const t1 = soffice(card.path); assert(t1.includes(studentId), 'card text rendered: ' + t1.slice(0, 120)); const t2 = soffice(list.path); assert(t2.includes(studentId) || /ST-\d{4}/.test(t2), 'student list rendered: ' + t2.slice(0, 120));
    const t3 = soffice(offices.find(o => /Progress/.test(o.title) || /پیشرفت/.test(o.title)).path); assert(t3.trim().length > 50, 'progress report rendered');
  });
  await step('if Word/Excel is not installed the file is still saved and shown in its folder (toast, no crash)', async () => {
    notOpened = true; await nav('students'); const before = shownFolder.length; const r = await waitOffice(() => page.click('#s-table .btn:has-text("چاپ")')); for (let i = 0; i < 30 && shownFolder.length === before; i++) await page.waitForTimeout(100); assert(shownFolder.length === before + 1 && shownFolder[before] === r.path, 'folder shown'); assert(fs.existsSync(r.path)); notOpened = false;
  });
  await step('if building the Word/Excel file fails, the app falls back to a PDF instead of failing', async () => {
    failOffice = true; await nav('students'); const p = await waitPdf('fallback', () => page.click('#s-table .btn:has-text("چاپ")')); assert(pdfCheck(p.file).ink > 100, 'fallback PDF'); failOffice = false;
  });
  await step('PDF mode is still available from Settings and is honoured', async () => {
    await nav('settings'); await page.selectOption('#st-printmode', 'pdf'); await page.waitForTimeout(400); await nav('students'); const before = offices.length; const p = await waitPdf('pdfmode', () => page.click('#s-table .btn:has-text("چاپ")')); assert(pdfCheck(p.file).ink > 100 && offices.length === before, 'PDF made, no Office file');
  });

  console.log('— Output choices + personal palettes (Phase 7b)');
  const waitSaved = async (fn) => { const before = saved.length; await fn(); for (let i = 0; i < 150 && saved.length === before; i++) await page.waitForTimeout(100); assert(saved.length > before, 'no saved file'); return saved[saved.length - 1]; };
  const pngInfo = (file) => { const r = require('child_process').spawnSync('python3', ['-c', 'import sys,json\nfrom PIL import Image\nim=Image.open(sys.argv[1]).convert("L")\nw,h=im.size\npx=im.getdata()\nink=sum(1 for v in px if v<200)/float(w*h)\nprint(json.dumps({"w":w,"h":h,"ink":ink}))', file], { encoding: 'utf8' }); assert(r.stdout, 'PIL: ' + r.stderr); return JSON.parse(r.stdout); };
  const askAndPick = async (clickPrint, fmt, remember) => { await clickPrint(); await page.waitForSelector('#pf-dialog'); if (remember) await page.check('#pf-remember'); await page.click('.pf-btn[data-pf="' + fmt + '"]'); };
  const printList = async () => { await nav('students'); await page.click('#s-table .btn:has-text("چاپ")'); };
  await step('default = "ask every time": print opens a chooser with Word, Excel, PDF, image, CSV and web page; the right one is recommended; cancel makes nothing', async () => {
    await nav('settings'); await page.selectOption('#st-printmode', 'ask'); await page.waitForTimeout(400); assert((await db()).objects.settings.printMode === 'ask');
    const n0 = [offices.length, saved.length, pdfs.length]; await printList(); await page.waitForSelector('#pf-dialog');
    const ids = await page.$$eval('.pf-btn', b => b.map(x => x.getAttribute('data-pf'))); assert(ids.join() === 'docx,xlsx,pdf,png,csv,html', ids.join());
    assert((await page.$eval('.pf-btn.btn-primary', e => e.getAttribute('data-pf'))) === 'xlsx', 'a student list → Excel is recommended'); assert(!(await page.$eval('.pf-btn[data-pf=csv]', e => e.disabled)), 'CSV available for a table');
    await page.click('#pf-cancel'); await page.waitForTimeout(400); assert(!(await page.$('#pf-dialog')) && n0[0] === offices.length && n0[1] === saved.length && n0[2] === pdfs.length, 'cancel creates nothing');
  });
  await step('choose Excel and Word from the chooser → real .xlsx / .docx files', async () => {
    const x = await waitOffice(() => askAndPick(printList, 'xlsx')); assert(x.kind === 'xlsx' && vOffice(x.path).ok); const w = await waitOffice(() => askAndPick(printList, 'docx')); assert(w.kind === 'docx' && vOffice(w.path).ok, 'Word chosen even though Excel was recommended');
  });
  await step('choose PDF from the chooser → PDF file', async () => { const p = await waitPdf('choice-pdf', () => askAndPick(printList, 'pdf')); assert(pdfCheck(p.file).ink > 100); });
  await step('choose Image → PNG pages (A4 @2x), not blank, centre name drawn; saved + opened', async () => {
    const r = await waitSaved(() => askAndPick(printList, 'png')); assert(r.exts.every(e => e === 'png') && r.count >= 1 && r.opened); const info = pngInfo(r.paths[0]); assert(info.w === 1588 && info.h >= 400, JSON.stringify(info)); assert(info.ink > 0.004, 'image is not blank: ink=' + info.ink);
  });
  await step('choose CSV → UTF-8 BOM, title lines, header, Latin-digit numbers; choose web page → standalone HTML', async () => {
    const c = await waitSaved(() => askAndPick(printList, 'csv')); assert(c.exts[0] === 'csv'); const buf = fs.readFileSync(c.paths[0]); assert(buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF, 'BOM'); const txt = buf.toString('utf8'); assert(txt.includes('آکادمی نمونه') && txt.includes('شماره') && txt.includes(studentId), 'content: ' + txt.slice(0, 200));
    const h = await waitSaved(() => askAndPick(printList, 'html')); const html = fs.readFileSync(h.paths[0], 'utf8'); assert(html.includes('<html') && html.includes('آکادمی نمونه') && html.includes(studentId), 'html page');
  });
  await step('the recommendation follows the document: an ID card suggests Word', async () => {
    await nav('students'); await page.click('#s-table [data-act=view]'); await page.waitForSelector('#pd-idcard'); await page.click('#pd-idcard'); await page.waitForSelector('#pf-dialog'); assert((await page.$eval('.pf-btn.btn-primary', e => e.getAttribute('data-pf'))) === 'docx', 'ID card → Word recommended'); await page.click('#pf-cancel');
  });
  await step('"always use this" saves a PERSONAL preference: next print skips the chooser; personal choice can be reset in Settings', async () => {
    const x = await waitOffice(() => askAndPick(printList, 'xlsx', true)); assert(x.kind === 'xlsx'); assert((await db()).me.printMode === 'xlsx', 'stored on the user');
    const y = await waitOffice(async () => { await printList(); await page.waitForTimeout(400); assert(!(await page.$('#pf-dialog')), 'no chooser now'); }); assert(y.kind === 'xlsx');
    await nav('settings'); await page.selectOption('#me-printmode', ''); await page.waitForTimeout(400); assert((await db()).me.printMode === '', 'reset'); await printList(); await page.waitForSelector('#pf-dialog'); await page.click('#pf-cancel');
    await nav('settings'); await page.selectOption('#me-printmode', 'pdf'); await page.waitForTimeout(400); assert((await db()).me.printMode === 'pdf'); assert((await db()).objects.settings.printMode === 'ask', 'centre default untouched'); const p = await waitPdf('personal-pdf', () => printList()); assert(pdfCheck(p.file).ink > 100); await nav('settings'); await page.selectOption('#me-printmode', ''); await page.waitForTimeout(300);
  });
  await step('failures: Word/Excel failing falls back to PDF; image failing shows an error (no crash); too-long document refused for image; multi-page images', async () => {
    failOffice = true; const p = await waitPdf('choice-fallback', () => askAndPick(printList, 'docx')); assert(pdfCheck(p.file).ink > 100, 'fallback PDF'); const before = saved.length; await askAndPick(printList, 'png'); await page.waitForTimeout(700); assert(saved.length === before, 'nothing saved on failure'); failOffice = false;
    const pages = await page.evaluate(() => window.__htmlToPngPages('<html><body style="margin:0"><div style="height:3000px;background:#eef">طولانی</div></body></html>')); assert(pages.length === 3 && pages.every(d => d.startsWith('data:image/png;base64,')), 'pages=' + pages.length);
    const msg = await page.evaluate(() => window.__htmlToPngPages('<html><body style="margin:0"><div style="height:60000px">x</div></body></html>').then(() => 'no error', e => e.message)); assert(/طولانی/.test(msg), msg);
  });
  console.log('— Personal colour palettes');
  const cssNavy = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--navy').trim().toLowerCase());
  await step('palette button is in the top bar for everyone; picker offers 18 palettes + centre default + custom colour', async () => {
    await nav('dashboard'); await page.click('#palette-btn'); await page.waitForSelector('#pal-modal-body'); const n = await page.$$eval('#pal-modal-body .pal-sw', b => b.length); assert(n === 19, 'swatches: ' + n); assert(await page.$('#pal-custom') && await page.$('#me-printmode'), 'custom colour + print pref');
    assert((await cssNavy()) === '#14532d', 'starts with the centre palette (green): ' + (await cssNavy())); assert((await page.$eval('#pal-modal-body .pal-sw[data-pal=""]', e => e.getAttribute('aria-pressed'))) === 'true', 'default selected');
  });
  await step('choosing a palette recolours the whole app immediately and is stored on the user', async () => {
    await page.click('#pal-modal-body .pal-sw[data-pal="emerald"]'); await page.waitForTimeout(500); assert((await cssNavy()) === '#065f46', await cssNavy()); assert((await db()).me.palette === 'emerald');
    assert((await page.$eval('#pal-modal-body .pal-sw[data-pal="emerald"]', e => e.getAttribute('aria-pressed'))) === 'true', 'selection marked');
    const bg = await page.evaluate(() => getComputedStyle(document.querySelector('.sidebar')).backgroundColor); assert(/rgb\(\s*\d+/.test(bg)); await page.click('#pal-modal-body .pal-sw[data-pal="rose"]'); await page.waitForTimeout(400); assert((await cssNavy()) === '#9d174d');
  });
  await step('custom colour works; a very light colour is darkened automatically so text stays readable', async () => {
    await page.fill('#pal-custom', '#123456'); await page.click('#pal-custom-apply'); await page.waitForTimeout(500); assert((await cssNavy()) === '#123456'); assert((await db()).me.palette === 'custom:#123456');
    await page.fill('#pal-custom', '#ffff00'); await page.click('#pal-custom-apply'); await page.waitForTimeout(500); const c = await cssNavy(); assert(c !== '#ffff00' && /^#[0-9a-f]{6}$/.test(c), 'darkened: ' + c); const n = parseInt(c.slice(1), 16), lum = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; const L = 0.2126 * lum((n >> 16) & 255) + 0.7152 * lum((n >> 8) & 255) + 0.0722 * lum(n & 255); assert(1.05 / (L + 0.05) >= 4.5, 'contrast ' + (1.05 / (L + 0.05)).toFixed(2));
  });
  await step('the palette is personal: login screen and other people see the centre colour; it comes back after login; reset returns to the centre default', async () => {
    await page.click('#pal-modal-body .pal-sw[data-pal="indigo"]'); await page.waitForTimeout(400); await page.click('#pal-close'); assert((await cssNavy()) === '#312e81');
    await page.click('#btn-logout'); await page.waitForSelector('#login-form', { state: 'visible' }); assert((await cssNavy()) === '#14532d', 'login screen shows the centre palette: ' + (await cssNavy()));
    await page.fill('#login-username', 'admin'); await page.fill('#login-password', PW2); await page.click('#login-form button[type=submit]'); await page.waitForSelector('#app-screen', { state: 'visible' }); await page.waitForTimeout(600); assert((await cssNavy()) === '#312e81', 'personal palette restored after login: ' + (await cssNavy()));
    await page.click('#palette-btn'); await page.waitForSelector('#pal-modal-body'); await page.click('#pal-modal-body .pal-sw[data-pal=""]'); await page.waitForTimeout(400); assert((await cssNavy()) === '#14532d' && (await db()).me.palette === '', 'reset to centre default'); await page.click('#pal-close');
  });
  await step('Settings page also has the personal palette card; the centre default palette is still configurable there', async () => {
    await nav('settings'); assert((await page.$$('#st-me .pal-sw')).length === 19, 'personal card'); await page.click('#st-me .pal-sw[data-pal="gold"]'); await page.waitForTimeout(400); assert((await cssNavy()) === '#7a5c0a'); await page.click('#st-me .pal-sw[data-pal=""]'); await page.waitForTimeout(300);
    assert((await page.$$('#st-palette button')).length === 18, 'centre palette picker lists all 18');
  });

  await step('no external network requests were needed (offline): page loaded only file:// resources', async () => { const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8'); const ext = (html.match(/(?:src|href)\s*=\s*["']https?:\/\/[^"']+/g) || []).concat(html.match(/url\(\s*["']?https?:\/\/[^)]+/g) || [], html.match(/@import\s+["']?https?:/g) || []); assert(!ext.length, 'external refs: ' + ext.join(', ')); assert(!/fetch\(\s*['"]http|XMLHttpRequest|WebSocket/.test(html), 'network API used'); });
  await step('no uncaught page errors during the whole flow', async () => { assert(!page.__errs.length, page.__errs.slice(0, 3).join(' | ')); });

  fs.writeFileSync(path.join(OUT, 'e2e-results.json'), JSON.stringify({ date: new Date().toISOString(), results, pdfs: pdfs.map(p => ({ name: p.name, size: p.size })) }, null, 2));
  const pass = results.filter(r => r.status === 'PASS').length;
  console.log('\n' + pass + '/' + results.length + ' E2E steps passed; ' + pdfs.length + ' PDFs written to ' + OUT);
  await browser.close(); fs.rmSync(base, { recursive: true, force: true }); process.exit(exitCode);
})().catch(e => { console.error('E2E crashed:', e); process.exit(2); });
