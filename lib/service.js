'use strict';
/*
 * سرویس پردازه‌ی اصلی: احراز هویت، نشست (Session)، کنترل دسترسی در سطح IPC، ذخیره‌ی محافظت‌شده و Audit Log.
 * هیچ وابستگی به Electron ندارد تا با Node خالص تست شود. main.js فقط ipcMain را به invoke()/authorize() وصل می‌کند.
 */
const authz = require('./authz');
const { ROLES, PERMISSIONS, COLLECTION_RULES, OBJECT_RULES, SHARDED, CHANNEL_RULES } = authz;
const Finance = require('./finance');
const Assess = require('./assess');
const Themes = require('./themes');
const Kind = require('./kind');
const BRANCH_SCOPED = new Set(authz.BRANCH_SCOPED);
const DEFAULT_BRANCH_ID = 'BR-0001';
const RESTRICTED_FORBIDDEN_CHANNELS = /^(backup:|recovery:|perms:set|transfer:)/;

const WEAK_PASSWORDS = ['1234', '12345', '123456', '1234567', '12345678', '123456789', 'password', 'password1', 'admin', 'admin123', 'qwerty', '00000000', '11111111', 'educenter', 'educenter123'];
const MAX_FAILS = 5, LOCK_MS = 60 * 1000;
const AUDIT_SECTIONS = { studentFees: 'فیس‌نامه‌ها', courseEnrollments: 'ثبت‌نام در کورس', courses: 'کورس‌ها', levels: 'سطوح کورس', branches: 'شعبه‌ها', marks: 'نمرات', feeStructures: 'ساختار فیس', feePayments: 'پرداخت فیس', expenses: 'مصارف', payroll: 'معاشات', discipline: 'انضباط', settings: 'تنظیمات' };

function fail(code, msg) { const e = new Error(msg); e.code = code; return e; }
const bad = (m) => fail('BAD_REQUEST', m || 'درخواست نامعتبر است.');

function validatePassword(pw, username) {
  if (typeof pw !== 'string' || pw.length < 8) return 'رمز عبور باید حداقل ۸ کاراکتر باشد.';
  if (pw.length > 128) return 'رمز عبور خیلی طولانی است.';
  if (!/\p{L}/u.test(pw) || !/\p{N}/u.test(pw)) return 'رمز عبور باید هم حرف و هم عدد داشته باشد.';
  if (WEAK_PASSWORDS.indexOf(pw.toLowerCase()) >= 0) return 'این رمز عبور بسیار رایج است؛ رمز دیگری انتخاب کنید.';
  if (username && pw.toLowerCase() === String(username).toLowerCase()) return 'رمز عبور نباید با نام کاربری یکسان باشد.';
  return null;
}
const USERNAME_RE = /^[\p{L}\p{N}_.\-]{3,32}$/u;

function createService(store, opts) {
  opts = opts || {};
  const sessions = new Map();           // key -> {userId, mustChange}
  const attempts = new Map();           // تلاش‌های ناموفق ورود/بازیابی
  const allowedPaths = new Set();       // مسیر فایل‌های پشتیبان انتخاب‌شده با دیالوگ
  let usersCache = null, permsCache = null, branchesCache = null, branchesChecked = false;
  const onChange = opts.onChange || function () {};

  // ---------- کاربران ----------
  function loadUsers() { return store.readCollection('users', '').filter(u => u && typeof u === 'object'); }
  function users() { if (!usersCache) usersCache = loadUsers(); return usersCache; }
  function saveUsers(list) { store.save([{ name: 'users', shard: '', records: list }]); usersCache = list; }
  function rolePerms() { if (!permsCache) permsCache = store.readObject('rolePerms') || {}; return permsCache; }
  function invalidate() { usersCache = null; permsCache = null; branchesCache = null; branchesChecked = false; }
  function pub(u, full) {
    const o = { id: u.id, name: u.name, role: authz.normalizeRole(u.role), status: u.status, branchId: authz.normalizeRole(u.role) === 'admin' ? null : (u.branchId || null) };
    o.palette = (u.prefs && typeof u.prefs.palette === 'string' && Themes.isValid(u.prefs.palette) && u.prefs.palette) || '';
    o.printMode = (u.prefs && Kind.PRINT_MODES.includes(u.prefs.printMode) && u.prefs.printMode) || '';
    if (full) { o.username = u.username; o.lastLogin = u.lastLogin || null; o.mustChange = !!u.mustChange; }
    return o;
  }
  function nextUserId() {
    let max = 0; users().forEach(u => { const m = /^US-(\d+)$/.exec(u.id || ''); if (m) max = Math.max(max, Number(m[1])); });
    return 'US-' + String(max + 1).padStart(4, '0');
  }
  function activeAdmins(list) { return (list || users()).filter(u => authz.normalizeRole(u.role) === 'admin' && u.status === 'فعال'); }

  // مهاجرت نسخه‌های قبلی: نام نقش‌ها و رمزهای متنی
  (function migrate() {
    const list = loadUsers(); let changed = false;
    list.forEach(u => {
      const r = authz.normalizeRole(u.role); if (r !== u.role) { u.role = r; changed = true; }
      if (typeof u.password !== 'string' || u.password.indexOf('pbkdf2:') !== 0) {
        u.password = store.hashPassword(String(u.password || Math.random())); u.mustChange = true; changed = true;
      }
    });
    if (changed) store.save([{ name: 'users', shard: '', records: list }]);
    usersCache = list;
  })();

  // ---------- شعبه‌ها ----------
  // مهاجرت: اگر شعبه‌ای وجود ندارد (نصب جدید یا داده‌ی نسخه‌ی قبلی/پشتیبان قدیمی) «شعبه مرکزی» ساخته و همه‌ی رکوردهای بدون شعبه به آن نسبت داده می‌شوند.
  function ensureBranches() {
    if (branchesChecked) return;
    let cur = store.readCollection('branches', '').filter(b => b && b.id);
    if (!cur.length) {
      const rec = { id: DEFAULT_BRANCH_ID, name: 'شعبه مرکزی', status: 'فعال', isDefault: true, address: '', phone: '', manager: '', note: '', createdAt: new Date().toISOString() };
      store.save([{ name: 'branches', shard: '', records: [rec] }]);
      BRANCH_SCOPED.forEach(n => {
        store.listShards(n).forEach(sh => {
          const recs = store.readCollection(n, sh);
          if (recs.some(r => r && typeof r === 'object' && !r.branchId)) {
            recs.forEach(r => { if (r && typeof r === 'object' && !r.branchId) r.branchId = DEFAULT_BRANCH_ID; });
            store.save([{ name: n, shard: sh, records: recs }]);
          }
        });
      });
      const seq = store.readObject('seq') || {};
      if (!(Number(seq.branch) >= 1)) { seq.branch = 1; store.save([{ name: 'seq', object: seq }]); }
      cur = [rec];
    }
    branchesCache = cur; branchesChecked = true;
  }
  function branchList() { ensureBranches(); return branchesCache; }
  function defaultBranchId() { const l = branchList(); const d = l.find(b => b.isDefault) || l[0]; return d ? d.id : DEFAULT_BRANCH_ID; }
  const isRestricted = (c) => !!(c && c.role !== 'admin' && c.u.branchId);
  // محدوده‌ی شعبه برای یک درخواست: کاربر وابسته به شعبه همیشه محدود به شعبه‌ی خودش است؛ سایرین می‌توانند یک شعبه را انتخاب کنند (null = همه‌ی شعبه‌ها)
  function scopeOf(c, requested) {
    if (isRestricted(c)) return c.u.branchId;
    if (requested === undefined || requested === null || requested === '' || requested === 'all') return null;
    if (!branchList().some(b => b.id === requested)) throw bad('شعبه نامعتبر است.');
    return requested;
  }
  function guardUserTarget(c, u) {       // کاربر وابسته به شعبه فقط کاربران همان شعبه (و نه مدیران کل) را مدیریت می‌کند
    if (!isRestricted(c)) return;
    const r = authz.normalizeRole(u.role);
    if (u.branchId !== c.u.branchId || r === 'admin' || r === 'manager') { audit(c, 'دسترسی ردشد', 'امنیت', 'مدیریت کاربر خارج از شعبه'); throw fail('FORBIDDEN', 'شما اجازه‌ی انجام این عملیات را ندارید.'); }
  }
  function branchUsage(id) {
    const all = store.loadAll(undefined, { noLogs: true }); let n = 0;
    BRANCH_SCOPED.forEach(cn => (all.collections[cn] || []).forEach(r => { if (r && r.branchId === id) n++; }));
    return { records: n, users: users().filter(u => u.branchId === id).length };
  }
  function cleanBranch(r, prev, dflt) {
    const s = (v, n) => String(v === undefined || v === null ? '' : v).trim().slice(0, n);
    const name = s(r.name, 100); if (!name) throw bad('نام شعبه الزامی است.');
    if (typeof r.id !== 'string' || !/^BR-\d{4,}$/.test(r.id)) throw bad('شناسه‌ی شعبه نامعتبر است.');
    const status = r.status === 'غیرفعال' ? 'غیرفعال' : 'فعال';
    return { id: r.id, name, address: s(r.address, 300), phone: s(r.phone, 40), manager: s(r.manager, 100), note: s(r.note, 500), status,
      isDefault: !!(prev && prev.isDefault), createdAt: (prev && prev.createdAt) || s(r.createdAt, 40) || new Date().toISOString() };
  }


  // ---------- اعتبارسنجی ساختار آموزشی: کورس ← سطح ← صنف ----------
  function validateAcademic(plan) {
    const touched = new Set(plan.map(p => p.op.name));
    if (!['courses', 'levels', 'classes', 'courseEnrollments'].some(n => touched.has(n))) return;
    const eff = (n) => { const p = plan.find(x => x.op.name === n); return p ? p.op.records : store.readCollection(n, ''); };
    const num = (v, label) => { if (v === undefined || v === null || v === '') return; const n = Number(v); if (!isFinite(n) || n < 0) throw bad(label + ' باید عدد غیرمنفی باشد.'); };
    const courses = eff('courses'), levels = eff('levels'), classes = eff('classes'), teachers = eff('teachers');
    const cMap = new Map(courses.map(c => [c.id, c])), lMap = new Map(levels.map(l => [l.id, l]));
    const seenC = new Set();
    courses.forEach(c => {
      const name = String(c.name || '').trim(); if (!name || name.length > 120) throw bad('نام کورس الزامی است (حداکثر ۱۲۰ حرف).');
      const k = (c.branchId || '') + '|' + name.toLowerCase(); if (seenC.has(k)) throw bad('کورسی با نام «' + name + '» در این شعبه وجود دارد.'); seenC.add(k);
      num(c.price, 'قیمت کورس'); num(c.durationValue, 'مدت کورس');
      if (c.startDate && c.endDate && String(c.startDate) > String(c.endDate)) throw bad('تاریخ ختم کورس «' + name + '» قبل از تاریخ شروع است.');
      if (String(c.category || '').length > 60) throw bad('نوع کورس بسیار طولانی است.');
      if (c.teacherId) { const t = teachers.find(x => x.id === c.teacherId); if (!t || (t.branchId || '') !== (c.branchId || '')) throw bad('استاد کورس «' + name + '» در این شعبه یافت نشد.'); }
    });
    const seenL = new Set();
    levels.forEach(l => {
      const name = String(l.name || '').trim(); if (!name || name.length > 100) throw bad('نام سطح الزامی است.');
      const c = cMap.get(l.courseId);
      if (!c) throw bad('کورس دارای سطح است و حذف نمی‌شود؛ ابتدا سطح‌های آن را حذف کنید.');
      if ((c.branchId || '') !== (l.branchId || '')) throw bad('سطح و کورس باید در یک شعبه باشند.');
      const k = l.courseId + '|' + name.toLowerCase(); if (seenL.has(k)) throw bad('سطح «' + name + '» در این کورس تکراری است.'); seenL.add(k);
      num(l.price, 'قیمت سطح'); num(l.durationValue, 'مدت سطح'); num(l.order, 'ترتیب سطح');
    });
    const ENR_STATUS = ['فعال', 'ختم شده', 'انصراف', 'منتقل شد'];
    const students = eff('students'), clMap = new Map(classes.map(x => [x.id, x]));
    const activeSeen = new Set();
    eff('courseEnrollments').forEach(e => {
      if (!ENR_STATUS.includes(e.status)) throw bad('وضعیت ثبت‌نام کورس نامعتبر است.');
      const c = cMap.get(e.courseId); if (!c) throw bad('کورس/سطح/صنف دارای ثبت‌نام شاگرد است و قابل حذف نیست.');
      if ((c.branchId || '') !== (e.branchId || '')) throw bad('ثبت‌نام و کورس باید در یک شعبه باشند.');
      if (e.levelId) { const l = lMap.get(e.levelId); if (!l) throw bad('کورس/سطح/صنف دارای ثبت‌نام شاگرد است و قابل حذف نیست.'); if (l.courseId !== e.courseId) throw bad('سطح انتخاب‌شده متعلق به این کورس نیست.'); }
      if (e.classId) { const cl = clMap.get(e.classId); if (!cl) throw bad('کورس/سطح/صنف دارای ثبت‌نام شاگرد است و قابل حذف نیست.'); if (cl.courseId !== e.courseId || (e.levelId && cl.levelId !== e.levelId)) throw bad('صنف انتخاب‌شده متعلق به این کورس/سطح نیست.'); }
      if (e.status === 'فعال') {
        const st = students.find(x => x.id === e.studentId); if (!st || (st.branchId || '') !== (e.branchId || '')) throw bad('شاگرد این ثبت‌نام در همین شعبه یافت نشد.');
        const k = e.studentId + '|' + e.courseId; if (activeSeen.has(k)) throw bad('شاگرد در این کورس ثبت‌نام فعال دارد.'); activeSeen.add(k);
      }
    });
    classes.forEach(cl => {
      if (!cl.courseId && !cl.levelId) return;      // صنف قدیمی/بدون کورس مجاز است
      const c = cMap.get(cl.courseId); if (!c) throw bad('کورس/سطح دارای صنف است و قابل حذف نیست؛ ابتدا صنف‌ها را حذف یا منتقل کنید.');
      if ((c.branchId || '') !== (cl.branchId || '')) throw bad('صنف و کورس باید در یک شعبه باشند.');
      if (cl.levelId) { const l = lMap.get(cl.levelId); if (!l) throw bad('کورس/سطح دارای صنف است و قابل حذف نیست؛ ابتدا صنف‌ها را حذف یا منتقل کنید.'); if (l.courseId !== cl.courseId) throw bad('سطح انتخاب‌شده متعلق به این کورس نیست.'); }
    });
  }


  // ---------- اعتبارسنجی مالی: فیس‌نامه، قسط، تخفیف، پرداخت ----------
  function validateFinance(c, plan) {
    const touched = new Set(plan.map(p => p.op.name));
    if (!touched.has('studentFees') && !touched.has('feePayments')) return;
    const invPlan = plan.find(p => p.op.name === 'studentFees');
    const invoices = invPlan ? invPlan.op.records : store.readCollection('studentFees', '');
    const shards = new Set(store.listShards('feePayments')); plan.forEach(p => { if (p.op.name === 'feePayments') shards.add(p.op.shard); });
    const payments = []; shards.forEach(sh => { const pp = plan.find(p => p.op.name === 'feePayments' && p.op.shard === sh); (pp ? pp.op.records : store.readCollection('feePayments', sh)).forEach(x => payments.push(x)); });
    const students = (plan.find(p => p.op.name === 'students') || { op: { records: store.readCollection('students', '') } }).op.records;
    const prevInv = new Map(store.readCollection('studentFees', '').map(i => [i.id, i]));
    const invMap = new Map();
    invoices.forEach(inv => {
      const err = Finance.validateInvoice(inv); if (err) throw bad(err);
      const st = students.find(x => x.id === inv.studentId); if (!st || (st.branchId || '') !== (inv.branchId || '')) throw bad('شاگرد فیس‌نامه «' + inv.title + '» در همین شعبه یافت نشد.');
      if (!inv.yearId) throw bad('سال تعلیمی فیس‌نامه مشخص نیست.');
      const p = prevInv.get(inv.id), d = Number(inv.discount) || 0;
      if (d > 0 && (!p || Number(p.discount) !== d || p.discountReason !== inv.discountReason) && !authz.hasPerm(c.perms, 'fees.discount')) { audit(c, 'دسترسی ردشد', 'امنیت', 'اعطای تخفیف بدون صلاحیت'); throw fail('FORBIDDEN', 'شما اجازه‌ی اعطای تخفیف را ندارید.'); }
      if (p && !inv.cancelled && !p.cancelled && payments.some(x => x.invoiceId === inv.id) && Finance.invoiceNet(inv) < payments.filter(x => x.invoiceId === inv.id).reduce((t, x) => t + Number(x.amount), 0) - 0.01) throw bad('مبلغ خالص فیس‌نامه نمی‌تواند کمتر از مجموع پرداخت‌های آن شود.');
      invMap.set(inv.id, inv);
    });
    const paidBy = new Map();
    payments.forEach(p => {
      if (p.amount !== undefined && !(Number(p.amount) > 0 && isFinite(Number(p.amount)))) throw bad('مبلغ پرداخت باید بیشتر از صفر باشد.');
      if (!p.invoiceId) return;
      const inv = invMap.get(p.invoiceId); if (!inv) throw bad('فیس‌نامه دارای پرداخت است و حذف نمی‌شود؛ ابتدا پرداخت‌ها را حذف کنید.');
      if (inv.studentId !== p.studentId) throw bad('پرداخت و فیس‌نامه باید متعلق به یک شاگرد باشند.');
      if (inv.cancelled) throw bad('فیس‌نامه‌ی لغوشده پرداخت نمی‌پذیرد.');
      paidBy.set(inv.id, Math.round(((paidBy.get(inv.id) || 0) + Number(p.amount)) * 100) / 100);
    });
    paidBy.forEach((v, id) => { if (v > Finance.invoiceNet(invMap.get(id)) + 0.01) throw bad('مجموع پرداخت‌ها از مبلغ خالص فیس‌نامه بیشتر می‌شود.'); });
  }


  // ---------- اعتبارسنجی ارزیابی: امتحان، اجزا/مهارت‌ها، نمره ----------
  // فقط رکوردهای جدید یا تغییرکرده بررسی می‌شوند تا داده‌ی قدیمی هیچ ذخیره‌ی بعدی را مسدود نکند.
  function validateAssessment(plan) {
    const touched = new Set(plan.map(p => p.op.name));
    if (!touched.has('exams') && !touched.has('marks')) return;
    const gather = (name) => {
      const shards = new Set(store.listShards(name)); plan.forEach(p => { if (p.op.name === name) shards.add(p.op.shard); });
      const eff = [], prev = new Map();
      shards.forEach(sh => { store.readCollection(name, sh).forEach(r => { if (r && r.id) prev.set(r.id, r); }); const pp = plan.find(p => p.op.name === name && p.op.shard === sh); (pp ? pp.op.records : store.readCollection(name, sh)).forEach(r => eff.push(r)); });
      return { eff, prev };
    };
    const ex = gather('exams'), mk = gather('marks'), exMap = new Map(ex.eff.map(e => [e.id, e]));
    const classes = (plan.find(p => p.op.name === 'classes') || { op: { records: store.readCollection('classes', '') } }).op.records;
    const changed = (r, prev) => { const p = prev.get(r.id); return !p || JSON.stringify(p) !== JSON.stringify(r); };
    ex.eff.filter(e => changed(e, ex.prev)).forEach(e => {
      const err = Assess.validateExam(e); if (err) throw bad(err);
      const cl = classes.find(x => x.id === e.classId); if (!cl || (cl.branchId || '') !== (e.branchId || '')) throw bad('صنف امتحان «' + e.title + '» در همین شعبه یافت نشد.');
      const p = ex.prev.get(e.id);
      if (p && (Number(p.maxScore) !== Number(e.maxScore) || JSON.stringify(p.components || []) !== JSON.stringify(e.components || [])) && mk.eff.some(m => m.examId === e.id)) throw bad('امتحانی که نمره‌ی ثبت‌شده دارد، نمره‌ی کامل و اجزایش تغییر نمی‌کند؛ ابتدا نمرات را حذف کنید.');
    });
    mk.eff.filter(m => m.examId !== undefined && changed(m, mk.prev)).forEach(m => {   // رکورد بدون examId هیچ محاسبه‌ای را تحت تأثیر قرار نمی‌دهد (برنامه همیشه examId می‌گذارد)
      const e = exMap.get(m.examId); const err = Assess.validateMark(m, e); if (err) throw bad(err);
      if ((e.branchId || '') !== (m.branchId || '')) throw bad('نمره و امتحان باید در یک شعبه باشند.');
    });
  }

  // ---------- Audit ----------
  function audit(c, action, section, description) {
    const d = new Date();
    const e = { ts: d.toISOString(), date: d.toISOString().slice(0, 10), time: d.toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' }),
      user: c && c.u ? c.u.name : '—', userId: c && c.u ? c.u.id : null, action, section, description: String(description || '').slice(0, 500), src: 'main' };
    try { store.appendLogs([e]); } catch (err) { /* ignore */ }
  }

  // ---------- Session / authorize ----------
  function ctx(key) {
    const s = sessions.get(key); if (!s) return null;
    const u = users().find(x => x.id === s.userId);
    if (!u || u.status !== 'فعال') { sessions.delete(key); return null; }
    if (authz.normalizeRole(u.role) !== 'admin' && u.branchId) { const b = branchList().find(x => x.id === u.branchId); if (!b || b.status !== 'فعال') { sessions.delete(key); return null; } }
    return { s, u, role: authz.normalizeRole(u.role), perms: authz.effectivePerms(u.role, rolePerms()) };
  }
  function authorize(key, channel) {
    const rule = CHANNEL_RULES[channel];
    if (!rule) throw fail('FORBIDDEN', 'عملیات ناشناخته.');
    if (rule === 'public') return null;
    const c = ctx(key);
    if (!c) throw fail('NOT_AUTHENTICATED', 'ابتدا وارد سیستم شوید.');
    if (rule === 'mustchange-ok') return c;
    if (c.s.mustChange) throw fail('MUST_CHANGE_PASSWORD', 'ابتدا رمز عبور خود را تغییر دهید.');
    if (!authz.hasPerm(c.perms, rule) || (isRestricted(c) && RESTRICTED_FORBIDDEN_CHANNELS.test(channel))) { audit(c, 'دسترسی ردشد', 'امنیت', channel); throw fail('FORBIDDEN', 'شما اجازه‌ی انجام این عملیات را ندارید.'); }
    return c;
  }
  function need(c, perm, what) {
    if (perm && !authz.hasPerm(c.perms, perm)) { audit(c, 'دسترسی ردشد', 'امنیت', (what || '') + ' [' + perm + ']'); throw fail('FORBIDDEN', 'شما اجازه‌ی انجام این عملیات را ندارید.'); }
  }
  function startSession(key, u) {
    u.lastLogin = new Date().toISOString();
    saveUsers(users());
    sessions.set(key, { userId: u.id, mustChange: !!u.mustChange });
    const c = ctx(key);
    audit(c, 'ورود', 'احراز هویت', 'کاربر ' + u.name + ' وارد سیستم شد.');
    return { ok: true, user: pub(u, true), perms: c.perms, mustChange: !!u.mustChange, roles: ROLES };
  }
  function throttle(k) {
    const a = attempts.get(k);
    if (a && a.until && a.until > Date.now()) throw fail('LOCKED', 'تلاش‌های ناموفق زیاد بود. ' + Math.ceil((a.until - Date.now()) / 1000) + ' ثانیه صبر کنید.');
  }
  function recordFail(k) {
    const a = attempts.get(k) || { n: 0, until: 0 }; a.n++;
    if (a.n >= MAX_FAILS) { a.until = Date.now() + LOCK_MS; a.n = 0; }
    attempts.set(k, a);
  }

  // ---------- Handlers: (ctx, key, ...args) ----------
  const H = {};
  H['auth:state'] = (c, key) => ({ needsSetup: users().length === 0, hasRecovery: store.hasRecovery() });
  H['branding:get'] = () => {
    const s = store.readObject('settings') || {};
    return { centerName: s.centerName || s.schoolName || 'مرکز آموزشی', tagline: s.tagline || '', logo: typeof s.logo === 'string' && s.logo.length < 600000 ? s.logo : '', palette: s.palette || 'navy' };
  };
  H['auth:setup'] = (c, key, d) => {
    if (users().length) throw fail('FORBIDDEN', 'برنامه قبلاً راه‌اندازی شده است.');
    d = d || {};
    const username = String(d.username || '').trim(), name = String(d.name || '').trim();
    if (!USERNAME_RE.test(username)) throw bad('نام کاربری باید ۳ تا ۳۲ کاراکتر (حرف، عدد، نقطه، خط تیره) باشد.');
    if (!name || name.length > 100) throw bad('نام کامل را وارد کنید.');
    const pe = validatePassword(d.password, username); if (pe) throw bad(pe);
    const u = { id: 'US-0001', username, name, role: 'admin', status: 'فعال', password: store.hashPassword(d.password), lastLogin: null, mustChange: false };
    saveUsers([u]);
    const code = store.generateRecoveryCode();
    const r = startSession(key, u);
    audit(ctx(key), 'ایجاد', 'کاربران', 'مدیر سیستم اولیه ایجاد شد و کد بازیابی ساخته شد.');
    r.recoveryCode = code; return r;
  };
  H['auth:login'] = (c, key, username, password) => {
    username = String(username || '').trim(); const k = 'login:' + username.toLowerCase();
    throttle(k);
    const u = users().find(x => String(x.username).toLowerCase() === username.toLowerCase());
    const okPw = u ? store.verifyPassword(String(password || ''), u.password) : (store.verifyPassword('x', 'pbkdf2:00:00'), false);
    if (!u || !okPw) { recordFail(k); audit({ u: u || { name: username, id: null } }, 'ورود ناموفق', 'احراز هویت', 'تلاش ناموفق برای ورود با نام کاربری «' + username.slice(0, 40) + '»'); throw fail('BAD_CREDENTIALS', 'نام کاربری یا رمز عبور نادرست است.'); }
    if (u.status !== 'فعال') throw fail('INACTIVE', 'این حساب کاربری غیرفعال شده است.');
    attempts.delete(k);
    if (WEAK_PASSWORDS.indexOf(String(password).toLowerCase()) >= 0) u.mustChange = true;   // رمز پیش‌فرض/ضعیف قدیمی
    return startSession(key, u);
  };
  H['auth:logout'] = (c, key) => { audit(c, 'خروج', 'احراز هویت', 'کاربر ' + c.u.name + ' از سیستم خارج شد.'); sessions.delete(key); return { ok: true }; };
  // ترجیحات شخصی هر کاربر (پالت رنگی خودش)؛ نیاز به صلاحیت مدیریت کاربران ندارد و فقط روی حساب خودِ کاربر اثر می‌گذارد
  H['me:setPrefs'] = (c, key, prefs) => {
    if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) throw bad('درخواست نامعتبر است.');
    const patch = {};
    if ('palette' in prefs) { const v = prefs.palette === null ? '' : prefs.palette; if (typeof v !== 'string' || !Themes.isValid(v)) throw bad('پالت رنگی نامعتبر است.'); patch.palette = v; }
    if ('printMode' in prefs) { const v = prefs.printMode === null ? '' : prefs.printMode; if (typeof v !== 'string' || (v !== '' && !Kind.PRINT_MODES.includes(v))) throw bad('نوع خروجی چاپ نامعتبر است.'); patch.printMode = v; }
    if (!Object.keys(patch).length) throw bad('چیزی برای ذخیره نیست.');
    const list = users(), u = list.find(x => x.id === c.u.id); if (!u) throw bad('کاربر یافت نشد.');
    u.prefs = Object.assign({}, u.prefs || {}, patch); saveUsers(list);
    const p = pub(u); return { ok: true, palette: p.palette, printMode: p.printMode };
  };
  H['auth:me'] = (c) => ({ user: pub(c.u, true), perms: c.perms, mustChange: !!c.s.mustChange, roles: ROLES });
  H['auth:changePassword'] = (c, key, oldPw, newPw) => {
    if (!store.verifyPassword(String(oldPw || ''), c.u.password)) throw fail('BAD_CREDENTIALS', 'رمز عبور فعلی نادرست است.');
    const pe = validatePassword(newPw, c.u.username); if (pe) throw bad(pe);
    if (newPw === oldPw) throw bad('رمز جدید باید با رمز قبلی متفاوت باشد.');
    c.u.password = store.hashPassword(newPw); c.u.mustChange = false; saveUsers(users());
    c.s.mustChange = false;
    audit(c, 'تغییر رمز', 'کاربران', 'کاربر ' + c.u.name + ' رمز عبور خود را تغییر داد.');
    return { ok: true };
  };

  H['db:load'] = (c, key, requested) => {
    ensureBranches();
    const scope = scopeOf(c, requested), restricted = isRestricted(c), dflt = defaultBranchId();
    const all = store.loadAll(undefined, { noLogs: true });
    const out = { collections: {}, objects: {}, logs: [], me: pub(c.u, true), perms: c.perms, roles: ROLES, scope, restricted };
    Object.keys(COLLECTION_RULES).forEach(n => {
      if (!authz.hasPerm(c.perms, COLLECTION_RULES[n].read)) return;
      let arr = all.collections[n] || [];
      if (scope && BRANCH_SCOPED.has(n)) arr = arr.filter(r => r && (r.branchId || dflt) === scope);
      if (n === 'branches') arr = restricted ? arr.filter(b => b && b.id === c.u.branchId) : arr;
      out.collections[n] = arr;
    });
    const full = authz.hasPerm(c.perms, 'users.manage');
    out.collections.users = users().filter(u => !restricted || u.id === c.u.id || u.branchId === c.u.branchId).map(u => pub(u, full));
    Object.keys(OBJECT_RULES).forEach(n => { if (authz.hasPerm(c.perms, OBJECT_RULES[n].read) && all.objects[n] !== undefined) out.objects[n] = all.objects[n]; });
    return out;
  };
  H['logs:read'] = (c) => {
    const l = store.readLogs(20000);
    if (!isRestricted(c)) return l;
    const ids = new Set(users().filter(u => u.branchId === c.u.branchId).map(u => u.id));
    return l.filter(e => e && ids.has(e.userId));
  };


  // ---------- انتقال بین شعبه‌ها ----------
  H['transfer:run'] = (c, key, req) => {
    ensureBranches();
    req = req || {};
    const type = req.type, id = req.id, to = req.toBranchId, dflt = defaultBranchId();
    const COL = { student: 'students', teacher: 'teachers', staff: 'staff' }[type]; if (!COL) throw bad('نوع انتقال نامعتبر است.');
    const dest = branchList().find(b => b.id === to); if (!dest) throw bad('شعبه‌ی مقصد نامعتبر است.'); if (dest.status !== 'فعال') throw bad('شعبه‌ی مقصد غیرفعال است.');
    const list = store.readCollection(COL, ''), rec = list.find(r => r && r.id === id); if (!rec) throw bad('رکورد یافت نشد.');
    const from = rec.branchId || dflt; if (from === to) throw bad('شخص هم‌اکنون در همین شعبه است.');
    const today = new Date().toISOString().slice(0, 10), plan = [], cleared = { courses: 0, classes: 0, subjects: 0 };
    let classId = '';
    if (type === 'student' && req.classId) {
      const cl = store.readCollection('classes', '').find(x => x.id === req.classId);
      if (!cl || (cl.branchId || dflt) !== to) throw bad('صنف مقصد در شعبه‌ی مقصد یافت نشد.');
      if (rec.academicYearId && cl.academicYearId !== rec.academicYearId) throw bad('صنف مقصد باید در همان سال تعلیمی شاگرد باشد.');
      classId = cl.id;
    }
    rec.transfers = (rec.transfers || []).concat([{ date: today, fromBranchId: from, toBranchId: to, by: c.u.name, note: String(req.note || '').slice(0, 300) }]).slice(-50);
    rec.branchId = to;
    if (type === 'student') {
      rec.classId = classId;
      const enr = store.readCollection('courseEnrollments', ''); let enrChanged = false;
      enr.forEach(e => { if (e.studentId === id && e.status === 'فعال') { e.status = 'منتقل شد'; e.endDate = today; enrChanged = true; } });
      if (enrChanged) plan.push({ name: 'courseEnrollments', shard: '', records: enr });
      if (rec.parentId) {
        const parents = store.readCollection('parents', ''), par = parents.find(p => p.id === rec.parentId);
        if (par) {
          const others = list.some(s => s && s.id !== id && !s.softDeleted && s.parentId === par.id && (s.branchId || dflt) === (par.branchId || dflt));
          if (!others) { par.branchId = to; }
          else {
            const seq = store.readObject('seq') || {}; seq.parent = (Number(seq.parent) || 0) + 1; plan.push({ name: 'seq', object: seq });
            const clone = Object.assign({}, par, { id: 'PR-' + String(seq.parent).padStart(4, '0'), branchId: to, studentIds: [id] });
            par.studentIds = (par.studentIds || []).filter(x => x !== id); parents.push(clone); rec.parentId = clone.id;
          }
          plan.push({ name: 'parents', shard: '', records: parents });
        }
      }
    } else if (type === 'teacher') {
      [['courses', 'teacherId', 'courses'], ['classes', 'headTeacherId', 'classes'], ['subjects', 'teacherId', 'subjects']].forEach(([cn, f, k]) => {
        const arr = store.readCollection(cn, ''); let n = 0; arr.forEach(r => { if (r && r[f] === id) { r[f] = ''; n++; } });
        if (n) { cleared[k] = n; plan.push({ name: cn, shard: '', records: arr }); }
      });
    }
    plan.push({ name: COL, shard: '', records: list });
    store.save(plan.map(p => p.object !== undefined ? { name: p.name, object: p.object } : { name: p.name, shard: p.shard, records: p.records }));
    audit(c, 'انتقال بین شعبه‌ها', 'شعبه‌ها', (type === 'student' ? 'شاگرد' : type === 'teacher' ? 'استاد' : 'کارمند') + ' «' + rec.name + '» از ' + from + ' به ' + to + ' منتقل شد.');
    onChange();
    return { ok: true, branchId: to, cleared };
  };

  // گزارش مقایسه‌ای شعبه‌ها (در main محاسبه می‌شود تا کاربر وابسته به شعبه فقط شعبه‌ی خودش را ببیند)
  H['branches:stats'] = (c, key, yearId) => {
    ensureBranches();
    const all = store.loadAll(undefined, { noLogs: true }), dflt = defaultBranchId();
    const col = (n) => all.collections[n] || [];
    const yr = (r) => !yearId || r.yearId === yearId;
    const sum = (arr, f) => arr.reduce((t, r) => t + (Number(r[f]) || 0), 0);
    const canFees = authz.hasPerm(c.perms, 'fees.read'), canAcc = authz.hasPerm(c.perms, 'accounting.read'), canPay = authz.hasPerm(c.perms, 'payroll.read');
    let list = branchList(); if (isRestricted(c)) list = list.filter(b => b.id === c.u.branchId);
    const rows = list.map(b => {
      const mine = (n) => col(n).filter(r => r && (r.branchId || dflt) === b.id);
      const income = canFees ? sum(mine('feePayments').filter(yr), 'amount') : null;
      const expenses = canAcc ? sum(mine('expenses').filter(yr), 'amount') : null;
      const salaries = canPay ? sum(mine('payroll').filter(yr), 'paidAmount') : null;
      const net = income === null || expenses === null || salaries === null ? null : income - expenses - salaries;
      let invoiced = null, discounts = null, outstanding = null, overdue = null;
      if (canFees) {
        const invs = mine('studentFees').filter(i => !i.cancelled), sts = mine('students').filter(x => !x.softDeleted), pays = mine('feePayments'), strs = mine('feeStructures'), today = new Date().toISOString().slice(0, 10);
        invoiced = Finance.r2(invs.filter(yr).reduce((t, i) => t + Finance.invoiceNet(i), 0)); discounts = Finance.r2(invs.filter(yr).reduce((t, i) => t + (Number(i.discount) || 0), 0));
        outstanding = 0; overdue = 0; sts.forEach(x => { const bal = Finance.studentBalance(x, { structures: strs, invoices: invs, payments: pays, today }); outstanding = Finance.r2(outstanding + bal.remaining); overdue = Finance.r2(overdue + bal.overdue); });
      }
      return { id: b.id, name: b.name, status: b.status, students: mine('students').filter(x => !x.softDeleted).length, teachers: mine('teachers').length, staff: mine('staff').length,
        classes: mine('classes').length, courses: mine('courses').length, income, invoiced, discounts, outstanding, overdue, expenses, salaries, net };
    });
    const tot = { students: 0, teachers: 0, staff: 0, classes: 0, income: 0, expenses: 0, salaries: 0, net: 0, invoiced: 0, discounts: 0, outstanding: 0, overdue: 0 };
    rows.forEach(r => Object.keys(tot).forEach(k => { tot[k] = tot[k] === null || r[k] === null ? null : tot[k] + r[k]; }));
    return { rows, total: tot, yearId: yearId || null };
  };

  H['db:log'] = (c, key, entries) => {
    if (!Array.isArray(entries) || entries.length > 100) throw bad();
    const s = (v, n) => String(v === undefined || v === null ? '' : v).slice(0, n);
    const clean = entries.filter(e => e && typeof e === 'object').map(e => ({ ts: new Date().toISOString(), date: new Date().toISOString().slice(0, 10),
      time: s(e.time, 20), user: c.u.name, userId: c.u.id, action: s(e.action, 40), section: s(e.section, 60), description: s(e.description, 500) }));
    store.appendLogs(clean); return true;
  };

  H['db:save'] = (c, key, ops) => {
    if (!Array.isArray(ops) || ops.length > 800) throw bad('درخواست ذخیره‌سازی نامعتبر است.');
    ensureBranches();
    const plan = []; const dflt = defaultBranchId(); const bset = new Set(branchList().map(b => b.id)); let touchedBranches = false;
    for (const op of ops) {
      if (!op || typeof op.name !== 'string') throw bad();
      if (op.object !== undefined) {
        const rule = OBJECT_RULES[op.name]; if (!rule) throw fail('FORBIDDEN', 'مجموعه‌ی نامعتبر: ' + op.name);
        need(c, rule.write, op.name);
        if (op.name === 'settings' && isRestricted(c)) { audit(c, 'دسترسی ردشد', 'امنیت', 'تنظیمات مرکز توسط کاربر شعبه'); throw fail('FORBIDDEN', 'شما اجازه‌ی انجام این عملیات را ندارید.'); }
        if (op.object === null || typeof op.object !== 'object' || Array.isArray(op.object)) throw bad();
        if (JSON.stringify(op.object).length > 2e6) throw bad('داده بیش از حد بزرگ است.');
        const prev = store.readObject(op.name);
        plan.push({ op: { name: op.name, object: op.object }, audit: rule.audit && JSON.stringify(prev) !== JSON.stringify(op.object) ? { name: op.name, added: 0, changed: 1, removed: 0, ids: [] } : null });
        continue;
      }
      const rule = COLLECTION_RULES[op.name];
      if (!rule) throw fail('FORBIDDEN', 'مجموعه‌ی نامعتبر: ' + op.name);
      need(c, rule.write, op.name);
      if (!Array.isArray(op.records)) throw bad();
      const shard = SHARDED[op.name] ? String(op.shard || '_') : '';
      if (SHARDED[op.name] && !/^[A-Za-z0-9_\-]+$/.test(shard)) throw bad('شناسه‌ی سال نامعتبر است.');
      const seen = new Set();
      op.records.forEach(r => {
        if (!r || typeof r !== 'object' || Array.isArray(r)) throw bad('رکورد نامعتبر در «' + op.name + '».');
        if (r.id !== undefined) { if (typeof r.id !== 'string' || !r.id) throw bad('شناسه‌ی نامعتبر.'); if (seen.has(r.id)) throw bad('شناسه‌ی تکراری «' + r.id + '» در ' + op.name); seen.add(r.id); }
      });
      if (JSON.stringify(op.records).length > 60e6) throw bad('داده بیش از حد بزرگ است.');
      const scoped = BRANCH_SCOPED.has(op.name);
      const scope = scoped ? scopeOf(c, op.scopeBranch) : null;
      if (op.name === 'branches' && isRestricted(c)) { audit(c, 'دسترسی ردشد', 'امنیت', 'مدیریت شعبه‌ها توسط کاربر شعبه'); throw fail('FORBIDDEN', 'شما اجازه‌ی انجام این عملیات را ندارید.'); }
      const prevAll = store.readCollection(op.name, shard);
      const inScope = (r) => r && (r.branchId || dflt) === scope;
      const prev = scope ? prevAll.filter(inScope) : prevAll;
      const prevMap = new Map(); prevAll.forEach(r => { if (r && r.id) prevMap.set(r.id, r); });
      let records = op.records;
      if (scoped) {
        records.forEach(r => {
          if (scope) {
            const p = r.id ? prevMap.get(r.id) : null;
            if (p && (p.branchId || dflt) !== scope) { audit(c, 'دسترسی ردشد', 'امنیت', op.name + ' — رکورد شعبه‌ی دیگر ' + r.id); throw fail('FORBIDDEN', 'این رکورد متعلق به شعبه‌ی دیگری است.'); }
            r.branchId = scope;
          } else if (!r.branchId) r.branchId = dflt;
          else if (!bset.has(r.branchId)) throw bad('شعبه‌ی نامعتبر در «' + op.name + '».');
        });
      }
      if (op.name === 'branches') {
        const names = new Set();
        records = records.map(r => { const cb = cleanBranch(r, prevMap.get(r.id), dflt); const k = cb.name.toLowerCase(); if (names.has(k)) throw bad('نام شعبه تکراری است: ' + cb.name); names.add(k); return cb; });
        const gone = prev.filter(r => r && r.id && !seen.has(r.id));
        gone.forEach(r => { if (r.isDefault) throw bad('شعبه‌ی پیش‌فرض حذف‌شدنی نیست.'); const u = branchUsage(r.id); if (u.records || u.users) throw bad('شعبه «' + r.name + '» دارای اطلاعات (' + u.records + ' رکورد) یا کاربر (' + u.users + ') است؛ آن را غیرفعال کنید.'); });
        if (!records.some(r => r.status === 'فعال')) throw bad('حداقل یک شعبه‌ی فعال باید وجود داشته باشد.');
        if (!records.some(r => r.isDefault) && prev.some(r => r.isDefault)) throw bad('شعبه‌ی پیش‌فرض حذف‌شدنی نیست.');
        touchedBranches = true;
      }
      const removed = prev.filter(r => r && r.id && !seen.has(r.id));
      if (removed.length && rule.perm) need(c, rule.perm, op.name + ' (حذف)');
      if (op.name === 'students') records.forEach(r => { const p = prevMap.get(r.id); if (r.softDeleted && !(p && p.softDeleted)) need(c, 'students.delete', 'حذف شاگرد'); });
      let added = 0, changed = 0; const ids = [];
      records.forEach(r => { const p = r.id ? prevMap.get(r.id) : null; if (!p) { added++; if (ids.length < 10) ids.push(r.id); } else if (JSON.stringify(p) !== JSON.stringify(r)) { changed++; if (ids.length < 10) ids.push(r.id); } });
      removed.slice(0, 10).forEach(r => ids.length < 10 && ids.push(r.id));
      const finalRecords = scope ? prevAll.filter(r => !inScope(r)).concat(records) : records;
      plan.push({ op: { name: op.name, shard, records: finalRecords }, audit: rule.audit && (added + changed + removed.length) ? { name: op.name, added, changed, removed: removed.length, ids } : null });
    }
    validateAcademic(plan);
    validateFinance(c, plan);
    validateAssessment(plan);
    const res = store.save(plan.map(p => p.op));
    if (touchedBranches) { branchesCache = null; branchesChecked = false; }
    plan.forEach(p => { if (p.audit) { const a = p.audit;
      audit(c, p.op.name === 'marks' ? 'تغییر نمره' : 'تغییر مالی/حساس', AUDIT_SECTIONS[a.name] || a.name, 'جدید: ' + a.added + '، ویرایش: ' + a.changed + '، حذف: ' + a.removed + (a.ids.length ? ' — ' + a.ids.join(', ') : '')); } });
    onChange();
    return res;
  };

  // ---------- کاربران و صلاحیت‌ها ----------
  H['users:save'] = (c, key, rec, password) => {
    rec = rec || {};
    const name = String(rec.name || '').trim(), username = String(rec.username || '').trim();
    const role = authz.normalizeRole(rec.role), status = rec.status;
    if (!name || name.length > 100) throw bad('نام کامل را وارد کنید.');
    if (!USERNAME_RE.test(username)) throw bad('نام کاربری باید ۳ تا ۳۲ کاراکتر (حرف، عدد، نقطه، خط تیره) باشد.');
    if (!ROLES[role]) throw bad('نقش نامعتبر است.');
    if (status !== 'فعال' && status !== 'غیرفعال') throw bad('وضعیت نامعتبر است.');
    const list = users();
    if (list.some(u => u.id !== rec.id && String(u.username).toLowerCase() === username.toLowerCase())) throw bad('این نام کاربری قبلاً استفاده شده است.');
    let u = rec.id ? list.find(x => x.id === rec.id) : null;
    if (rec.id && !u) throw bad('کاربر یافت نشد.');
    let branchId = rec.branchId === undefined ? (u ? (u.branchId || null) : null) : (rec.branchId || null);
    if (role === 'admin') branchId = null;
    if (isRestricted(c)) { if (role === 'admin' || role === 'manager') throw fail('FORBIDDEN', 'شما اجازه‌ی انجام این عملیات را ندارید.'); branchId = c.u.branchId; }
    if (branchId && !branchList().some(b => b.id === branchId)) throw bad('شعبه نامعتبر است.');
    if (role === 'branch_manager' && !branchId) throw bad('برای «مدیر شعبه» انتخاب شعبه الزامی است.');
    if (u) {
      guardUserTarget(c, u);
      const wasAdmin = authz.normalizeRole(u.role) === 'admin' && u.status === 'فعال';
      if (u.id === c.u.id && (role !== authz.normalizeRole(u.role) || status !== 'فعال')) throw bad('نقش یا وضعیت حساب خودتان را نمی‌توانید تغییر دهید.');
      if (wasAdmin && (role !== 'admin' || status !== 'فعال') && activeAdmins().length <= 1) throw bad('حداقل یک مدیر سیستم فعال باید باقی بماند.');
      const oldRole = u.role;
      Object.assign(u, { name, username, role, status, branchId });
      if (status !== 'فعال') for (const [k, s] of sessions) if (s.userId === u.id) sessions.delete(k);
      saveUsers(list);
      audit(c, 'تغییر کاربران و صلاحیت‌ها', 'کاربران', 'کاربر «' + name + '» ویرایش شد' + (oldRole !== role ? ' (نقش: ' + oldRole + ' → ' + role + ')' : '') + '.');
    } else {
      const pe = validatePassword(password, username); if (pe) throw bad(pe);
      u = { id: nextUserId(), name, username, role, status, branchId, password: store.hashPassword(password), lastLogin: null, mustChange: true };
      list.push(u); saveUsers(list);
      audit(c, 'تغییر کاربران و صلاحیت‌ها', 'کاربران', 'کاربر جدید «' + name + '» با نقش ' + role + ' ایجاد شد.');
    }
    onChange();
    return pub(u, true);
  };
  H['users:delete'] = (c, key, id) => {
    const list = users(); const u = list.find(x => x.id === id);
    if (!u) throw bad('کاربر یافت نشد.');
    guardUserTarget(c, u);
    if (u.id === c.u.id) throw bad('حساب خودتان را نمی‌توانید حذف کنید.');
    if (authz.normalizeRole(u.role) === 'admin' && u.status === 'فعال' && activeAdmins().length <= 1) throw bad('حداقل یک مدیر سیستم فعال باید باقی بماند.');
    saveUsers(list.filter(x => x.id !== id));
    for (const [k, s] of sessions) if (s.userId === id) sessions.delete(k);
    audit(c, 'حذف', 'کاربران', 'کاربر «' + u.name + '» حذف شد.'); onChange();
    return { ok: true };
  };
  H['users:setPassword'] = (c, key, id, newPw) => {
    const list = users(); const u = list.find(x => x.id === id);
    if (!u) throw bad('کاربر یافت نشد.');
    guardUserTarget(c, u);
    const pe = validatePassword(newPw, u.username); if (pe) throw bad(pe);
    u.password = store.hashPassword(newPw); u.mustChange = u.id !== c.u.id;   // رمز تعیین‌شده توسط مدیر: کاربر باید در اولین ورود تغییر دهد
    saveUsers(list);
    for (const [k, s] of sessions) if (s.userId === id && k !== key) sessions.delete(k);
    audit(c, 'تغییر کاربران و صلاحیت‌ها', 'کاربران', 'رمز عبور «' + u.name + '» بازنشانی شد.'); onChange();
    return { ok: true, mustChange: u.mustChange };
  };
  H['perms:matrix'] = () => {
    const matrix = {}, defaults = {};
    Object.keys(ROLES).forEach(r => { matrix[r] = authz.effectivePerms(r, rolePerms()); defaults[r] = authz.effectivePerms(r, {}); });
    return { roles: ROLES, permissions: PERMISSIONS, matrix, defaults };
  };
  H['perms:set'] = (c, key, role, perms) => {
    role = authz.normalizeRole(role);
    if (!ROLES[role] || role === 'admin') throw bad('صلاحیت‌های این نقش قابل تغییر نیست.');
    const next = Object.assign({}, rolePerms());
    if (perms === null) delete next[role];
    else { if (!Array.isArray(perms)) throw bad(); next[role] = perms.filter(p => PERMISSIONS[p]); }
    store.save([{ name: 'rolePerms', object: next }]); permsCache = next;
    audit(c, 'تغییر کاربران و صلاحیت‌ها', 'صلاحیت‌ها', 'صلاحیت‌های نقش «' + ROLES[role] + '» ' + (perms === null ? 'به پیش‌فرض بازگشت.' : 'تغییر کرد (' + next[role].length + ' صلاحیت).')); onChange();
    return { ok: true, perms: authz.effectivePerms(role, next) };
  };
  H['recovery:regenerate'] = (c) => { const code = store.generateRecoveryCode(); audit(c, 'تغییر کاربران و صلاحیت‌ها', 'کاربران', 'کد بازیابی جدید ساخته شد.'); return code; };
  H['recovery:reset'] = (c, key, code, newPw) => {
    throttle('recovery');
    if (!store.verifyRecoveryCode(code)) { recordFail('recovery'); audit(null, 'بازیابی ناموفق', 'احراز هویت', 'کد بازیابی نادرست وارد شد.'); throw fail('BAD_CREDENTIALS', 'کد بازیابی نادرست است.'); }
    const list = users(); const admin = list.find(u => authz.normalizeRole(u.role) === 'admin');
    if (!admin) throw bad('کاربر مدیر سیستم یافت نشد.');
    const pe = validatePassword(newPw, admin.username); if (pe) throw bad(pe);
    attempts.delete('recovery');
    admin.password = store.hashPassword(newPw); admin.status = 'فعال'; admin.mustChange = false; saveUsers(list);
    sessions.clear();
    const fresh = store.generateRecoveryCode();           // کد مصرف‌شده باطل و کد تازه ساخته می‌شود
    audit({ u: admin }, 'تغییر رمز', 'احراز هویت', 'رمز مدیر سیستم با کد بازیابی تغییر کرد.'); onChange();
    return { ok: true, username: admin.username, newRecoveryCode: fresh };
  };

  // ---------- Backup / Restore ----------
  function pathAllowed(p) {
    if (typeof p !== 'string' || !p) return false;
    return allowedPaths.has(p) || store.listBackups().some(b => b.path === p);
  }
  H['backup:create'] = (c) => { const r = store.createBackup('manual', { force: true }); audit(c, 'پشتیبان‌گیری', 'پشتیبان‌گیری', 'نسخه‌ی پشتیبان دستی ایجاد شد.'); return r; };
  H['backup:list'] = () => store.listBackups();
  H['backup:info'] = () => ({ config: store.getConfig(), meta: store.getMeta() });
  H['backup:verify'] = (c, key, p) => { if (!pathAllowed(p)) throw fail('FORBIDDEN', 'مسیر فایل مجاز نیست.'); return store.verifyFile(p); };
  H['backup:setConfig'] = (c, key, cfg) => { const r = store.setConfig(cfg || {}); audit(c, 'تغییر تنظیمات', 'پشتیبان‌گیری', 'تنظیمات پشتیبان‌گیری تغییر کرد.'); return r; };
  H['backup:restore'] = (c, key, p, o) => {
    if (!pathAllowed(p)) throw fail('FORBIDDEN', 'مسیر فایل مجاز نیست.');
    let r;
    try { r = store.restoreBackup(p, o && o.__failAt && opts.allowTestHooks ? o : undefined); }
    catch (e) { audit(c, 'Restore ناموفق', 'پشتیبان‌گیری', e.message); throw e; }
    invalidate(); sessions.clear();                      // کاربران/صلاحیت‌ها ممکن است تغییر کرده باشند؛ همه باید دوباره وارد شوند
    audit(null, 'Restore', 'پشتیبان‌گیری', 'اطلاعات از «' + String(p).split(/[\\/]/).pop() + '» بازیابی شد.'); onChange();
    return r;
  };
  // ---------- فایل‌ها ----------
  H['file:save'] = (c, key, id, b64) => store.saveFile(id, b64);
  H['file:get'] = (c, key, id) => store.readFile(id);
  H['file:delete'] = (c, key, id) => store.deleteFile(id);

  function invoke(key, channel, args) {
    const c = authorize(key, channel);
    const fn = H[channel];
    if (!fn) throw fail('FORBIDDEN', 'این عملیات فقط در پردازه‌ی اصلی پشتیبانی می‌شود.');
    return fn(c, key, ...(Array.isArray(args) ? args : []));
  }
  return { invoke, authorize, audit, ctx, hasHandler: (ch) => !!H[ch], allowRestorePath: (p) => allowedPaths.add(p), clearSession: (k) => sessions.delete(k),
    sessionUser: (k) => { const c = ctx(k); return c ? pub(c.u, true) : null; }, invalidate, validatePassword };
}

module.exports = { createService, validatePassword };
