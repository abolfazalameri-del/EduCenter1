const { app, BrowserWindow, Menu, session, ipcMain, dialog, shell, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const APP_ID = 'com.educenter.manager';
const APP_TITLE = 'مدیریت مرکز آموزشی';   // عنوان پیش‌فرض؛ نام واقعی از تنظیمات برنامه خوانده می‌شود
const SELFTEST = process.env.EDUCENTER_SELFTEST || '';            // مسیر فایل گزارش self-test (فقط برای CI)
if (process.env.EDUCENTER_USERDATA) app.setPath('userData', process.env.EDUCENTER_USERDATA);
app.setAppUserModelId(APP_ID);

const { createStore } = require('./lib/store');
const { createService } = require('./lib/service');
const { CHANNEL_RULES } = require('./lib/authz');
const office = require('./lib/office');

// فقط یک نمونه از برنامه (جلوگیری از باز شدن همزمان دو نسخه روی یک پایگاه داده)
if (!SELFTEST && !app.requestSingleInstanceLock()) { app.quit(); }

let win = null, store = null, service = null;
let autoTimer = null, periodicTimer = null, closing = false;

function logErr(e) { try { fs.appendFileSync(path.join(app.getPath('userData'), 'error.log'), new Date().toISOString() + ' ' + (e && e.stack || e) + '\n'); } catch (_) { /* ignore */ } }
process.on('uncaughtException', logErr);
process.on('unhandledRejection', logErr);

function safeBackup(reason) {
  try { return store.createBackup(reason); } catch (e) { logErr(e); return { error: e.message }; }
}
function scheduleAutoBackup() {
  const c = store.getConfig();
  if (!c.autoOnChange) return;
  clearTimeout(autoTimer);
  autoTimer = setTimeout(() => safeBackup('auto'), Math.max(1, c.autoDelayMin) * 60 * 1000);   // بعد از توقف تغییرات
}
function setupPeriodic() {
  clearInterval(periodicTimer);
  const c = store.getConfig();
  if (c.periodicMin > 0) periodicTimer = setInterval(() => safeBackup('periodic'), c.periodicMin * 60 * 1000);
}

// ---------- تولید PDF از یک سند HTML مستقل (بدون وابستگی به DOM/CSS چاپ صفحه‌ی اصلی) ----------
async function htmlToPdf(html) {
  if (typeof html !== 'string' || html.length < 50 || html.length > 40 * 1024 * 1024) throw new Error('محتوای چاپ نامعتبر است.');
  const tmp = path.join(app.getPath('temp'), 'educenter-print-' + process.pid + '-' + Date.now() + '.html');
  fs.writeFileSync(tmp, html, 'utf8');
  const w = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false, webSecurity: true } });
  try {
    await w.loadFile(tmp);
    await new Promise(r => setTimeout(r, 200));                // فرصت برای چیدمان/فونت‌های سیستم
    const buf = await w.webContents.printToPDF({ printBackground: true, pageSize: 'A4', preferCSSPageSize: true });
    if (!buf || buf.length < 1000 || buf.slice(0, 4).toString() !== '%PDF') throw new Error('تولید PDF ناموفق بود.');
    return buf;
  } finally { try { w.destroy(); } catch (_) { /* ignore */ } try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ } }
}

// ---------- IPC ----------
function applyWindowBranding(b) {
  if (!win || !b) return;
  try { win.setTitle(String(b.centerName || APP_TITLE).slice(0, 120)); } catch (_) { /* ignore */ }
  try {
    if (typeof b.logo === 'string' && /^data:image\/(png|jpeg);base64,/.test(b.logo) && b.logo.length < 600000) { const img = nativeImage.createFromDataURL(b.logo); if (!img.isEmpty()) win.setIcon(img); }
    else win.setIcon(path.join(__dirname, 'build', 'icon.png'));
  } catch (_) { /* ignore */ }
}
function exportsDir() {
  let nm = 'EduCenter';
  try { const st = store.readObject('settings'); if (st && (st.centerName || st.schoolName)) nm = office.safeName(st.centerName || st.schoolName); } catch (_) { /* ignore */ }
  return path.join(app.getPath('documents'), nm + ' - Exports');
}
const ELECTRON_ONLY = {
  'branding:apply': async (b) => { applyWindowBranding(b); return { ok: true }; },
  'backup:chooseDir': async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], title: 'پوشه‌ی پشتیبان' });
    return r.canceled ? null : r.filePaths[0];
  },
  'backup:pickFile': async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'EduCenter Backup', extensions: ['json'] }], defaultPath: store.getConfig().backupDir });
    if (r.canceled) return null;
    service.allowRestorePath(r.filePaths[0]);                  // فقط فایلی که کاربر خودش با دیالوگ انتخاب کرده قابل Restore است
    return r.filePaths[0];
  },
  'backup:openFolder': () => shell.openPath(store.getConfig().backupDir),
  'dialog:saveText': async (name, content) => {
    if (typeof content !== 'string' || content.length > 50 * 1024 * 1024) throw new Error('محتوا نامعتبر است.');
    const r = await dialog.showSaveDialog(win, { defaultPath: String(name || 'export.csv') });
    if (r.canceled) return null;
    fs.writeFileSync(r.filePath, '\uFEFF' + content, 'utf8');
    return r.filePath;
  },
  // چاپ = ساخت فایل واقعی Word (.docx) یا Excel (.xlsx) (قالب را خود برنامه از ساختار سند تشخیص می‌دهد) و باز کردن آن در همان برنامه
  'print:office': async (req) => {
    if (!req || typeof req !== 'object') throw new Error('درخواست نامعتبر است.');
    const dir = exportsDir();
    const r = office.exportDocument({ kind: req.kind, title: String(req.title || 'سند').slice(0, 120), name: req.name, model: req.model, dir });
    const err = await shell.openPath(r.path);                  // رشته‌ی خالی = موفق؛ در غیر این صورت (مثلاً Office نصب نیست) مسیر فایل به کاربر نشان داده می‌شود
    return { path: r.path, size: r.size, kind: r.kind, app: r.app, opened: !err, error: err || undefined };
  },
  // خروجی‌های دیگر: تصویر PNG، CSV، صفحه‌ی وب؛ در همان پوشه‌ی خروجی‌ها ذخیره و باز می‌شوند (چند صفحه‌ی تصویر ⇒ پوشه باز می‌شود)
  'print:saveFiles': async (req) => {
    if (!req || typeof req !== 'object') throw new Error('درخواست نامعتبر است.');
    const r = office.saveFiles({ files: req.files, dir: exportsDir(), name: String(req.name || 'document').slice(0, 80) });
    const err = await shell.openPath(r.count === 1 ? r.paths[0] : r.dir);
    return { paths: r.paths, dir: r.dir, count: r.count, size: r.size, opened: !err, error: err || undefined };
  },
  'file:showInFolder': async (p) => {
    const dir = path.resolve(exportsDir()), target = path.resolve(String(p || ''));
    if (!target.startsWith(dir + path.sep)) throw new Error('مسیر مجاز نیست.');
    shell.showItemInFolder(target); return { ok: true };
  },
  'print:pdf': async (name, html) => {
    const buf = await htmlToPdf(html);                          // ابتدا ساخت PDF؛ سپس انتخاب مسیر
    const r = await dialog.showSaveDialog(win, { defaultPath: String(name || 'report.pdf'), filters: [{ name: 'PDF', extensions: ['pdf'] }] });
    if (r.canceled) return null;
    fs.writeFileSync(r.filePath, buf);
    return { path: r.filePath, size: buf.length };
  }
};

function registerIPC() {
  Object.keys(CHANNEL_RULES).forEach((ch) => {
    ipcMain.handle(ch, async (e, ...args) => {
      try {
        if (ELECTRON_ONLY[ch]) { service.authorize(e.sender.id, ch); return await ELECTRON_ONLY[ch](...args); }
        const r = service.invoke(e.sender.id, ch, args);
        if (ch === 'backup:setConfig') setupPeriodic();
        return r;
      } catch (err) {
        if (!err.code) logErr(err);                             // خطاهای مجاز (FORBIDDEN و ...) در error.log نمی‌آیند
        return { __error: err.message, code: err.code || 'ERROR' };
      }
    });
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 920, minWidth: 1100, minHeight: 700, show: false, backgroundColor: '#f5f7fa', title: APP_TITLE,
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), nodeIntegration: false, contextIsolation: true, sandbox: true, devTools: false, webSecurity: true }
  });
  win.once('ready-to-show', () => { if (!SELFTEST) win.show(); });
  win.setMenuBarVisibility(false);
  win.setAutoHideMenuBar(true);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => { if (!url.startsWith('file://')) event.preventDefault(); });
  // تمام ذخیره‌سازی‌ها همزمان و فوری انجام می‌شوند؛ هنگام خروج فقط (در صورت وجود تغییر) پشتیبان خروج ساخته می‌شود
  win.on('close', () => {
    if (closing) return; closing = true;
    if (store.getConfig().onExit) safeBackup('exit');
  });
  win.on('closed', () => { win = null; });
  win.loadFile(path.join(__dirname, 'index.html'));
  try { const s = store.readObject('settings'); if (s) applyWindowBranding({ centerName: s.centerName || s.schoolName, logo: s.logo }); } catch (_) { /* ignore */ }
}

// ---------- Self-test (اجرا در CI روی Electron واقعی) ----------
async function runSelfTest() {
  const results = []; const rec = (name, ok, detail) => results.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
  const K = 1001, K2 = 1002;
  const call = (k, ch, ...a) => { try { return { r: service.invoke(k, ch, a) }; } catch (e) { return { err: e }; } };
  try {
    rec('electron version', true, process.versions.electron + ' / node ' + process.versions.node);
    const st = call(K, 'auth:state'); rec('first run needs setup', st.r && st.r.needsSetup === true);
    const su = call(K, 'auth:setup', { username: 'selftest', name: 'Self Test', password: 'Selftest2026x' });
    rec('setup creates admin + recovery code', su.r && su.r.ok && /^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/.test(su.r.recoveryCode), su.err && su.err.message);
    const weak = call(K2, 'auth:login', 'selftest', '1234'); rec('wrong password rejected', weak.err && weak.err.code === 'BAD_CREDENTIALS');
    const cu = call(K, 'users:save', { name: 'Fin User', username: 'finuser', role: 'finance', status: 'فعال' }, 'Fin12345pw');
    rec('admin creates finance user', cu.r && cu.r.id, cu.err && cu.err.message);
    const l2 = call(K2, 'auth:login', 'finuser', 'Fin12345pw'); rec('new user must change password', l2.r && l2.r.mustChange === true);
    const blocked = call(K2, 'db:load'); rec('IPC blocked until password changed', blocked.err && blocked.err.code === 'MUST_CHANGE_PASSWORD');
    call(K2, 'auth:changePassword', 'Fin12345pw', 'Fin67890pw');
    rec('finance cannot manage users (IPC)', (call(K2, 'users:save', { name: 'x', username: 'hacker', role: 'admin', status: 'فعال' }, 'Hack12345pw').err || {}).code === 'FORBIDDEN');
    rec('finance cannot restore (IPC)', (call(K2, 'backup:restore', '/x.json').err || {}).code === 'FORBIDDEN');
    rec('finance cannot write grades (IPC)', (call(K2, 'db:save', [{ name: 'marks', shard: 'Y1', records: [{ id: 'MK-1' }] }]).err || {}).code === 'FORBIDDEN');
    rec('finance can write fee payments', !!call(K2, 'db:save', [{ name: 'feePayments', shard: 'Y1', records: [{ id: 'FP-1', amount: 100, yearId: 'Y1' }] }]).r);
    call(K, 'db:save', [{ name: 'students', shard: '', records: [{ id: 'ST-0001', name: 'شاگرد آزمایشی', classId: 'CL-0001' }] }, { name: 'settings', object: { centerName: APP_TITLE } }]);
    const ld = call(K, 'db:load'); rec('save/load roundtrip', ld.r && ld.r.collections.students.length === 1 && !JSON.stringify(ld.r).includes('pbkdf2'));
    const bk = call(K, 'backup:create'); rec('backup created', bk.r && bk.r.ok, bk.err && bk.err.message);
    call(K, 'db:save', [{ name: 'students', shard: '', records: [] }]);
    const rs = call(K, 'backup:restore', bk.r && bk.r.path); rec('restore succeeded', rs.r && rs.r.ok, rs.err && rs.err.message);
    const l3 = call(K, 'auth:login', 'selftest', 'Selftest2026x'); const ld2 = call(K, 'db:load');
    rec('after restore: re-login + data back', l3.r && ld2.r && ld2.r.collections.students.length === 1);
    // PDF واقعی با printToPDF
    const html = '<!doctype html><html dir="rtl" lang="fa"><head><meta charset="utf-8"><style>@page{size:A4;margin:12mm}body{font-family:Tahoma,"Segoe UI",sans-serif}</style></head><body><h2>' + APP_TITLE + '</h2><p>کارنامه آزمایشی — Report 12345</p><table border="1"><tr><td>شاگرد</td><td>95</td></tr></table></body></html>';
    const pdf = await htmlToPdf(html);
    rec('printToPDF produces a real PDF', pdf.length > 1500, pdf.length + ' bytes');
    fs.writeFileSync(path.join(path.dirname(SELFTEST), 'selftest.pdf'), pdf);
    // رندرر واقعی با preload
    await new Promise((resolve) => { if (win.webContents.isLoading()) win.webContents.once('did-finish-load', resolve); else resolve(); });
    const probe = await win.webContents.executeJavaScript("JSON.stringify({api: typeof window.eduCenterAPI, login: typeof authLoginProbe, form: !!document.getElementById('login-form'), noNode: typeof require + typeof process})");
    const pj = JSON.parse(probe);
    rec('renderer loads with contextBridge API and no Node access', pj.api === 'object' && pj.form && pj.noNode === 'undefinedundefined', probe);
  } catch (e) { rec('unexpected exception', false, e && e.stack || e); }
  const ok = results.every(r => r.ok);
  fs.writeFileSync(SELFTEST, JSON.stringify({ ok, results }, null, 2));
  app.exit(ok ? 0 : 1);
}

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

app.whenReady().then(() => {
  if (SELFTEST && !process.env.EDUCENTER_USERDATA) { app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'educenter-selftest-'))); }
  store = createStore(app.getPath('userData'));
  service = createService(store, { onChange: scheduleAutoBackup });
  registerIPC();
  setupPeriodic();
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  Menu.setApplicationMenu(null);
  createWindow();
  if (SELFTEST) win.webContents.once('did-finish-load', () => { runSelfTest().catch((e) => { try { fs.writeFileSync(SELFTEST, JSON.stringify({ ok: false, error: String(e && e.stack || e) })); } catch (_) { /* ignore */ } app.exit(1); }); });
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
