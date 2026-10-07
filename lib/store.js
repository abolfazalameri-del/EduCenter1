'use strict';
/*
 * ذخیره‌سازی محلی مرکز آموزشی (Node خالص، بدون وابستگی)
 * - هر مجموعه در فایل JSON جدا ذخیره می‌شود؛ مجموعه‌های بزرگ به تفکیک سال تعلیمی (shard).
 * - نوشتن اتمیک: tmp -> rename، با نسخه‌ی .prev برای بازیابی در صورت قطع برق.
 * - پشتیبان: یک فایل JSON با checksum؛ بدون تغییر جدید، پشتیبان تکراری ساخته نمی‌شود.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { SHARDED } = require('./authz');
const NO_DIRTY = { notifications: 1 };           // تغییر این‌ها پشتیبان جدید نمی‌سازد
const AUTO_REASONS = ['auto', 'periodic', 'exit'];
const FORMAT = 1;

function pad(n) { return String(n).padStart(2, '0'); }
function stamp(d) {
  d = d || new Date();
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + '_' + pad(d.getHours()) + '-' + pad(d.getMinutes()) + '-' + pad(d.getSeconds());
}
function sha(s) { return crypto.createHash('sha256').update(s).digest('hex'); }
function safeShard(s) { return String(s || '_').replace(/[^A-Za-z0-9_\-]/g, '_'); }

function writeAtomic(file, text) {
  const tmp = file + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  if (fs.existsSync(file)) { try { fs.renameSync(file, file + '.prev'); } catch (e) { /* ignore */ } }
  fs.renameSync(tmp, file);
}
function readJSONSafe(file) {
  for (const f of [file, file + '.prev']) {
    try { if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { /* try next */ }
  }
  return undefined;
}

function createStore(baseDir) {
  const dataDir = path.join(baseDir, 'data');
  const filesDir = path.join(baseDir, 'files');
  const cfgFile = path.join(baseDir, 'config.json');
  const metaFile = path.join(dataDir, 'meta.json');
  const logFile = path.join(dataDir, 'activity.jsonl');
  const recoveryFile = path.join(baseDir, 'recovery.json');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(filesDir, { recursive: true });

  const defaults = { backupDir: path.join(baseDir, 'backups'), keepAuto: 15, keepManual: 20, autoOnChange: true, autoDelayMin: 5, onExit: true, periodicMin: 60 };
  let config = Object.assign({}, defaults, readJSONSafe(cfgFile) || {});
  let meta = Object.assign({ changeSeq: 0, lastBackupSeq: 0, lastBackupAt: null, lastBackupFile: null }, readJSONSafe(metaFile) || {});
  fs.mkdirSync(config.backupDir, { recursive: true });

  function saveMeta() { writeAtomic(metaFile, JSON.stringify(meta)); }
  function saveConfig() { writeAtomic(cfgFile, JSON.stringify(config, null, 2)); }
  function shardFile(name, shard) { return path.join(dataDir, SHARDED[name] ? name + '@' + safeShard(shard) + '.json' : name + '.json'); }

  function loadAll(dir, lopts) {
    dir = dir || dataDir;
    const out = { collections: {}, objects: {}, logs: [] };
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json') || f === 'meta.json') continue;
      const base = f.slice(0, -5);
      const name = base.split('@')[0];
      const data = readJSONSafe(path.join(dir, f));
      if (data === undefined) continue;
      if (Array.isArray(data)) { out.collections[name] = (out.collections[name] || []).concat(data); }
      else if (data && typeof data === 'object') { out.objects[name] = data; }
    }
    // فایل‌هایی که فقط .prev دارند (قطع برق بین دو rename)
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json.prev')) continue;
      const main = f.slice(0, -5);
      if (fs.existsSync(path.join(dir, main))) continue;
      const base = main.slice(0, -5); const name = base.split('@')[0];
      const data = readJSONSafe(path.join(dir, main));
      if (Array.isArray(data)) out.collections[name] = (out.collections[name] || []).concat(data);
      else if (data && typeof data === 'object') out.objects[name] = data;
    }
    out.logs = (dir === dataDir && !(lopts && lopts.noLogs)) ? readLogs(20000) : [];
    return out;
  }

  // ops: [{name, shard, records}] یا [{name, object}]
  function save(ops) {
    let changed = false;
    for (const op of ops) {
      if (!op || !/^[A-Za-z0-9_]+$/.test(op.name)) throw new Error('invalid collection name');
      if (op.object !== undefined) writeAtomic(path.join(dataDir, op.name + '.json'), JSON.stringify(op.object));
      else {
        if (!Array.isArray(op.records)) throw new Error('records must be array');
        writeAtomic(shardFile(op.name, op.shard), JSON.stringify(op.records));
      }
      if (!NO_DIRTY[op.name]) changed = true;
    }
    if (changed) { meta.changeSeq++; saveMeta(); }
    return { changeSeq: meta.changeSeq };
  }

  function appendLogs(entries) {
    if (!entries || !entries.length) return;
    fs.appendFileSync(logFile, entries.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');
    try {
      if (fs.statSync(logFile).size > 25 * 1024 * 1024) fs.renameSync(logFile, path.join(dataDir, 'activity-' + stamp() + '.jsonl.old'));
    } catch (e) { /* ignore */ }
  }
  function readLogs(limit) {
    if (!fs.existsSync(logFile)) return [];
    const lines = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean);
    const tail = lines.slice(-limit);
    const out = [];
    for (const l of tail) { try { out.push(JSON.parse(l)); } catch (e) { /* skip corrupt line */ } }
    return out;
  }

  // ---------- Backup ----------
  function snapshot() {
    const all = loadAll();
    return { collections: all.collections, objects: all.objects };
  }
  function isDirty() { return meta.changeSeq > meta.lastBackupSeq; }
  function backupPath(name) { return path.join(config.backupDir, name); }

  function listBackups() {
    fs.mkdirSync(config.backupDir, { recursive: true });
    const out = [];
    for (const f of fs.readdirSync(config.backupDir)) {
      const m = /^(?:EduCenter|EduCenter)-Backup_(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})_([a-z\-]+)\.json$/.exec(f);
      if (!m) continue;
      const st = fs.statSync(backupPath(f));
      out.push({ file: f, path: backupPath(f), reason: m[2], stamp: m[1], size: st.size, mtime: st.mtimeMs });
    }
    out.sort((a, b) => b.stamp.localeCompare(a.stamp));
    return out;
  }
  function prune() {
    const list = listBackups();
    const auto = list.filter(b => AUTO_REASONS.includes(b.reason));
    const manual = list.filter(b => !AUTO_REASONS.includes(b.reason));
    auto.slice(config.keepAuto).forEach(b => { try { fs.unlinkSync(b.path); } catch (e) { /* ignore */ } });
    manual.slice(config.keepManual).forEach(b => { try { fs.unlinkSync(b.path); } catch (e) { /* ignore */ } });
  }
  function mirrorFiles() {
    const dst = path.join(config.backupDir, 'files');
    fs.mkdirSync(dst, { recursive: true });
    for (const f of fs.readdirSync(filesDir)) {
      const t = path.join(dst, f);
      if (!fs.existsSync(t)) { try { fs.copyFileSync(path.join(filesDir, f), t); } catch (e) { /* ignore */ } }
    }
  }

  function createBackup(reason, opts) {
    opts = opts || {};
    reason = /^[a-z\-]+$/.test(reason || '') ? reason : 'manual';
    if (!opts.force && !isDirty()) return { skipped: true, reason: 'no-changes' };
    const seqAtStart = meta.changeSeq;
    const snap = snapshot();
    const counts = {}; Object.keys(snap.collections).forEach(k => counts[k] = snap.collections[k].length);
    const dataStr = JSON.stringify(snap);
    const payload = { app: 'edu-center', format: FORMAT, createdAt: new Date().toISOString(), reason, counts, checksum: sha(dataStr), data: snap };
    const name = 'EduCenter-Backup_' + stamp() + '_' + reason + '.json';
    let final = backupPath(name), n = 1;
    while (fs.existsSync(final)) final = backupPath(name.replace('.json', '-' + (n++) + '.json'));
    const text = JSON.stringify(payload);
    const tmp = final + '.tmp';
    fs.writeFileSync(tmp, text);
    const chk = verifyFile(tmp);            // خواندن دوباره و مقایسه‌ی checksum قبل از نهایی شدن
    if (!chk.ok) { try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ } throw new Error('backup verification failed: ' + chk.error); }
    fs.renameSync(tmp, final);
    mirrorFiles();
    meta.lastBackupSeq = seqAtStart; meta.lastBackupAt = new Date().toISOString(); meta.lastBackupFile = path.basename(final);
    saveMeta();
    prune();
    return { ok: true, file: path.basename(final), path: final, size: text.length, counts };
  }

  function verifyFile(file) {
    try {
      const p = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!p || (p.app !== 'edu-center') || !p.data || !p.data.collections) return { ok: false, error: 'not-a-backup' };
      if (sha(JSON.stringify(p.data)) !== p.checksum) return { ok: false, error: 'checksum-mismatch' };
      return { ok: true, createdAt: p.createdAt, reason: p.reason, counts: p.counts };
    } catch (e) { return { ok: false, error: 'unreadable: ' + e.message }; }
  }

  // ---------- Restore اتمیک: آماده‌سازی در پوشه‌ی موقت → اعتبارسنجی کامل → جایگزینی با rename → rollback در صورت خطا ----------
  function writeSnapshotTo(dir, cols, objs) {
    fs.mkdirSync(dir, { recursive: true });
    for (const name of Object.keys(cols)) {
      if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error('نام مجموعه نامعتبر: ' + name);
      if (!Array.isArray(cols[name])) throw new Error('مجموعه‌ی «' + name + '» آرایه نیست');
      if (SHARDED[name]) {
        const groups = {};
        cols[name].forEach(r => { const k = safeShard(r && r.yearId); (groups[k] = groups[k] || []).push(r); });
        Object.keys(groups).forEach(k => writeAtomic(path.join(dir, name + '@' + k + '.json'), JSON.stringify(groups[k])));
      } else writeAtomic(path.join(dir, name + '.json'), JSON.stringify(cols[name]));
    }
    for (const k of Object.keys(objs || {})) {
      if (!/^[A-Za-z0-9_]+$/.test(k)) throw new Error('نام شیء نامعتبر: ' + k);
      writeAtomic(path.join(dir, k + '.json'), JSON.stringify(objs[k]));
    }
  }
  function validateSnapshot(cols, objs) {
    const users = cols.users;
    if (!Array.isArray(users) || !users.some(u => u && u.role === 'admin' && u.status === 'فعال' && typeof u.password === 'string'))
      throw new Error('نسخه‌ی پشتیبان شامل مدیر سیستم فعال نیست');
    Object.keys(cols).forEach(n => cols[n].forEach(r => { if (!r || typeof r !== 'object' || Array.isArray(r)) throw new Error('رکورد نامعتبر در «' + n + '»'); }));
    if (objs && objs.settings !== undefined && (typeof objs.settings !== 'object' || objs.settings === null)) throw new Error('تنظیمات نامعتبر است');
  }

  // opts.__failAt: فقط برای تست (stage | validate | swap | post-swap-check)
  function restoreBackup(file, opts) {
    opts = opts || {};
    const chk = verifyFile(file);
    if (!chk.ok) throw new Error('نسخه پشتیبان معتبر نیست (' + chk.error + ')');
    const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
    const cols = payload.data.collections || {}, objs = payload.data.objects || {};
    validateSnapshot(cols, objs);
    const safety = createBackup('pre-restore', { force: true });      // ۱) نسخه‌ی ایمن از وضعیت فعلی
    const ts = stamp() + '-' + process.pid;
    const staging = path.join(baseDir, 'data.restore-' + ts), old = path.join(baseDir, 'data.old-' + ts);
    let swapped = false;
    try {
      writeSnapshotTo(staging, cols, objs);                                // ۲) نوشتن در پوشه‌ی موقت
      if (opts.__failAt === 'stage') throw new Error('injected stage failure');
      const check = loadAll(staging);                                      // ۳) خواندن دوباره و اعتبارسنجی کامل
      Object.keys(cols).forEach(n => {
        if ((check.collections[n] || []).length !== cols[n].length) throw new Error('عدم تطابق تعداد رکوردها در «' + n + '»');
      });
      if (opts.__failAt === 'validate') throw new Error('injected validate failure');
      // لاگ و meta فعلی حفظ می‌شوند
      for (const f of fs.readdirSync(dataDir)) if (f === 'meta.json' || f.startsWith('activity')) fs.copyFileSync(path.join(dataDir, f), path.join(staging, f));
      fs.renameSync(dataDir, old);                                         // ۴) جایگزینی اتمیک
      swapped = true;
      if (opts.__failAt === 'swap') throw new Error('injected swap failure');
      fs.renameSync(staging, dataDir);
      if (opts.__failAt === 'post-swap-check') throw new Error('injected post-swap failure');
      const after = loadAll();
      if (!Array.isArray(after.collections.users) || !after.collections.users.length) throw new Error('بررسی پس از بازیابی ناموفق بود');
    } catch (err) {                                                        // ۵) rollback
      try {
        if (swapped) {
          if (fs.existsSync(dataDir) && fs.existsSync(old)) fs.renameSync(dataDir, staging);
          if (fs.existsSync(old)) fs.renameSync(old, dataDir);
        }
      } catch (e2) { err.message += ' | rollback error: ' + e2.message; }
      try { fs.rmSync(staging, { recursive: true, force: true }); } catch (e) { /* ignore */ }
      err.message = 'بازیابی ناموفق بود و اطلاعات فعلی حفظ شد: ' + err.message;
      throw err;
    }
    try { fs.rmSync(old, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    meta = Object.assign(meta, readJSONSafe(metaFile) || {});
    meta.changeSeq = (meta.changeSeq || 0) + 1; meta.lastBackupSeq = meta.changeSeq; saveMeta();
    // فایل‌های ضمیمه (عکس/اسناد) — افزایشی؛ خطا در آن باعث rollback داده‌ها نمی‌شود
    const warnings = [];
    const src = path.join(path.dirname(file), 'files');
    if (fs.existsSync(src)) for (const f of fs.readdirSync(src)) {
      const t = path.join(filesDir, f);
      if (!fs.existsSync(t)) { try { fs.copyFileSync(path.join(src, f), t); } catch (e) { warnings.push('فایل ' + f + ' کپی نشد'); } }
    }
    return { ok: true, safety: safety.file, warnings };
  }

  // ---------- Password hashing (سازگار با فرمت قدیمی pbkdf2:salt:hash با ۱۰۰٬۰۰۰ تکرار) ----------
  const ITER = 210000;
  function hashPassword(plain) {
    const salt = crypto.randomBytes(16);
    const h = crypto.pbkdf2Sync(String(plain), salt, ITER, 32, 'sha256');
    return 'pbkdf2:' + salt.toString('hex') + ':' + h.toString('hex') + ':' + ITER;
  }
  function verifyPassword(plain, stored) {
    if (typeof stored !== 'string' || stored.indexOf('pbkdf2:') !== 0) return false;   // رمز متنی دیگر پذیرفته نمی‌شود
    const parts = stored.split(':');
    if (parts.length < 3) return false;
    const iter = parts[3] ? parseInt(parts[3], 10) : 100000;
    try {
      const salt = Buffer.from(parts[1], 'hex'), want = Buffer.from(parts[2], 'hex');
      const got = crypto.pbkdf2Sync(String(plain), salt, iter, want.length, 'sha256');
      return got.length === want.length && crypto.timingSafeEqual(got, want);
    } catch (e) { return false; }
  }

  // ---------- Recovery (فقط هش کد ذخیره می‌شود؛ کد یک‌بار هنگام ساخت نمایش داده می‌شود) ----------
  function normCode(c) { return String(c || '').replace(/[\s-]/g, '').toUpperCase(); }
  function generateRecoveryCode() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const bytes = crypto.randomBytes(16);
    let raw = ''; for (let i = 0; i < 16; i++) raw += alphabet[bytes[i] % alphabet.length];
    writeAtomic(recoveryFile, JSON.stringify({ hash: hashPassword(raw), createdAt: new Date().toISOString() }, null, 2));
    return raw.match(/.{4}/g).join('-');
  }
  function hasRecovery() { const r = readJSONSafe(recoveryFile); return !!(r && (r.hash || r.code)); }
  function verifyRecoveryCode(code) {
    const r = readJSONSafe(recoveryFile);
    if (!r) return false;
    if (r.hash) return verifyPassword(normCode(code), r.hash);
    if (r.code) {   // فایل نسخه‌ی قدیمی (متنی): یک‌بار به هش ارتقا می‌یابد
      const ok = normCode(code) === normCode(r.code);
      if (ok) writeAtomic(recoveryFile, JSON.stringify({ hash: hashPassword(normCode(code)), createdAt: r.createdAt }, null, 2));
      return ok;
    }
    return false;
  }

  // ---------- Files ----------
  const MAX_FILE = 8 * 1024 * 1024;
  function saveFile(id, base64) {
    if (!/^[A-Za-z0-9_\-]{1,80}$/.test(String(id))) throw new Error('bad file id');
    if (typeof base64 !== 'string' || !/^[A-Za-z0-9+/=\r\n]*$/.test(base64)) throw new Error('bad file data');
    const buf = Buffer.from(base64, 'base64');
    if (!buf.length) throw new Error('empty file');
    if (buf.length > MAX_FILE) throw new Error('file too large');
    const tmp = path.join(filesDir, id + '.tmp');
    fs.writeFileSync(tmp, buf); fs.renameSync(tmp, path.join(filesDir, id));
    return id;
  }
  function readFile(id) {
    if (!/^[A-Za-z0-9_\-]{1,80}$/.test(String(id))) return null;
    const f = path.join(filesDir, id);
    return fs.existsSync(f) ? fs.readFileSync(f).toString('base64') : null;
  }
  function deleteFile(id) {
    if (!/^[A-Za-z0-9_\-]{1,80}$/.test(String(id))) return false;
    try { fs.unlinkSync(path.join(filesDir, id)); return true; } catch (e) { return false; }
  }

  // خواندن یک مجموعه (برای مقایسه‌ی حذف/تغییر قبل از ذخیره)
  function readCollection(name, shard) {
    const d = readJSONSafe(shardFile(name, shard));
    return Array.isArray(d) ? d : [];
  }

  return {
    dataDir, filesDir, SHARDED,
    getConfig: () => Object.assign({}, config),
    setConfig(patch) {
      const p = {};
      const num = (v, lo, hi) => { v = Number(v); if (!Number.isFinite(v) || v < lo || v > hi) throw new Error('مقدار تنظیمات نامعتبر است'); return Math.floor(v); };
      if (patch.backupDir !== undefined) {
        if (typeof patch.backupDir !== 'string' || !path.isAbsolute(patch.backupDir)) throw new Error('مسیر پوشه‌ی پشتیبان نامعتبر است');
        fs.mkdirSync(patch.backupDir, { recursive: true }); p.backupDir = patch.backupDir;
      }
      if (patch.keepAuto !== undefined) p.keepAuto = num(patch.keepAuto, 1, 500);
      if (patch.keepManual !== undefined) p.keepManual = num(patch.keepManual, 1, 500);
      if (patch.autoDelayMin !== undefined) p.autoDelayMin = num(patch.autoDelayMin, 1, 1440);
      if (patch.periodicMin !== undefined) p.periodicMin = num(patch.periodicMin, 0, 10080);
      if (patch.autoOnChange !== undefined) p.autoOnChange = !!patch.autoOnChange;
      if (patch.onExit !== undefined) p.onExit = !!patch.onExit;
      Object.assign(config, p); fs.mkdirSync(config.backupDir, { recursive: true }); saveConfig(); return this.getConfig();
    },
    getMeta: () => Object.assign({ dirty: isDirty() }, meta),
    loadAll, save, appendLogs, readLogs, createBackup, listBackups, verifyFile, restoreBackup, isDirty, saveFile, readFile, deleteFile,
    listShards(name) { if (!SHARDED[name]) return ['']; const out = new Set(); for (const f of fs.readdirSync(dataDir)) { const m = /^([A-Za-z0-9_]+)@(.+?)\.json(?:\.prev)?$/.exec(f); if (m && m[1] === name) out.add(m[2]); } return Array.from(out); },
    readCollection, readObject(name) { const d = readJSONSafe(path.join(dataDir, name + '.json')); return d && typeof d === 'object' && !Array.isArray(d) ? d : undefined; }, hashPassword, verifyPassword, generateRecoveryCode, hasRecovery, verifyRecoveryCode, reloadMeta() { meta = Object.assign(meta, readJSONSafe(metaFile) || {}); }
  };
}

module.exports = { createStore, SHARDED };
