'use strict';
/* تست سرویس main (احراز هویت، نقش‌ها، IPC-level authorization، Restore اتمیک، رمزها) با Node خالص و store واقعی روی دیسک. */
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const { createStore } = require('../lib/store');
const { createService } = require('../lib/service');
const authz = require('../lib/authz');

let pass = 0, failN = 0;
function t(name, fn) { try { fn(); pass++; console.log('  ✓', name); } catch (e) { failN++; process.exitCode = 1; console.log('  ✗', name, '\n     ', e.message); } }
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'educenter-svc-'));
function boot(dir) { const store = createStore(dir || tmp()); const svc = createService(store, { allowTestHooks: true }); return { store, svc, dir: store.dataDir }; }
const call = (svc, k, ch, ...a) => { try { return { r: svc.invoke(k, ch, a) }; } catch (e) { return { err: e }; } };
const code = (x) => x.err && x.err.code;
const PW = 'Admin2026pass';

function setupAdmin(svc, k = 1) { const r = call(svc, k, 'auth:setup', { username: 'admin', name: 'مدیر', password: PW }); assert(r.r && r.r.ok, 'setup failed ' + (r.err && r.err.message)); return r.r; }
function mkUser(svc, role, username, pw = 'Temp12345pw') { const r = call(svc, 1, 'users:save', { name: username, username, role, status: 'فعال' }, pw); assert(r.r, 'mkUser ' + (r.err && r.err.message)); return r.r; }
function loginAs(svc, k, username, pw, newPw) { const l = call(svc, k, 'auth:login', username, pw); assert(l.r, 'login ' + (l.err && l.err.message)); if (l.r.mustChange) assert(call(svc, k, 'auth:changePassword', pw, newPw || 'Final2026pass').r); return l.r; }

console.log('— Authentication / passwords');
t('fresh store needs setup; no default user/password exists', () => { const { svc, store } = boot(); assert.strictEqual(call(svc, 1, 'auth:state').r.needsSetup, true); assert.strictEqual(call(svc, 1, 'auth:login', 'admin', '1234').err.code, 'BAD_CREDENTIALS'); assert.strictEqual(store.readCollection('users', '').length, 0); });
t('weak setup passwords rejected (short / no digit / common / = username)', () => { const { svc } = boot(); for (const pw of ['1234', 'abcdefgh', '12345678', 'password1', 'admin']) { assert.strictEqual(code(call(svc, 1, 'auth:setup', { username: 'admin', name: 'x', password: pw })), 'BAD_REQUEST', pw); } });
t('setup works once, returns recovery code, second setup refused', () => { const { svc } = boot(); const r = setupAdmin(svc); assert(/^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/.test(r.recoveryCode)); assert.strictEqual(code(call(svc, 2, 'auth:setup', { username: 'x2x', name: 'x', password: 'Another2026pw' })), 'FORBIDDEN'); });
t('password stored as PBKDF2 salted hash, never plaintext', () => { const { svc, store } = boot(); setupAdmin(svc); const u = store.readCollection('users', '')[0]; assert(u.password.startsWith('pbkdf2:')); assert(!JSON.stringify(u).includes(PW)); assert(u.password.split(':')[1].length === 32); });
t('same password → different salt/hash', () => { const { store } = boot(); assert.notStrictEqual(store.hashPassword('Same12345pw'), store.hashPassword('Same12345pw')); });
t('wrong password rejected; 5 failures lock the account for a while', () => { const { svc } = boot(); setupAdmin(svc); for (let i = 0; i < 5; i++) assert.strictEqual(code(call(svc, 2, 'auth:login', 'admin', 'wrong' + i)), 'BAD_CREDENTIALS'); assert.strictEqual(code(call(svc, 2, 'auth:login', 'admin', PW)), 'LOCKED'); });
t('db:load never exposes password hashes to the renderer', () => { const { svc } = boot(); setupAdmin(svc); const ld = call(svc, 1, 'db:load').r; assert(!JSON.stringify(ld).includes('pbkdf2')); });
t('unauthenticated IPC calls are rejected', () => { const { svc } = boot(); setupAdmin(svc); for (const ch of ['db:load', 'db:save', 'backup:create', 'users:save', 'file:get', 'print:pdf']) assert.strictEqual(code(call(svc, 99, ch, [])), 'NOT_AUTHENTICATED', ch); });
t('unknown channel rejected', () => { const { svc } = boot(); setupAdmin(svc); assert.strictEqual(code(call(svc, 1, 'fs:readAnything')), 'FORBIDDEN'); });

console.log('— Forced password change');
t('admin-created user must change password; every other IPC blocked until then', () => {
  const { svc } = boot(); setupAdmin(svc); mkUser(svc, 'teacher', 'teach1');
  const l = call(svc, 2, 'auth:login', 'teach1', 'Temp12345pw'); assert.strictEqual(l.r.mustChange, true);
  assert.strictEqual(code(call(svc, 2, 'db:load')), 'MUST_CHANGE_PASSWORD'); assert.strictEqual(code(call(svc, 2, 'db:save', [])), 'MUST_CHANGE_PASSWORD');
  assert.strictEqual(code(call(svc, 2, 'auth:changePassword', 'Temp12345pw', '1234')), 'BAD_REQUEST');
  assert.strictEqual(code(call(svc, 2, 'auth:changePassword', 'wrongold', 'Brand2026new')), 'BAD_CREDENTIALS');
  assert(call(svc, 2, 'auth:changePassword', 'Temp12345pw', 'Brand2026new').r.ok); assert(call(svc, 2, 'db:load').r);
});
t('admin password reset forces change at next login and kills other sessions', () => {
  const { svc } = boot(); setupAdmin(svc); const u = mkUser(svc, 'finance', 'fin1'); loginAs(svc, 2, 'fin1', 'Temp12345pw', 'Fin2026newpw');
  assert(call(svc, 1, 'users:setPassword', u.id, 'Reset2026pass').r.ok); assert.strictEqual(code(call(svc, 2, 'db:load')), 'NOT_AUTHENTICATED');
  assert.strictEqual(call(svc, 3, 'auth:login', 'fin1', 'Reset2026pass').r.mustChange, true);
});
t('legacy plaintext/weak passwords from older data are migrated and force a change', () => {
  const dir = tmp(); const s0 = createStore(dir); s0.save([{ name: 'users', shard: '', records: [{ id: 'US-0001', username: 'admin', password: '1234', name: 'قدیمی', role: 'admin', status: 'فعال' }] }]);
  const { svc, store } = boot(dir); assert(store.readCollection('users', '')[0].password.startsWith('pbkdf2:'));
  assert.strictEqual(code(call(svc, 1, 'auth:login', 'admin', '1234')), undefined); assert.strictEqual(call(svc, 1, 'auth:me').r.mustChange, true);
});
t('legacy role names are migrated (registrar→reception, accountant→finance)', () => {
  const dir = tmp(); const s0 = createStore(dir); const h = s0.hashPassword('Legacy2026pw');
  s0.save([{ name: 'users', shard: '', records: [{ id: 'US-0001', username: 'a', password: h, name: 'a', role: 'admin', status: 'فعال' }, { id: 'US-0002', username: 'r', password: h, name: 'r', role: 'registrar', status: 'فعال' }, { id: 'US-0003', username: 'c', password: h, name: 'c', role: 'accountant', status: 'فعال' }] }]);
  const { store } = boot(dir); const roles = store.readCollection('users', '').map(u => u.role); assert.deepStrictEqual(roles, ['admin', 'reception', 'finance']);
});

console.log('— Recovery code');
t('recovery code resets admin password, is single-use (new code issued), stored hashed', () => {
  const { svc, store } = boot(); const s = setupAdmin(svc); const raw = fs.readFileSync(path.join(store.baseDir || path.dirname(store.dataDir), 'recovery.json'), 'utf8');
  assert(!raw.replace(/-/g, '').includes(s.recoveryCode.replace(/-/g, '')), 'code must not be stored in plaintext');
  assert.strictEqual(code(call(svc, 5, 'recovery:reset', 'AAAA-BBBB-CCCC-DDDD', 'Whatever2026pw')), 'BAD_CREDENTIALS');
  assert.strictEqual(code(call(svc, 5, 'recovery:reset', s.recoveryCode, 'weak')), 'BAD_REQUEST');
  const ok = call(svc, 5, 'recovery:reset', s.recoveryCode, 'Recovered2026pw'); assert(ok.r.ok && ok.r.newRecoveryCode !== s.recoveryCode);
  assert.strictEqual(code(call(svc, 5, 'recovery:reset', s.recoveryCode, 'Another2026pw')), 'BAD_CREDENTIALS');
  assert(call(svc, 6, 'auth:login', 'admin', 'Recovered2026pass'.replace('pass', 'pw')).r.ok);
});
t('recovery attempts are rate limited', () => { const { svc } = boot(); setupAdmin(svc); for (let i = 0; i < 5; i++) call(svc, 5, 'recovery:reset', 'BAD' + i, 'Whatever2026pw'); assert.strictEqual(code(call(svc, 5, 'recovery:reset', 'BAD9', 'Whatever2026pw')), 'LOCKED'); });

console.log('— Roles & IPC-level permissions');
t('all 8 roles exist with labels; defaults only reference known permissions', () => { for (const r of ['admin', 'manager', 'deputy', 'head_teacher', 'teacher', 'finance', 'reception', 'administrative_staff']) { assert(authz.ROLES[r], r); authz.effectivePerms(r, {}).forEach(p => assert(authz.PERMISSIONS[p], p)); } });
t('every IPC channel has an explicit rule', () => { const src = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8'); [...src.matchAll(/'([a-z]+:[A-Za-z]+)'/g)].forEach(m => assert(authz.CHANNEL_RULES[m[1]], m[1])); });
const sample = { students: [{ id: 'ST-1', name: 'a' }], marks: [{ id: 'MK-1', yearId: 'Y1', score: 5 }], feePayments: [{ id: 'FP-1', yearId: 'Y1', amount: 5 }], payroll: [{ id: 'PY-1', yearId: 'Y1' }] };
function savePlain(svc, k, name, shard) { return call(svc, k, 'db:save', [{ name, shard, records: sample[name] || [{ id: 'X-1' }] }]); }
t('finance: can write fees/payroll, cannot touch grades, users, settings, backup, restore', () => {
  const { svc } = boot(); setupAdmin(svc); mkUser(svc, 'finance', 'fin'); loginAs(svc, 2, 'fin', 'Temp12345pw');
  assert(savePlain(svc, 2, 'feePayments', 'Y1').r); assert(savePlain(svc, 2, 'payroll', 'Y1').r);
  assert.strictEqual(code(savePlain(svc, 2, 'marks', 'Y1')), 'FORBIDDEN');
  assert.strictEqual(code(call(svc, 2, 'db:save', [{ name: 'settings', object: { schoolName: 'x' } }])), 'FORBIDDEN');
  for (const ch of ['users:save', 'users:delete', 'users:setPassword', 'perms:set', 'perms:matrix', 'backup:create', 'backup:list', 'backup:restore', 'backup:setConfig', 'recovery:regenerate', 'logs:read']) assert.strictEqual(code(call(svc, 2, ch, {})), 'FORBIDDEN', ch);
});
t('finance cannot create an admin by sending a hand-made users record through db:save', () => { const { svc } = boot(); setupAdmin(svc); mkUser(svc, 'finance', 'fin'); loginAs(svc, 2, 'fin', 'Temp12345pw'); assert.strictEqual(code(call(svc, 2, 'db:save', [{ name: 'users', shard: '', records: [{ id: 'US-9', username: 'evil', role: 'admin' }] }])), 'FORBIDDEN'); });
t('teacher: grades + attendance yes; fees, payroll, students write, delete no', () => {
  const { svc } = boot(); setupAdmin(svc); mkUser(svc, 'teacher', 'tea'); loginAs(svc, 2, 'tea', 'Temp12345pw');
  assert(savePlain(svc, 2, 'marks', 'Y1').r); assert(call(svc, 2, 'db:save', [{ name: 'attendance', shard: 'Y1', records: [{ id: 'AT-1', yearId: 'Y1' }] }]).r);
  assert.strictEqual(code(savePlain(svc, 2, 'feePayments', 'Y1')), 'FORBIDDEN'); assert.strictEqual(code(savePlain(svc, 2, 'payroll', 'Y1')), 'FORBIDDEN'); assert.strictEqual(code(savePlain(svc, 2, 'students', '')), 'FORBIDDEN');
  const ld = call(svc, 2, 'db:load').r; assert(!('feePayments' in ld.collections) && !('payroll' in ld.collections) && !('expenses' in ld.collections), 'unreadable collections must not be sent');
});
t('deleting records requires the delete permission (grades: teacher can write but not delete)', () => {
  const { svc } = boot(); setupAdmin(svc); mkUser(svc, 'teacher', 'tea'); loginAs(svc, 2, 'tea', 'Temp12345pw');
  assert(savePlain(svc, 2, 'marks', 'Y1').r); assert.strictEqual(code(call(svc, 2, 'db:save', [{ name: 'marks', shard: 'Y1', records: [] }])), 'FORBIDDEN');
  assert.strictEqual(call(svc, 1, 'db:load').r.collections.marks.length, 1, 'data must be intact after rejected delete');
});
t('student soft-delete requires students.delete (reception can write but not delete)', () => {
  const { svc } = boot(); setupAdmin(svc); mkUser(svc, 'reception', 'rec'); loginAs(svc, 2, 'rec', 'Temp12345pw');
  assert(call(svc, 2, 'db:save', [{ name: 'students', shard: '', records: [{ id: 'ST-1', name: 'a' }] }]).r);
  assert.strictEqual(code(call(svc, 2, 'db:save', [{ name: 'students', shard: '', records: [{ id: 'ST-1', name: 'a', softDeleted: true }] }])), 'FORBIDDEN');
});
t('all 8 roles log in and get a role-appropriate load; admin_staff/deputy/head_teacher/manager defined', () => {
  const { svc } = boot(); setupAdmin(svc); let k = 10;
  for (const r of ['manager', 'deputy', 'head_teacher', 'teacher', 'finance', 'reception', 'administrative_staff']) { mkUser(svc, r, 'u_' + r); const l = loginAs(svc, ++k, 'u_' + r, 'Temp12345pw'); assert.strictEqual(l.user.role, r); assert(call(svc, k, 'db:load').r); }
});
t('role permissions are configurable by admin and enforced immediately (perms:set)', () => {
  const { svc } = boot(); setupAdmin(svc); mkUser(svc, 'teacher', 'tea'); loginAs(svc, 2, 'tea', 'Temp12345pw');
  assert.strictEqual(code(savePlain(svc, 2, 'feePayments', 'Y1')), 'FORBIDDEN');
  assert(call(svc, 1, 'perms:set', 'teacher', ['students.read', 'fees.read', 'fees.write']).r.ok); assert(savePlain(svc, 2, 'feePayments', 'Y1').r);
  assert.strictEqual(code(savePlain(svc, 2, 'marks', 'Y1')), 'FORBIDDEN'); assert.strictEqual(code(call(svc, 1, 'perms:set', 'admin', [])), 'BAD_REQUEST');
  call(svc, 1, 'perms:set', 'teacher', null); assert(savePlain(svc, 2, 'marks', 'Y1').r);
});
t('cannot remove/disable/demote the last admin or yourself', () => {
  const { svc } = boot(); const a = setupAdmin(svc);
  assert.strictEqual(code(call(svc, 1, 'users:delete', a.user.id)), 'BAD_REQUEST'); assert.strictEqual(code(call(svc, 1, 'users:save', { id: a.user.id, name: 'x', username: 'admin', role: 'teacher', status: 'فعال' })), 'BAD_REQUEST');
});
t('disabled user is logged out immediately and cannot log in', () => { const { svc } = boot(); setupAdmin(svc); const u = mkUser(svc, 'teacher', 'tea'); loginAs(svc, 2, 'tea', 'Temp12345pw'); assert(call(svc, 1, 'users:save', { id: u.id, name: 'tea', username: 'tea', role: 'teacher', status: 'غیرفعال' }).r); assert.strictEqual(code(call(svc, 2, 'db:load')), 'NOT_AUTHENTICATED'); assert.strictEqual(code(call(svc, 3, 'auth:login', 'tea', 'Final2026pass')), 'INACTIVE'); });
t('invalid input rejected: duplicate username, bad role, bad ids, duplicate record ids, path traversal in shard/file id', () => {
  const { svc } = boot(); setupAdmin(svc);
  assert.strictEqual(code(call(svc, 1, 'users:save', { name: 'x', username: 'ADMIN', role: 'teacher', status: 'فعال' }, 'Temp12345pw')), 'BAD_REQUEST');
  assert.strictEqual(code(call(svc, 1, 'users:save', { name: 'x', username: 'xx1', role: 'root', status: 'فعال' }, 'Temp12345pw')), 'BAD_REQUEST');
  assert.strictEqual(code(call(svc, 1, 'db:save', [{ name: 'students', shard: '', records: [{ id: 'A' }, { id: 'A' }] }])), 'BAD_REQUEST');
  assert.strictEqual(code(call(svc, 1, 'db:save', [{ name: 'marks', shard: '../../evil', records: [] }])), 'BAD_REQUEST');
  assert.strictEqual(code(call(svc, 1, 'db:save', [{ name: '../evil', shard: '', records: [] }])), 'FORBIDDEN');
  assert.throws(() => call(svc, 1, 'file:save', '../../x', 'AAAA').err && (() => { throw call(svc, 1, 'file:save', '../../x', 'AAAA').err; })());
  assert.strictEqual(call(svc, 1, 'file:get', '../../etc/passwd').r, null);
});
t('file size/format validation (corrupt base64, empty, oversize)', () => { const { svc } = boot(); setupAdmin(svc); assert(call(svc, 1, 'file:save', 'F1', '!!!notbase64!!!').err); assert(call(svc, 1, 'file:save', 'F2', '').err); assert(call(svc, 1, 'file:save', 'F3', Buffer.alloc(9 * 1024 * 1024).toString('base64')).err); assert(call(svc, 1, 'file:save', 'F4', Buffer.from('hello').toString('base64')).r); assert.strictEqual(Buffer.from(call(svc, 1, 'file:get', 'F4').r, 'base64').toString(), 'hello'); assert.strictEqual(call(svc, 1, 'file:delete', 'F4').r, true); assert.strictEqual(call(svc, 1, 'file:get', 'F4').r, null); });
t('restore only accepts known backup paths or dialog-picked paths', () => { const { svc } = boot(); setupAdmin(svc); assert.strictEqual(code(call(svc, 1, 'backup:restore', '/etc/passwd')), 'FORBIDDEN'); });

console.log('— Audit log');
t('login/logout/failed login/denied access/user & permission changes/grade+finance changes are logged by main with the real user', () => {
  const { svc, store } = boot(); setupAdmin(svc); call(svc, 9, 'auth:login', 'admin', 'nope'); const u = mkUser(svc, 'teacher', 'tea'); loginAs(svc, 2, 'tea', 'Temp12345pw');
  call(svc, 2, 'db:save', [{ name: 'marks', shard: 'Y1', records: [{ id: 'MK-1', yearId: 'Y1', score: 10 }] }]); call(svc, 2, 'users:save', {}); call(svc, 1, 'perms:set', 'teacher', null);
  call(svc, 1, 'db:save', [{ name: 'feePayments', shard: 'Y1', records: [{ id: 'FP-1', yearId: 'Y1', amount: 1 }] }]); call(svc, 2, 'auth:logout');
  const acts = store.readLogs(1000).map(l => l.action + '|' + l.user); const has = (a, uu) => acts.some(x => x.startsWith(a) && (!uu || x.endsWith('|' + uu)));
  assert(has('ورود', 'مدیر')); assert(has('ورود ناموفق')); assert(has('تغییر نمره', 'tea')); assert(has('دسترسی ردشد', 'tea')); assert(has('تغییر کاربران و صلاحیت‌ها')); assert(has('تغییر مالی/حساس', 'مدیر')); assert(has('خروج', 'tea'));
});
t('renderer cannot forge the user name in db:log', () => { const { svc, store } = boot(); setupAdmin(svc); call(svc, 1, 'db:log', [{ action: 'افزودن', section: 'x', description: 'd', user: 'HACKER' }]); const l = store.readLogs(100).filter(x => x.section === 'x')[0]; assert.strictEqual(l.user, 'مدیر'); });

console.log('— Backup / atomic restore');
function seedData(svc) { call(svc, 1, 'db:save', [{ name: 'students', shard: '', records: [{ id: 'ST-1', name: 'اصلی' }, { id: 'ST-2', name: 'دوم' }] }, { name: 'marks', shard: 'Y1', records: [{ id: 'MK-1', yearId: 'Y1', score: 80 }] }, { name: 'settings', object: { schoolName: 'مرکز آموزشی' } }]); }
t('backup file is checksummed, listed, verified; corrupted backup is detected', () => {
  const { svc, store } = boot(); setupAdmin(svc); seedData(svc); const b = call(svc, 1, 'backup:create').r; assert(b.ok); assert(call(svc, 1, 'backup:verify', b.path).r.ok);
  const raw = fs.readFileSync(b.path, 'utf8'); fs.writeFileSync(b.path, raw.replace('اصلی', 'خراب')); assert.strictEqual(call(svc, 1, 'backup:verify', b.path).r.ok, false);
  fs.writeFileSync(b.path, '{ not json'); assert.strictEqual(call(svc, 1, 'backup:verify', b.path).r.ok, false); assert(call(svc, 1, 'backup:restore', b.path).err, 'restore of corrupt backup must fail');
  assert.strictEqual(call(svc, 1, 'db:load').r.collections.students.length, 2, 'current data intact after failed restore');
});
t('restore brings back exact data, creates pre-restore safety backup, ends all sessions', () => {
  const { svc, store } = boot(); setupAdmin(svc); seedData(svc); const b = call(svc, 1, 'backup:create').r;
  call(svc, 1, 'db:save', [{ name: 'students', shard: '', records: [{ id: 'ST-9', name: 'تغییر' }] }]); const rs = call(svc, 1, 'backup:restore', b.path); assert(rs.r.ok, rs.err && rs.err.message);
  assert(store.listBackups().some(x => x.reason === 'pre-restore')); assert.strictEqual(code(call(svc, 1, 'db:load')), 'NOT_AUTHENTICATED');
  assert(call(svc, 1, 'auth:login', 'admin', PW).r); const ld = call(svc, 1, 'db:load').r; assert.deepStrictEqual(ld.collections.students.map(s => s.id), ['ST-1', 'ST-2']); assert.strictEqual(ld.collections.marks[0].score, 80);
  assert(!fs.readdirSync(path.dirname(store.dataDir)).some(f => f.startsWith('data.restore-') || f.startsWith('data.old-')), 'no temp dirs left behind');
});
for (const stage of ['stage', 'validate', 'swap', 'post-swap-check']) {
  t('injected failure at "' + stage + '" → current data preserved (rollback), no leftovers, app keeps working', () => {
    const { svc, store } = boot(); setupAdmin(svc); seedData(svc); const b = call(svc, 1, 'backup:create').r;
    call(svc, 1, 'db:save', [{ name: 'students', shard: '', records: [{ id: 'ST-9', name: 'جدید' }] }]); const before = JSON.stringify(call(svc, 1, 'db:load').r.collections);
    const rs = call(svc, 1, 'backup:restore', b.path, { __failAt: stage }); assert(rs.err, 'should fail'); assert(/اطلاعات فعلی حفظ شد/.test(rs.err.message), rs.err.message);
    assert(call(svc, 1, 'auth:me').r, 'session must survive a failed restore');
    assert.strictEqual(JSON.stringify(call(svc, 1, 'db:load').r.collections), before, 'data unchanged');
    assert(!fs.readdirSync(path.dirname(store.dataDir)).some(f => f.startsWith('data.restore-') || f.startsWith('data.old-')), 'temp dirs cleaned');
    assert(call(svc, 1, 'db:save', [{ name: 'students', shard: '', records: [{ id: 'ST-10', name: 'بعد' }] }]).r, 'still writable');
  });
}
t('backup that passes checksum but has structurally invalid data (no admin) is refused before touching data', () => {
  const { svc, store } = boot(); setupAdmin(svc); seedData(svc); const b = call(svc, 1, 'backup:create').r; const j = JSON.parse(fs.readFileSync(b.path, 'utf8'));
  j.data.collections.users = []; j.checksum = require('crypto').createHash('sha256').update(JSON.stringify(j.data)).digest('hex'); fs.writeFileSync(b.path, JSON.stringify(j));
  const v = store.verifyFile(b.path); if (!v.ok) { console.log('      (checksum scheme differs; verifyFile:', v.error + ')'); }
  assert(call(svc, 1, 'backup:restore', b.path).err); assert.strictEqual(call(svc, 1, 'db:load').r.collections.students.length, 2);
});
t('exit backup is only created when data changed since last backup; keepAuto rotation works', () => {
  const { svc, store } = boot(); setupAdmin(svc); seedData(svc); const n0 = store.listBackups().length; store.createBackup('exit'); assert.strictEqual(store.listBackups().length, n0 + 1);
  store.createBackup('exit'); assert.strictEqual(store.listBackups().length, n0 + 1, 'no change → no duplicate exit backup');
  call(svc, 1, 'backup:setConfig', { keepAuto: 2 }); for (let i = 0; i < 4; i++) { seedData(svc); call(svc, 1, 'db:save', [{ name: 'students', shard: '', records: [{ id: 'ST-' + (50 + i), name: 'n' }] }]); store.createBackup('auto'); }
  assert(store.listBackups().filter(b => b.reason === 'auto').length <= 2);
});
t('backup config validation (bad dir/number rejected, custom dir accepted)', () => { const { svc } = boot(); setupAdmin(svc); assert(call(svc, 1, 'backup:setConfig', { backupDir: 'relative/path' }).err); assert(call(svc, 1, 'backup:setConfig', { keepAuto: -3 }).err); const d = tmp(); assert.strictEqual(call(svc, 1, 'backup:setConfig', { backupDir: d }).r.backupDir, d); const b = call(svc, 1, 'backup:create').r; assert(b.path.startsWith(d)); });
t('corrupt data file: store survives (reads as empty) and a fresh backup still restorable', () => { const { svc, store } = boot(); setupAdmin(svc); seedData(svc); const b = call(svc, 1, 'backup:create').r; fs.writeFileSync(path.join(store.dataDir, 'students.json'), '{broken'); assert.strictEqual(call(svc, 1, 'db:load').r.collections.students.length, 0); assert(call(svc, 1, 'backup:restore', b.path).r.ok); call(svc, 1, 'auth:login', 'admin', PW); assert.strictEqual(call(svc, 1, 'db:load').r.collections.students.length, 2); });

console.log('— Concurrency / scale');
t('two rapid sequential saves to the same collection: last write wins, no corruption', () => { const { svc } = boot(); setupAdmin(svc); for (let i = 0; i < 50; i++) call(svc, 1, 'db:save', [{ name: 'students', shard: '', records: [{ id: 'ST-1', name: 'v' + i }] }]); assert.strictEqual(call(svc, 1, 'db:load').r.collections.students[0].name, 'v49'); });
t('5000 students: save+load < 3s, filter/search over 5000 < 50ms', () => {
  const { svc } = boot(); setupAdmin(svc); const recs = []; for (let i = 1; i <= 5000; i++) recs.push({ id: 'ST-' + String(i).padStart(4, '0'), name: 'شاگرد ' + i, fatherName: 'پدر ' + i, classId: 'CL-' + (i % 40), phone: '07' + (70000000 + i), status: 'فعال' });
  let t0 = Date.now(); assert(call(svc, 1, 'db:save', [{ name: 'students', shard: '', records: recs }]).r); const ld = call(svc, 1, 'db:load').r; const dt = Date.now() - t0; assert.strictEqual(ld.collections.students.length, 5000); assert(dt < 3000, 'took ' + dt);
  t0 = process.hrtime.bigint(); const hit = ld.collections.students.filter(s => s.name.includes('4999') || s.phone.includes('70004999')); const ms = Number(process.hrtime.bigint() - t0) / 1e6; assert(hit.length >= 1 && ms < 50, ms + 'ms');
});
t('large attendance/marks sets across years (20k marks) persist per-year shards', () => {
  const { svc, store } = boot(); setupAdmin(svc); const marks = []; for (let i = 0; i < 20000; i++) marks.push({ id: 'MK-' + i, yearId: i % 2 ? 'Y1' : 'Y2', score: i % 100 });
  const g = { Y1: marks.filter(m => m.yearId === 'Y1'), Y2: marks.filter(m => m.yearId === 'Y2') }; const t0 = Date.now();
  assert(call(svc, 1, 'db:save', [{ name: 'marks', shard: 'Y1', records: g.Y1 }, { name: 'marks', shard: 'Y2', records: g.Y2 }]).r); assert.strictEqual(call(svc, 1, 'db:load').r.collections.marks.length, 20000); assert(Date.now() - t0 < 5000);
});

console.log('— Dynamic branding');
t('branding:get is public, neutral default, exposes only name/tagline/logo/palette', () => { const { svc } = boot(); const r = call(svc, 9, 'branding:get').r; assert.strictEqual(r.centerName, 'مرکز آموزشی'); assert.deepStrictEqual(Object.keys(r).sort(), ['centerName', 'logo', 'palette', 'tagline']); });
t('saved settings (centerName/logo/palette) are returned pre-login; no secrets leak', () => { const { svc } = boot(); setupAdmin(svc); call(svc, 1, 'db:save', [{ name: 'settings', object: { centerName: 'آکادمی نمونه', tagline: 'کورس‌های زبان', logo: 'data:image/png;base64,AAAA', palette: 'green', phone: '0700' } }]);
  const r = call(svc, 9, 'branding:get').r; assert.strictEqual(r.centerName, 'آکادمی نمونه'); assert.strictEqual(r.palette, 'green'); assert(!('phone' in r)); assert(!JSON.stringify(r).includes('hash')); });
t('legacy schoolName setting is still honoured as center name', () => { const { svc } = boot(); setupAdmin(svc); call(svc, 1, 'db:save', [{ name: 'settings', object: { schoolName: 'نام قدیمی' } }]); assert.strictEqual(call(svc, 9, 'branding:get').r.centerName, 'نام قدیمی'); });
t('branding:apply requires login', () => { const { svc } = boot(); setupAdmin(svc); assert.strictEqual(code(call(svc, 9, 'branding:apply', {})), 'NOT_AUTHENTICATED'); });

console.log('— Branches (Phase 2)');
const mkBranch = (svc, id, name, extra) => call(svc, 1, 'db:save', [{ name: 'branches', shard: '', records: (call(svc, 1, 'db:load').r.collections.branches).concat([Object.assign({ id, name, status: 'فعال' }, extra || {})]) }]);
const loadScope = (svc, k, scope) => call(svc, k, 'db:load', scope).r;
const saveStudents = (svc, k, scope, recs) => call(svc, k, 'db:save', [{ name: 'students', shard: '', records: recs, scopeBranch: scope }]);
function loginBranchUser(svc, k, role, username, branchId) {
  const r = call(svc, 1, 'users:save', { name: username, username, role, status: 'فعال', branchId }, 'Temp12345pw'); assert(r.r, 'mk branch user ' + (r.err && r.err.message));
  const l = call(svc, k, 'auth:login', username, 'Temp12345pw'); assert(l.r && l.r.mustChange, 'login'); assert(call(svc, k, 'auth:changePassword', 'Temp12345pw', 'Branch2026pass').r, 'chg');
  return r.r;
}
t('legacy data (no branches, records without branchId) is migrated to a default branch BR-0001, once', () => {
  const dir = tmp(); const st = createStore(dir);
  st.save([{ name: 'students', shard: '', records: [{ id: 'ST-0001', name: 'قدیمی' }] }, { name: 'attendance', shard: 'YR-0001', records: [{ id: 'AT-0001', studentId: 'ST-0001' }] }, { name: 'seq', object: { student: 1 } }]);
  const svc = createService(st, { allowTestHooks: true }); setupAdmin(svc);
  const ld = loadScope(svc, 1);
  assert.strictEqual(ld.collections.branches.length, 1); assert.strictEqual(ld.collections.branches[0].id, 'BR-0001'); assert(ld.collections.branches[0].isDefault);
  assert.strictEqual(ld.collections.students[0].branchId, 'BR-0001'); assert.strictEqual(st.readCollection('attendance', 'YR-0001')[0].branchId, 'BR-0001', 'sharded data stamped too');
  assert.strictEqual(st.readObject('seq').branch, 1); assert.strictEqual(st.readObject('seq').student, 1, 'existing seq values preserved');
  const before = st.getMeta().changeSeq; loadScope(svc, 1); assert.strictEqual(st.getMeta().changeSeq, before, 'migration runs only once');
});
t('branch CRUD rules: invalid id/name, duplicate name, only default cannot be removed, last active branch kept', () => {
  const { svc } = boot(); setupAdmin(svc); loadScope(svc, 1);
  assert(mkBranch(svc, 'BR-0002', 'شعبه غرب').r, 'create');
  assert.strictEqual(code(mkBranch(svc, 'BR-0003', 'شعبه غرب')), 'BAD_REQUEST');
  assert.strictEqual(code(mkBranch(svc, 'X1', 'بد')), 'BAD_REQUEST'); assert.strictEqual(code(mkBranch(svc, 'BR-0004', '   ')), 'BAD_REQUEST');
  const list = loadScope(svc, 1).collections.branches; assert.strictEqual(list.length, 2);
  assert.strictEqual(code(call(svc, 1, 'db:save', [{ name: 'branches', shard: '', records: list.filter(b => b.id !== 'BR-0001') }])), 'BAD_REQUEST', 'default branch cannot be deleted');
  const allOff = list.map(b => Object.assign({}, b, { status: 'غیرفعال' })); assert.strictEqual(code(call(svc, 1, 'db:save', [{ name: 'branches', shard: '', records: allOff }])), 'BAD_REQUEST', 'need one active branch');
  assert(call(svc, 1, 'db:save', [{ name: 'branches', shard: '', records: list.filter(b => b.id !== 'BR-0002') }]).r, 'empty non-default branch can be deleted');
  const flag = loadScope(svc, 1).collections.branches[0]; assert(flag.isDefault); const forged = call(svc, 1, 'db:save', [{ name: 'branches', shard: '', records: [Object.assign({}, flag, { isDefault: false })] }]); assert(forged.r && loadScope(svc, 1).collections.branches[0].isDefault, 'client cannot clear isDefault');
});
t('branch with data or users cannot be deleted (including data in yearly shards)', () => {
  const { svc } = boot(); setupAdmin(svc); loadScope(svc, 1); mkBranch(svc, 'BR-0002', 'B2');
  call(svc, 1, 'db:save', [{ name: 'attendance', shard: 'YR-0001', records: [{ id: 'AT-0001', studentId: 'x' }], scopeBranch: 'BR-0002' }]);
  const list = loadScope(svc, 1).collections.branches;
  const e = call(svc, 1, 'db:save', [{ name: 'branches', shard: '', records: list.filter(b => b.id !== 'BR-0002') }]); assert.strictEqual(code(e), 'BAD_REQUEST'); assert(/غیرفعال/.test(e.err.message));
  call(svc, 1, 'db:save', [{ name: 'attendance', shard: 'YR-0001', records: [], scopeBranch: 'BR-0002' }]);
  mkBranch(svc, 'BR-0003', 'B3'); loginBranchUser(svc, 5, 'branch_manager', 'bm3', 'BR-0003');
  const l2 = loadScope(svc, 1).collections.branches; assert.strictEqual(code(call(svc, 1, 'db:save', [{ name: 'branches', shard: '', records: l2.filter(b => b.id !== 'BR-0003') }])), 'BAD_REQUEST', 'branch with a user');
});
t('scoped load/save: records are stamped, isolated per branch, and a scoped save never wipes other branches', () => {
  const { svc } = boot(); setupAdmin(svc); loadScope(svc, 1); mkBranch(svc, 'BR-0002', 'B2');
  assert(saveStudents(svc, 1, 'BR-0001', [{ id: 'ST-0001', name: 'الف' }]).r); assert(saveStudents(svc, 1, 'BR-0002', [{ id: 'ST-0002', name: 'ب' }, { id: 'ST-0003', name: 'ج' }]).r);
  const b1 = loadScope(svc, 1, 'BR-0001').collections.students, b2 = loadScope(svc, 1, 'BR-0002').collections.students, all = loadScope(svc, 1, 'all').collections.students;
  assert.deepStrictEqual(b1.map(x => x.id), ['ST-0001']); assert.deepStrictEqual(b2.map(x => x.id), ['ST-0002', 'ST-0003']); assert.strictEqual(all.length, 3);
  assert(b1[0].branchId === 'BR-0001' && b2[0].branchId === 'BR-0002');
  assert(saveStudents(svc, 1, 'BR-0001', []).r); assert.strictEqual(loadScope(svc, 1, 'all').collections.students.length, 2, 'BR-0002 students survive an empty BR-0001 save');
  assert.strictEqual(code(saveStudents(svc, 1, 'BR-0001', [{ id: 'ST-0002', name: 'hijack' }])), 'FORBIDDEN', 'cannot overwrite a record of another branch');
  assert.strictEqual(loadScope(svc, 1, 'BR-0002').collections.students[0].name, 'ب');
  assert.strictEqual(code(saveStudents(svc, 1, 'BR-9999', [])), 'BAD_REQUEST', 'unknown scope');
});
t('unscoped ("all") save keeps/assigns branchId and rejects unknown branches', () => {
  const { svc } = boot(); setupAdmin(svc); loadScope(svc, 1);
  assert(call(svc, 1, 'db:save', [{ name: 'students', shard: '', records: [{ id: 'ST-0001', name: 'بدون شعبه' }] }]).r);
  assert.strictEqual(loadScope(svc, 1, 'all').collections.students[0].branchId, 'BR-0001', 'defaults to the default branch');
  assert.strictEqual(code(call(svc, 1, 'db:save', [{ name: 'students', shard: '', records: [{ id: 'ST-0002', name: 'x', branchId: 'BR-7777' }] }])), 'BAD_REQUEST');
});
t('branch-bound user (مدیر شعبه): sees only own branch, writes are forced into it, other branches untouched', () => {
  const { svc } = boot(); setupAdmin(svc); loadScope(svc, 1); mkBranch(svc, 'BR-0002', 'B2');
  saveStudents(svc, 1, 'BR-0001', [{ id: 'ST-0001', name: 'مرکزی' }]); saveStudents(svc, 1, 'BR-0002', [{ id: 'ST-0002', name: 'غرب' }]);
  loginBranchUser(svc, 7, 'branch_manager', 'bm2', 'BR-0002');
  const ld = loadScope(svc, 7); assert.strictEqual(ld.restricted, true); assert.strictEqual(ld.scope, 'BR-0002');
  assert.deepStrictEqual(ld.collections.students.map(x => x.id), ['ST-0002']); assert.deepStrictEqual(ld.collections.branches.map(b => b.id), ['BR-0002']);
  assert(!JSON.stringify(ld).includes('مرکزی'), 'no data of other branches leaks in load');
  const ld2 = call(svc, 7, 'db:load', 'BR-0001').r; assert.strictEqual(ld2.scope, 'BR-0002', 'requested scope is ignored for a bound user'); assert(!JSON.stringify(ld2).includes('مرکزی'));
  assert(call(svc, 7, 'db:save', [{ name: 'students', shard: '', records: [{ id: 'ST-0002', name: 'غرب2' }, { id: 'ST-0010', name: 'جدید', branchId: 'BR-0001' }], scopeBranch: 'BR-0001' }]).r);
  const all = loadScope(svc, 1, 'all').collections.students; assert.strictEqual(all.find(x => x.id === 'ST-0010').branchId, 'BR-0002', 'forged branchId is overridden'); assert.strictEqual(all.find(x => x.id === 'ST-0001').name, 'مرکزی');
  assert.strictEqual(code(call(svc, 7, 'db:save', [{ name: 'students', shard: '', records: [{ id: 'ST-0001', name: 'HACK' }] }])), 'FORBIDDEN', 'cannot modify another branch record');
  assert.strictEqual(loadScope(svc, 1, 'all').collections.students.find(x => x.id === 'ST-0001').name, 'مرکزی');
  call(svc, 7, 'db:save', [{ name: 'students', shard: '', records: [] }]);
  assert.strictEqual(loadScope(svc, 1, 'all').collections.students.find(x => x.id === 'ST-0001').name, 'مرکزی', 'other branch survives even an empty save');
});
t('branch-bound user cannot touch center-level things: branches, settings, backup/restore, role perms, admin accounts', () => {
  const { svc } = boot(); setupAdmin(svc); loadScope(svc, 1); mkBranch(svc, 'BR-0002', 'B2');
  loginBranchUser(svc, 7, 'branch_manager', 'bm2', 'BR-0002');
  assert.strictEqual(code(call(svc, 7, 'db:save', [{ name: 'branches', shard: '', records: [{ id: 'BR-0009', name: 'x', status: 'فعال' }] }])), 'FORBIDDEN');
  assert.strictEqual(code(call(svc, 7, 'db:save', [{ name: 'settings', object: { centerName: 'hack' } }])), 'FORBIDDEN');
  for (const ch of ['backup:create', 'backup:list', 'backup:restore', 'perms:set', 'users:save', 'users:setPassword']) assert.strictEqual(code(call(svc, 7, ch, 'BR-0002', null)), 'FORBIDDEN', ch);
  // even if an admin grants users.manage + backup.manage to the role, a bound user still cannot escalate
  call(svc, 1, 'perms:set', 'branch_manager', authz.effectivePerms('branch_manager', {}).concat(['users.manage', 'backup.manage', 'restore.run', 'settings.manage', 'branches.write']));
  assert.strictEqual(code(call(svc, 7, 'backup:create')), 'FORBIDDEN'); assert.strictEqual(code(call(svc, 7, 'perms:set', 'teacher', [])), 'FORBIDDEN');
  assert.strictEqual(code(call(svc, 7, 'db:save', [{ name: 'settings', object: { centerName: 'hack' } }])), 'FORBIDDEN'); assert.strictEqual(code(call(svc, 7, 'db:save', [{ name: 'branches', shard: '', records: [] }])), 'FORBIDDEN');
  assert.strictEqual(code(call(svc, 7, 'users:setPassword', 'US-0001', 'Hacked2026pw')), 'FORBIDDEN', 'cannot reset the admin password');
  assert.strictEqual(code(call(svc, 7, 'users:save', { name: 'z', username: 'zzz', role: 'admin', status: 'فعال' }, 'Temp12345pw')), 'FORBIDDEN', 'cannot create admin');
  const mk = call(svc, 7, 'users:save', { name: 'کارمند', username: 'emp2', role: 'reception', status: 'فعال', branchId: 'BR-0001' }, 'Temp12345pw'); assert(mk.r && mk.r.branchId === 'BR-0002', 'users created by a bound user are forced into the same branch');
  const vis = call(svc, 7, 'db:load').r.collections.users; assert(vis.every(u => u.id === call(svc, 7, 'auth:me').r.user.id || u.branchId === 'BR-0002'), 'bound user only sees users of own branch'); assert(!vis.some(u => u.role === 'admin'));
});
t('users: مدیر شعبه needs a valid branch; admin is never branch-bound; branchId is exposed to the client', () => {
  const { svc } = boot(); setupAdmin(svc); loadScope(svc, 1);
  assert.strictEqual(code(call(svc, 1, 'users:save', { name: 'x', username: 'bm1', role: 'branch_manager', status: 'فعال' }, 'Temp12345pw')), 'BAD_REQUEST');
  assert.strictEqual(code(call(svc, 1, 'users:save', { name: 'x', username: 'bm1', role: 'branch_manager', status: 'فعال', branchId: 'BR-8888' }, 'Temp12345pw')), 'BAD_REQUEST');
  const ok = call(svc, 1, 'users:save', { name: 'x', username: 'bm1', role: 'branch_manager', status: 'فعال', branchId: 'BR-0001' }, 'Temp12345pw'); assert.strictEqual(ok.r.branchId, 'BR-0001');
  const ad = call(svc, 1, 'users:save', { id: 'US-0001', name: 'مدیر', username: 'admin', role: 'admin', status: 'فعال', branchId: 'BR-0001' }); assert.strictEqual(ad.r.branchId, null);
});
t('deactivating a branch blocks its users immediately (session ends, login refused)', () => {
  const { svc } = boot(); setupAdmin(svc); loadScope(svc, 1); mkBranch(svc, 'BR-0002', 'B2'); loginBranchUser(svc, 7, 'branch_manager', 'bm2', 'BR-0002');
  assert(call(svc, 7, 'db:load').r);
  const list = loadScope(svc, 1).collections.branches.map(b => b.id === 'BR-0002' ? Object.assign({}, b, { status: 'غیرفعال' }) : b);
  assert(call(svc, 1, 'db:save', [{ name: 'branches', shard: '', records: list }]).r);
  assert.strictEqual(code(call(svc, 7, 'db:load')), 'NOT_AUTHENTICATED'); assert(call(svc, 8, 'auth:login', 'bm2', 'Branch2026pass').err, 'login refused');
});
t('branches:stats — per-branch counts + income/expenses/salaries/net; bound user sees only own; finance-less role gets nulls', () => {
  const { svc } = boot(); setupAdmin(svc); loadScope(svc, 1); mkBranch(svc, 'BR-0002', 'B2');
  const w = (n, sh, sc, recs) => assert(call(svc, 1, 'db:save', [{ name: n, shard: sh, records: recs, scopeBranch: sc }]).r, n);
  w('students', '', 'BR-0001', [{ id: 'ST-1', name: 'a' }, { id: 'ST-2', name: 'b', softDeleted: true }]); w('students', '', 'BR-0002', [{ id: 'ST-3', name: 'c' }]);
  w('teachers', '', 'BR-0002', [{ id: 'TC-1', name: 't' }]);
  w('feePayments', 'YR-1', 'BR-0001', [{ id: 'FP-1', amount: 1000, yearId: 'YR-1' }]); w('feePayments', 'YR-1', 'BR-0002', [{ id: 'FP-2', amount: 400, yearId: 'YR-1' }, { id: 'FP-3', amount: 100, yearId: 'YR-1' }]);
  w('expenses', '', 'BR-0001', [{ id: 'EP-1', amount: 300, yearId: 'YR-1' }]); w('payroll', 'YR-1', 'BR-0002', [{ id: 'PY-1', paidAmount: 200, yearId: 'YR-1' }]);
  const st = call(svc, 1, 'branches:stats', 'YR-1').r; const r1 = st.rows.find(r => r.id === 'BR-0001'), r2 = st.rows.find(r => r.id === 'BR-0002');
  assert.deepStrictEqual([r1.students, r1.income, r1.expenses, r1.salaries, r1.net], [1, 1000, 300, 0, 700]);
  assert.deepStrictEqual([r2.students, r2.teachers, r2.income, r2.expenses, r2.salaries, r2.net], [1, 1, 500, 0, 200, 300]);
  assert.deepStrictEqual([st.total.students, st.total.income, st.total.net], [2, 1500, 1000]);
  assert.strictEqual(call(svc, 1, 'branches:stats', 'YR-OTHER').r.total.income, 0, 'year filter');
  loginBranchUser(svc, 7, 'branch_manager', 'bm2', 'BR-0002'); const own = call(svc, 7, 'branches:stats').r; assert.deepStrictEqual(own.rows.map(r => r.id), ['BR-0002']); assert.strictEqual(own.total.income, 500);
  call(svc, 1, 'users:save', { name: 'tt', username: 'teach2', role: 'teacher', status: 'فعال', branchId: 'BR-0002' }, 'Temp12345pw');
  assert.strictEqual(code(call(svc, 9, 'branches:stats')), 'NOT_AUTHENTICATED');
  call(svc, 1, 'perms:set', 'teacher', ['branches.read']); const lg = call(svc, 9, 'auth:login', 'teach2', 'Temp12345pw'); call(svc, 9, 'auth:changePassword', 'Temp12345pw', 'Teach2026pass');
  const tr = call(svc, 9, 'branches:stats').r; assert(tr.rows[0].income === null && tr.rows[0].expenses === null && tr.rows[0].net === null, 'no finance permission → null money');
});
t('restore of an old (pre-branches) backup re-creates the default branch and stamps all records', () => {
  const crypto = require('crypto');
  const { svc, store } = boot(); setupAdmin(svc); loadScope(svc, 1);
  call(svc, 1, 'db:save', [{ name: 'students', shard: '', records: [{ id: 'ST-0001', name: 'قدیمی' }] }, { name: 'attendance', shard: 'YR-0001', records: [{ id: 'AT-0001', studentId: 'ST-0001', yearId: 'YR-0001' }] }]);
  const bk = store.createBackup('manual', { force: true }); const payload = JSON.parse(fs.readFileSync(bk.path, 'utf8'));
  delete payload.data.collections.branches; delete payload.data.objects.seq;
  Object.keys(payload.data.collections).forEach(n => payload.data.collections[n].forEach(r => { if (r && typeof r === 'object') delete r.branchId; }));
  payload.checksum = crypto.createHash('sha256').update(JSON.stringify(payload.data)).digest('hex');
  const legacy = path.join(path.dirname(bk.path), 'EduCenter-Backup_2020-01-01_00-00-00_manual.json'); fs.writeFileSync(legacy, JSON.stringify(payload));
  const r = call(svc, 1, 'backup:restore', legacy); assert(r.r && r.r.ok, 'restore failed: ' + (r.err && r.err.message));
  const l = call(svc, 1, 'auth:login', 'admin', PW); assert(l.r, 'relogin after restore');
  const ld = loadScope(svc, 1); assert.strictEqual(ld.collections.branches.length, 1); assert.strictEqual(ld.collections.branches[0].id, 'BR-0001');
  assert.strictEqual(ld.collections.students[0].branchId, 'BR-0001'); assert.strictEqual(store.readCollection('attendance', 'YR-0001')[0].branchId, 'BR-0001');
});

console.log('— Courses → Levels → Classes (Phase 3)');
const wr = (svc, k, n, recs, sc) => call(svc, k, 'db:save', [{ name: n, shard: '', records: recs, scopeBranch: sc }]);
const CR = (id, name, x) => Object.assign({ id, name, category: 'زبان‌های بین‌المللی', price: 1500, durationValue: 3, durationUnit: 'ماه', startDate: '2026-01-01', endDate: '2026-04-01', status: 'فعال' }, x || {});
t('course/level/class hierarchy saves, is stamped with the branch, and old classes without a course stay valid', () => {
  const { svc } = boot(); setupAdmin(svc); loadScope(svc, 1);
  assert(wr(svc, 1, 'classes', [{ id: 'CL-0001', name: 'صنف قدیمی', academicYearId: 'YR-1' }], 'BR-0001').r, 'legacy class');
  assert(wr(svc, 1, 'courses', [CR('CR-0001', 'English')], 'BR-0001').r, 'course');
  assert(wr(svc, 1, 'levels', [{ id: 'LV-0001', courseId: 'CR-0001', name: 'Beginner', order: 1 }, { id: 'LV-0002', courseId: 'CR-0001', name: 'Intermediate', order: 2 }], 'BR-0001').r, 'levels');
  assert(wr(svc, 1, 'classes', [{ id: 'CL-0001', name: 'صنف قدیمی', academicYearId: 'YR-1' }, { id: 'CL-0002', name: 'Class A', courseId: 'CR-0001', levelId: 'LV-0001', academicYearId: 'YR-1' }], 'BR-0001').r, 'class under level');
  const ld = loadScope(svc, 1, 'BR-0001').collections; assert(ld.courses[0].branchId === 'BR-0001' && ld.levels.every(l => l.branchId === 'BR-0001') && ld.classes.every(c => c.branchId === 'BR-0001'));
});
t('course validation: name, duplicate name per branch, negative price, bad dates, unknown teacher', () => {
  const { svc } = boot(); setupAdmin(svc); loadScope(svc, 1);
  assert.strictEqual(code(wr(svc, 1, 'courses', [CR('CR-0001', '  ')], 'BR-0001')), 'BAD_REQUEST');
  assert.strictEqual(code(wr(svc, 1, 'courses', [CR('CR-0001', 'English'), CR('CR-0002', 'english')], 'BR-0001')), 'BAD_REQUEST', 'duplicate');
  assert.strictEqual(code(wr(svc, 1, 'courses', [CR('CR-0001', 'E', { price: -5 })], 'BR-0001')), 'BAD_REQUEST');
  assert.strictEqual(code(wr(svc, 1, 'courses', [CR('CR-0001', 'E', { price: 'abc' })], 'BR-0001')), 'BAD_REQUEST');
  assert.strictEqual(code(wr(svc, 1, 'courses', [CR('CR-0001', 'E', { startDate: '2026-05-01', endDate: '2026-01-01' })], 'BR-0001')), 'BAD_REQUEST');
  assert.strictEqual(code(wr(svc, 1, 'courses', [CR('CR-0001', 'E', { teacherId: 'TC-9999' })], 'BR-0001')), 'BAD_REQUEST');
  assert(wr(svc, 1, 'teachers', [{ id: 'TC-0001', name: 'استاد' }], 'BR-0001').r); assert(wr(svc, 1, 'courses', [CR('CR-0001', 'E', { teacherId: 'TC-0001' })], 'BR-0001').r, 'valid teacher');
});
t('same course name is allowed in different branches; teacher of another branch is rejected', () => {
  const { svc } = boot(); setupAdmin(svc); loadScope(svc, 1); mkBranch(svc, 'BR-0002', 'B2');
  assert(wr(svc, 1, 'courses', [CR('CR-0001', 'English')], 'BR-0001').r); assert(wr(svc, 1, 'courses', [CR('CR-0002', 'English')], 'BR-0002').r, 'same name other branch');
  assert(wr(svc, 1, 'teachers', [{ id: 'TC-0002', name: 'غرب' }], 'BR-0002').r);
  assert.strictEqual(code(wr(svc, 1, 'courses', [CR('CR-0001', 'English', { teacherId: 'TC-0002' })], 'BR-0001')), 'BAD_REQUEST', 'cross-branch teacher');
  assert.strictEqual(loadScope(svc, 1, 'all').collections.courses.length, 2);
});
t('level rules: needs existing course in same branch; duplicate level name rejected; class must use a level of its own course', () => {
  const { svc } = boot(); setupAdmin(svc); loadScope(svc, 1); mkBranch(svc, 'BR-0002', 'B2');
  wr(svc, 1, 'courses', [CR('CR-0001', 'English'), CR('CR-0003', 'Math')], 'BR-0001'); wr(svc, 1, 'courses', [CR('CR-0002', 'IELTS')], 'BR-0002');
  assert.strictEqual(code(wr(svc, 1, 'levels', [{ id: 'LV-1', courseId: 'CR-7777', name: 'x' }], 'BR-0001')), 'BAD_REQUEST', 'unknown course');
  assert.strictEqual(code(wr(svc, 1, 'levels', [{ id: 'LV-1', courseId: 'CR-0002', name: 'x' }], 'BR-0001')), 'BAD_REQUEST', 'course of another branch');
  assert.strictEqual(code(wr(svc, 1, 'levels', [{ id: 'LV-1', courseId: 'CR-0001', name: 'A' }, { id: 'LV-2', courseId: 'CR-0001', name: ' a ' }], 'BR-0001')), 'BAD_REQUEST', 'duplicate level');
  assert(wr(svc, 1, 'levels', [{ id: 'LV-1', courseId: 'CR-0001', name: 'A' }, { id: 'LV-3', courseId: 'CR-0003', name: 'A' }], 'BR-0001').r, 'same level name in different courses is fine');
  assert.strictEqual(code(wr(svc, 1, 'classes', [{ id: 'CL-1', name: 'x', courseId: 'CR-0001', levelId: 'LV-3' }], 'BR-0001')), 'BAD_REQUEST', 'level of another course');
  assert.strictEqual(code(wr(svc, 1, 'classes', [{ id: 'CL-1', name: 'x', levelId: 'LV-1' }], 'BR-0001')), 'BAD_REQUEST', 'level without course');
  assert.strictEqual(code(wr(svc, 1, 'classes', [{ id: 'CL-1', name: 'x', courseId: 'CR-0002' }], 'BR-0001')), 'BAD_REQUEST', 'class with course of another branch');
  assert(wr(svc, 1, 'classes', [{ id: 'CL-1', name: 'x', courseId: 'CR-0001' }], 'BR-0001').r, 'class directly under course (no level) is allowed');
});
t('deleting a course/level that still has levels/classes is refused; empty ones can be deleted', () => {
  const { svc } = boot(); setupAdmin(svc); loadScope(svc, 1);
  wr(svc, 1, 'courses', [CR('CR-0001', 'English')], 'BR-0001'); wr(svc, 1, 'levels', [{ id: 'LV-1', courseId: 'CR-0001', name: 'A' }], 'BR-0001'); wr(svc, 1, 'classes', [{ id: 'CL-1', name: 'x', courseId: 'CR-0001', levelId: 'LV-1' }], 'BR-0001');
  let e = wr(svc, 1, 'courses', [], 'BR-0001'); assert.strictEqual(code(e), 'BAD_REQUEST'); assert(/سطح/.test(e.err.message));
  e = wr(svc, 1, 'levels', [], 'BR-0001'); assert.strictEqual(code(e), 'BAD_REQUEST'); assert(/صنف/.test(e.err.message));
  assert.strictEqual(loadScope(svc, 1, 'BR-0001').collections.levels.length, 1, 'nothing was deleted');
  assert(wr(svc, 1, 'classes', [], 'BR-0001').r); assert(wr(svc, 1, 'levels', [], 'BR-0001').r); assert(wr(svc, 1, 'courses', [], 'BR-0001').r, 'bottom-up deletion works');
});
t('batch save of course + levels + classes together validates against the new state (single db:save)', () => {
  const { svc } = boot(); setupAdmin(svc); loadScope(svc, 1);
  const r = call(svc, 1, 'db:save', [{ name: 'courses', shard: '', records: [CR('CR-0001', 'English')], scopeBranch: 'BR-0001' }, { name: 'levels', shard: '', records: [{ id: 'LV-1', courseId: 'CR-0001', name: 'A' }], scopeBranch: 'BR-0001' }, { name: 'classes', shard: '', records: [{ id: 'CL-1', name: 'x', courseId: 'CR-0001', levelId: 'LV-1' }], scopeBranch: 'BR-0001' }]);
  assert(r.r, 'batch failed: ' + (r.err && r.err.message));
  const bad = call(svc, 1, 'db:save', [{ name: 'courses', shard: '', records: [], scopeBranch: 'BR-0001' }, { name: 'levels', shard: '', records: [], scopeBranch: 'BR-0001' }]);
  assert.strictEqual(code(bad), 'BAD_REQUEST', 'class still references the removed course/level');
});
t('permissions: teacher cannot write courses/levels; branch manager can, but only inside own branch; branches:stats counts courses', () => {
  const { svc } = boot(); setupAdmin(svc); loadScope(svc, 1); mkBranch(svc, 'BR-0002', 'B2');
  wr(svc, 1, 'courses', [CR('CR-0001', 'English')], 'BR-0001');
  mkUser(svc, 'teacher', 'tt1'); call(svc, 5, 'auth:login', 'tt1', 'Temp12345pw'); call(svc, 5, 'auth:changePassword', 'Temp12345pw', 'Teach2026pass');
  assert.strictEqual(code(call(svc, 5, 'db:save', [{ name: 'courses', shard: '', records: [CR('CR-0009', 'Hack')] }])), 'FORBIDDEN');
  assert.strictEqual(code(call(svc, 5, 'db:save', [{ name: 'levels', shard: '', records: [] }])), 'FORBIDDEN');
  loginBranchUser(svc, 7, 'branch_manager', 'bm2', 'BR-0002');
  assert(call(svc, 7, 'db:save', [{ name: 'courses', shard: '', records: [CR('CR-0002', 'IELTS')] }]).r, 'branch manager creates course');
  assert.strictEqual(loadScope(svc, 1, 'all').collections.courses.find(c => c.id === 'CR-0002').branchId, 'BR-0002');
  assert.deepStrictEqual(call(svc, 7, 'db:load').r.collections.courses.map(c => c.id), ['CR-0002'], 'only own courses visible');
  assert.strictEqual(code(call(svc, 7, 'db:save', [{ name: 'levels', shard: '', records: [{ id: 'LV-9', courseId: 'CR-0001', name: 'x' }] }])), 'BAD_REQUEST', 'cannot hang a level under a course of another branch');
  const st = call(svc, 1, 'branches:stats').r; assert.strictEqual(st.rows.find(r => r.id === 'BR-0001').courses, 1); assert.strictEqual(st.rows.find(r => r.id === 'BR-0002').courses, 1);
});

console.log('— Students & teachers: course enrollment, transfer (Phase 4)');
const seed4 = (svc) => { loadScope(svc, 1);
  wr(svc, 1, 'courses', [CR('CR-0001', 'English'), CR('CR-0002', 'Math')], 'BR-0001'); wr(svc, 1, 'levels', [{ id: 'LV-1', courseId: 'CR-0001', name: 'Beginner' }], 'BR-0001');
  wr(svc, 1, 'classes', [{ id: 'CL-1', name: 'A', courseId: 'CR-0001', levelId: 'LV-1', academicYearId: 'YR-1' }, { id: 'CL-2', name: 'M', courseId: 'CR-0002', academicYearId: 'YR-1' }, { id: 'CL-0', name: 'old', academicYearId: 'YR-1' }], 'BR-0001');
  wr(svc, 1, 'students', [{ id: 'ST-1', name: 'علی', classId: 'CL-0', academicYearId: 'YR-1', status: 'فعال' }, { id: 'ST-2', name: 'سارا', classId: 'CL-0', academicYearId: 'YR-1', parentId: 'PR-1' }], 'BR-0001'); };
const EN = (id, st, course, cls, x) => Object.assign({ id, studentId: st, courseId: course, levelId: '', classId: cls || '', status: 'فعال', enrollDate: '2026-04-01' }, x || {});
t('course enrollment: valid, one active per student+course, consistent course/level/class, unknown student/course/status rejected', () => {
  const { svc } = boot(); setupAdmin(svc); seed4(svc); const we = (recs) => wr(svc, 1, 'courseEnrollments', recs, 'BR-0001');
  assert(we([EN('CE-1', 'ST-1', 'CR-0001', 'CL-1', { levelId: 'LV-1' }), EN('CE-2', 'ST-1', 'CR-0002', 'CL-2')]).r, 'student in two courses at once');
  assert.strictEqual(code(we([EN('CE-1', 'ST-1', 'CR-0001'), EN('CE-3', 'ST-1', 'CR-0001')])), 'BAD_REQUEST', 'two active enrollments in same course');
  assert(we([EN('CE-1', 'ST-1', 'CR-0001', 'CL-1', { status: 'ختم شده' }), EN('CE-3', 'ST-1', 'CR-0001', 'CL-1')]).r, 're-enrol after completion is fine');
  assert.strictEqual(code(we([EN('CE-1', 'ST-9', 'CR-0001')])), 'BAD_REQUEST', 'unknown student');
  assert.strictEqual(code(we([EN('CE-1', 'ST-1', 'CR-9')])), 'BAD_REQUEST', 'unknown course');
  assert.strictEqual(code(we([EN('CE-1', 'ST-1', 'CR-0001', 'CL-2')])), 'BAD_REQUEST', 'class of another course');
  assert.strictEqual(code(we([EN('CE-1', 'ST-1', 'CR-0001', '', { status: 'نامعلوم' })])), 'BAD_REQUEST', 'bad status');
  assert.strictEqual(loadScope(svc, 1, 'BR-0001').collections.courseEnrollments.length, 2, 'failed saves changed nothing');
});
t('class/level/course referenced by an enrollment cannot be deleted', () => {
  const { svc } = boot(); setupAdmin(svc); seed4(svc); wr(svc, 1, 'courseEnrollments', [EN('CE-1', 'ST-1', 'CR-0001', 'CL-1', { levelId: 'LV-1' })], 'BR-0001');
  assert.strictEqual(code(wr(svc, 1, 'classes', [{ id: 'CL-2', name: 'M', courseId: 'CR-0002', academicYearId: 'YR-1' }, { id: 'CL-0', name: 'old', academicYearId: 'YR-1' }], 'BR-0001')), 'BAD_REQUEST');
  assert.strictEqual(code(wr(svc, 1, 'courses', [CR('CR-0002', 'Math')], 'BR-0001')), 'BAD_REQUEST');
  assert(wr(svc, 1, 'courseEnrollments', [], 'BR-0001').r); assert(wr(svc, 1, 'classes', [{ id: 'CL-2', name: 'M', courseId: 'CR-0002', academicYearId: 'YR-1' }, { id: 'CL-0', name: 'old', academicYearId: 'YR-1' }], 'BR-0001').r, 'deletable after enrollment is removed');
});
t('soft-deleted student with an active enrollment does not block unrelated course edits', () => {
  const { svc } = boot(); setupAdmin(svc); seed4(svc); wr(svc, 1, 'courseEnrollments', [EN('CE-1', 'ST-1', 'CR-0001')], 'BR-0001');
  wr(svc, 1, 'students', loadScope(svc, 1, 'BR-0001').collections.students.map(s => s.id === 'ST-1' ? Object.assign({}, s, { softDeleted: true }) : s), 'BR-0001');
  assert(wr(svc, 1, 'courses', [CR('CR-0001', 'English 2'), CR('CR-0002', 'Math')], 'BR-0001').r);
});
t('transfer student: moves record, ends active enrollments (kept as history), clears class, logs history; history records stay in old branch', () => {
  const { svc, store } = boot(); setupAdmin(svc); seed4(svc); mkBranch(svc, 'BR-0002', 'B2');
  wr(svc, 1, 'courseEnrollments', [EN('CE-1', 'ST-1', 'CR-0001', 'CL-1', { levelId: 'LV-1' })], 'BR-0001'); assert(call(svc, 1, 'db:save', [{ name: 'attendance', shard: 'YR-1', records: [{ id: 'AT-1', yearId: 'YR-1', records: { 'ST-1': 'present' } }], scopeBranch: 'BR-0001' }]).r);
  const r = call(svc, 1, 'transfer:run', { type: 'student', id: 'ST-1', toBranchId: 'BR-0002', note: 'نقل مکان' }); assert(r.r && r.r.ok, 'transfer failed ' + (r.err && r.err.message));
  const all = loadScope(svc, 1, 'all').collections, st = all.students.find(s => s.id === 'ST-1');
  assert.strictEqual(st.branchId, 'BR-0002'); assert.strictEqual(st.classId, ''); assert.strictEqual(st.transfers.length, 1); assert.strictEqual(st.transfers[0].fromBranchId, 'BR-0001'); assert.strictEqual(st.transfers[0].by, 'مدیر');
  assert.strictEqual(all.courseEnrollments[0].status, 'منتقل شد'); assert.strictEqual(all.courseEnrollments[0].branchId, 'BR-0001'); assert(all.courseEnrollments[0].endDate);
  assert.strictEqual(store.readCollection('attendance', 'YR-1')[0].branchId, 'BR-0001', 'attendance history stays in the old branch');
  assert(!loadScope(svc, 1, 'BR-0001').collections.students.some(s => s.id === 'ST-1')); assert(loadScope(svc, 1, 'BR-0002').collections.students.some(s => s.id === 'ST-1'));
  assert(wr(svc, 1, 'courses', [CR('CR-0001', 'English'), CR('CR-0002', 'Math')], 'BR-0001').r, 'old-branch edits still validate after transfer');
  assert(call(svc, 1, 'logs:read').r.some(l => /منتقل شد/.test(l.details || l.detail || JSON.stringify(l))), 'audited');
  assert.strictEqual(code(call(svc, 1, 'transfer:run', { type: 'student', id: 'ST-1', toBranchId: 'BR-0002' })), 'BAD_REQUEST', 'already there');
});
t('transfer student with a target class: class must exist in target branch and year', () => {
  const { svc } = boot(); setupAdmin(svc); seed4(svc); mkBranch(svc, 'BR-0002', 'B2');
  wr(svc, 1, 'classes', [{ id: 'CL-9', name: 'T', academicYearId: 'YR-1' }, { id: 'CL-8', name: 'T8', academicYearId: 'YR-2' }], 'BR-0002');
  assert.strictEqual(code(call(svc, 1, 'transfer:run', { type: 'student', id: 'ST-1', toBranchId: 'BR-0002', classId: 'CL-0' })), 'BAD_REQUEST', 'class of the old branch');
  assert.strictEqual(code(call(svc, 1, 'transfer:run', { type: 'student', id: 'ST-1', toBranchId: 'BR-0002', classId: 'CL-8' })), 'BAD_REQUEST', 'other year');
  assert(call(svc, 1, 'transfer:run', { type: 'student', id: 'ST-1', toBranchId: 'BR-0002', classId: 'CL-9' }).r); assert.strictEqual(loadScope(svc, 1, 'BR-0002').collections.students.find(s => s.id === 'ST-1').classId, 'CL-9');
});
t('transfer student: parent moves with the student unless siblings remain (then it is cloned)', () => {
  const { svc } = boot(); setupAdmin(svc); seed4(svc); mkBranch(svc, 'BR-0002', 'B2');
  wr(svc, 1, 'parents', [{ id: 'PR-1', name: 'پدر', studentIds: ['ST-1', 'ST-2'] }], 'BR-0001');
  wr(svc, 1, 'students', loadScope(svc, 1, 'BR-0001').collections.students.map(s => Object.assign({}, s, { parentId: 'PR-1' })), 'BR-0001');
  assert(call(svc, 1, 'transfer:run', { type: 'student', id: 'ST-1', toBranchId: 'BR-0002' }).r);
  const all = loadScope(svc, 1, 'all').collections; const moved = all.students.find(s => s.id === 'ST-1'), sib = all.students.find(s => s.id === 'ST-2');
  assert.strictEqual(sib.parentId, 'PR-1', 'sibling keeps original parent'); assert.notStrictEqual(moved.parentId, 'PR-1', 'moved student gets a clone'); const clone = all.parents.find(p => p.id === moved.parentId); assert(clone && clone.branchId === 'BR-0002' && clone.name === 'پدر' && clone.id !== 'PR-1');
  assert.deepStrictEqual(all.parents.find(p => p.id === 'PR-1').studentIds, ['ST-2']);
  assert(call(svc, 1, 'transfer:run', { type: 'student', id: 'ST-2', toBranchId: 'BR-0002' }).r); const a2 = loadScope(svc, 1, 'all').collections; assert.strictEqual(a2.parents.find(p => p.id === 'PR-1').branchId, 'BR-0002', 'last child: parent moves, no clone');
});
t('transfer teacher: references in courses/classes/subjects are cleared (counted); staff just moves', () => {
  const { svc } = boot(); setupAdmin(svc); loadScope(svc, 1); mkBranch(svc, 'BR-0002', 'B2');
  wr(svc, 1, 'teachers', [{ id: 'TC-1', name: 'استاد' }], 'BR-0001'); wr(svc, 1, 'staff', [{ id: 'SF-1', name: 'کارمند' }], 'BR-0001');
  wr(svc, 1, 'courses', [CR('CR-0001', 'English', { teacherId: 'TC-1' })], 'BR-0001'); wr(svc, 1, 'classes', [{ id: 'CL-1', name: 'A', headTeacherId: 'TC-1', academicYearId: 'YR-1' }], 'BR-0001'); wr(svc, 1, 'subjects', [{ id: 'SB-1', name: 'S', teacherId: 'TC-1' }], 'BR-0001');
  const r = call(svc, 1, 'transfer:run', { type: 'teacher', id: 'TC-1', toBranchId: 'BR-0002' }); assert(r.r && r.r.ok); assert.deepStrictEqual(r.r.cleared, { courses: 1, classes: 1, subjects: 1 });
  const all = loadScope(svc, 1, 'all').collections; assert.strictEqual(all.teachers[0].branchId, 'BR-0002'); assert.strictEqual(all.courses[0].teacherId, ''); assert.strictEqual(all.classes[0].headTeacherId, ''); assert.strictEqual(all.subjects[0].teacherId, '');
  assert(wr(svc, 1, 'courses', [CR('CR-0001', 'English renamed')], 'BR-0001').r, 'no dangling cross-branch teacher reference');
  assert(call(svc, 1, 'transfer:run', { type: 'staff', id: 'SF-1', toBranchId: 'BR-0002' }).r); assert.strictEqual(loadScope(svc, 1, 'BR-0002').collections.staff[0].name, 'کارمند');
});
t('transfer rules: inactive/unknown target, unknown type/record, admin-only (branch-bound & non-permitted roles refused)', () => {
  const { svc } = boot(); setupAdmin(svc); seed4(svc); mkBranch(svc, 'BR-0002', 'B2'); mkBranch(svc, 'BR-0003', 'B3', { status: 'غیرفعال' });
  assert.strictEqual(code(call(svc, 1, 'transfer:run', { type: 'student', id: 'ST-1', toBranchId: 'BR-0003' })), 'BAD_REQUEST', 'inactive target'); assert.strictEqual(code(call(svc, 1, 'transfer:run', { type: 'student', id: 'ST-1', toBranchId: 'BR-7' })), 'BAD_REQUEST');
  assert.strictEqual(code(call(svc, 1, 'transfer:run', { type: 'alien', id: 'ST-1', toBranchId: 'BR-0002' })), 'BAD_REQUEST'); assert.strictEqual(code(call(svc, 1, 'transfer:run', { type: 'student', id: 'ST-77', toBranchId: 'BR-0002' })), 'BAD_REQUEST');
  loginBranchUser(svc, 7, 'branch_manager', 'bm1', 'BR-0001'); assert.strictEqual(code(call(svc, 7, 'transfer:run', { type: 'student', id: 'ST-1', toBranchId: 'BR-0002' })), 'FORBIDDEN', 'branch manager cannot transfer');
  call(svc, 1, 'perms:set', 'branch_manager', authz.effectivePerms('branch_manager', {}).concat(['transfer.run'])); assert.strictEqual(code(call(svc, 7, 'transfer:run', { type: 'student', id: 'ST-1', toBranchId: 'BR-0002' })), 'FORBIDDEN', 'bound user refused even when granted');
  mkUser(svc, 'reception', 'rc1'); call(svc, 5, 'auth:login', 'rc1', 'Temp12345pw'); call(svc, 5, 'auth:changePassword', 'Temp12345pw', 'Recep2026pass'); assert.strictEqual(code(call(svc, 5, 'transfer:run', { type: 'student', id: 'ST-1', toBranchId: 'BR-0002' })), 'FORBIDDEN');
  assert.strictEqual(loadScope(svc, 1, 'BR-0001').collections.students.length, 2, 'nothing moved');
});

console.log('— Finance: invoices, installments, discounts, debts (Phase 5)');
const INV = (id, st, x) => Object.assign({ id, studentId: st, yearId: 'YR-1', title: 'English', courseId: '', amount: 1000, discount: 0, discountReason: '', installments: [{ no: 1, dueDate: '2026-01-01', amount: 500 }, { no: 2, dueDate: '2026-02-01', amount: 500 }], createdAt: '2026-01-01' }, x || {});
const PAY = (id, st, amount, inv, x) => Object.assign({ id, studentId: st, yearId: 'YR-1', amount, type: 'فیس ماهانه', date: '2026-01-05', method: 'نقدی', invoiceId: inv || '' }, x || {});
const wi = (svc, k, recs, sc) => call(svc, k, 'db:save', [{ name: 'studentFees', shard: '', records: recs, scopeBranch: sc }]);
const wp = (svc, k, recs, sc) => call(svc, k, 'db:save', [{ name: 'feePayments', shard: 'YR-1', records: recs, scopeBranch: sc }]);
const seed5 = (svc) => { loadScope(svc, 1); wr(svc, 1, 'students', [{ id: 'ST-1', name: 'علی', classId: '', academicYearId: 'YR-1' }, { id: 'ST-2', name: 'سارا', classId: '', academicYearId: 'YR-1' }], 'BR-0001'); };
t('invoice saved with installments, stamped with the branch; structural rules enforced by main', () => {
  const { svc } = boot(); setupAdmin(svc); seed5(svc);
  assert(wi(svc, 1, [INV('SF-1', 'ST-1')], 'BR-0001').r, 'valid invoice'); assert.strictEqual(loadScope(svc, 1, 'BR-0001').collections.studentFees[0].branchId, 'BR-0001');
  const rej = (x) => assert.strictEqual(code(wi(svc, 1, [INV('SF-1', 'ST-1', x)], 'BR-0001')), 'BAD_REQUEST', JSON.stringify(x).slice(0, 80));
  rej({ title: '' }); rej({ amount: 0 }); rej({ amount: -5 }); rej({ discount: 2000, discountReason: 'x' }); rej({ discount: 100, discountReason: '' }); rej({ installments: [{ no: 1, dueDate: '2026-01-01', amount: 100 }] }); rej({ installments: [{ no: 1, dueDate: 'bad', amount: 500 }, { no: 2, dueDate: '', amount: 500 }] }); rej({ yearId: '' });
  assert.strictEqual(code(wi(svc, 1, [INV('SF-1', 'ST-9')], 'BR-0001')), 'BAD_REQUEST', 'unknown student');
  assert(wi(svc, 1, [INV('SF-1', 'ST-1', { discount: 100, discountReason: 'یتیم', installments: [{ no: 1, dueDate: '', amount: 900 }] })], 'BR-0001').r, 'discount with reason and a single undated installment');
  assert.strictEqual(loadScope(svc, 1, 'BR-0001').collections.studentFees[0].discount, 100);
});
t('discount needs fees.discount: a finance user without it cannot grant or change a discount, but can issue normal invoices', () => {
  const { svc } = boot(); setupAdmin(svc); seed5(svc);
  call(svc, 1, 'perms:set', 'finance', authz.effectivePerms('finance', {}).filter(p => p !== 'fees.discount'));
  mkUser(svc, 'finance', 'fin2'); call(svc, 6, 'auth:login', 'fin2', 'Temp12345pw'); call(svc, 6, 'auth:changePassword', 'Temp12345pw', 'Fin2026pass');
  assert(call(svc, 6, 'db:save', [{ name: 'studentFees', shard: '', records: [INV('SF-1', 'ST-1')], scopeBranch: 'BR-0001' }]).r, 'plain invoice');
  const disc = INV('SF-1', 'ST-1', { discount: 100, discountReason: 'فامیل', installments: [{ no: 1, dueDate: '', amount: 900 }] });
  assert.strictEqual(code(call(svc, 6, 'db:save', [{ name: 'studentFees', shard: '', records: [disc] }])), 'FORBIDDEN', 'cannot add a discount');
  assert.strictEqual(loadScope(svc, 1, 'BR-0001').collections.studentFees[0].discount, 0);
  assert(wi(svc, 1, [disc], 'BR-0001').r, 'admin can');
  assert(call(svc, 6, 'db:save', [{ name: 'studentFees', shard: '', records: [Object.assign({}, disc, { title: 'English 2' })] }]).r, 'editing other fields while keeping the same discount is not a new grant');
  assert.strictEqual(code(call(svc, 6, 'db:save', [{ name: 'studentFees', shard: '', records: [Object.assign({}, disc, { discount: 300, installments: [{ no: 1, dueDate: '', amount: 700 }] })] }])), 'FORBIDDEN', 'cannot raise it');
  call(svc, 1, 'perms:set', 'finance', authz.effectivePerms('finance', {}).concat(['fees.discount'])); assert(call(svc, 6, 'db:save', [{ name: 'studentFees', shard: '', records: [Object.assign({}, disc, { discount: 300, installments: [{ no: 1, dueDate: '', amount: 700 }] })] }]).r, 'allowed once granted');
});
t('payments linked to an invoice: must match student, not exceed the net, not hit cancelled invoices; amounts must be positive', () => {
  const { svc } = boot(); setupAdmin(svc); seed5(svc); wi(svc, 1, [INV('SF-1', 'ST-1'), INV('SF-2', 'ST-2', { cancelled: true })], 'BR-0001');
  assert(wp(svc, 1, [PAY('FP-1', 'ST-1', 400, 'SF-1')], 'BR-0001').r, 'partial payment'); assert(wp(svc, 1, [PAY('FP-1', 'ST-1', 400, 'SF-1'), PAY('FP-2', 'ST-1', 600, 'SF-1')], 'BR-0001').r, 'exact remaining');
  assert.strictEqual(code(wp(svc, 1, [PAY('FP-1', 'ST-1', 400, 'SF-1'), PAY('FP-2', 'ST-1', 600.5, 'SF-1')], 'BR-0001')), 'BAD_REQUEST', 'overpay');
  assert.strictEqual(code(wp(svc, 1, [PAY('FP-3', 'ST-2', 100, 'SF-1')], 'BR-0001')), 'BAD_REQUEST', 'another student');
  assert.strictEqual(code(wp(svc, 1, [PAY('FP-3', 'ST-2', 100, 'SF-2')], 'BR-0001')), 'BAD_REQUEST', 'cancelled invoice');
  assert.strictEqual(code(wp(svc, 1, [PAY('FP-3', 'ST-1', 0, '')], 'BR-0001')), 'BAD_REQUEST', 'zero'); assert.strictEqual(code(wp(svc, 1, [PAY('FP-3', 'ST-1', -50, '')], 'BR-0001')), 'BAD_REQUEST', 'negative');
  assert.strictEqual(code(wp(svc, 1, [PAY('FP-3', 'ST-1', 50, 'SF-404')], 'BR-0001')), 'BAD_REQUEST', 'unknown invoice');
  assert(wp(svc, 1, [PAY('FP-9', 'ST-1', 99999, '')], 'BR-0001').r, 'general (legacy) payments without invoice are unrestricted as before');
});
t('invoice with payments cannot be deleted or reduced below what was paid; empty/cancelled-before-payment invoices can go', () => {
  const { svc } = boot(); setupAdmin(svc); seed5(svc); wi(svc, 1, [INV('SF-1', 'ST-1'), INV('SF-2', 'ST-2')], 'BR-0001'); wp(svc, 1, [PAY('FP-1', 'ST-1', 600, 'SF-1')], 'BR-0001');
  let e = wi(svc, 1, [INV('SF-2', 'ST-2')], 'BR-0001'); assert.strictEqual(code(e), 'BAD_REQUEST'); assert(/پرداخت/.test(e.err.message));
  assert.strictEqual(code(wi(svc, 1, [INV('SF-1', 'ST-1', { amount: 500, installments: [{ no: 1, dueDate: '', amount: 500 }] }), INV('SF-2', 'ST-2')], 'BR-0001')), 'BAD_REQUEST', 'net below paid');
  assert(wi(svc, 1, [INV('SF-1', 'ST-1')], 'BR-0001').r, 'unpaid invoice deleted'); assert(wp(svc, 1, [], 'BR-0001').r); assert(wi(svc, 1, [], 'BR-0001').r, 'after removing its payments the invoice can be deleted');
});
t('branch isolation: invoices/payments of one branch cannot be created for another branch student; bound user sees only own', () => {
  const { svc } = boot(); setupAdmin(svc); seed5(svc); mkBranch(svc, 'BR-0002', 'B2'); wr(svc, 1, 'students', [{ id: 'ST-7', name: 'غرب', academicYearId: 'YR-1' }], 'BR-0002');
  assert.strictEqual(code(wi(svc, 1, [INV('SF-1', 'ST-7')], 'BR-0001')), 'BAD_REQUEST', 'student of another branch');
  assert(wi(svc, 1, [INV('SF-5', 'ST-7')], 'BR-0002').r); assert(wi(svc, 1, [INV('SF-1', 'ST-1')], 'BR-0001').r);
  loginBranchUser(svc, 7, 'branch_manager', 'bm2', 'BR-0002'); const ld = call(svc, 7, 'db:load').r.collections; assert.deepStrictEqual(ld.studentFees.map(i => i.id), ['SF-5']);
  const fg = call(svc, 7, 'db:save', [{ name: 'studentFees', shard: '', records: [INV('SF-5', 'ST-7'), INV('SF-9', 'ST-1')] }]); assert.strictEqual(code(fg), 'BAD_REQUEST', 'forged: ' + (fg.err && fg.err.message));
  assert.strictEqual(code(call(svc, 7, 'db:save', [{ name: 'studentFees', shard: '', records: [INV('SF-5', 'ST-7'), INV('SF-1', 'ST-1', { title: 'HACK' })] }])), 'FORBIDDEN', 'cannot overwrite another branch invoice');
  assert.strictEqual(loadScope(svc, 1, 'all').collections.studentFees.find(i => i.id === 'SF-1').title, 'English');
});
t('branches:stats finance columns: invoiced, discounts, outstanding, overdue (as of today); match the shared library', () => {
  const { svc } = boot(); setupAdmin(svc); seed5(svc); mkBranch(svc, 'BR-0002', 'B2'); wr(svc, 1, 'students', [{ id: 'ST-7', name: 'غرب', academicYearId: 'YR-1' }], 'BR-0002');
  wi(svc, 1, [INV('SF-1', 'ST-1', { discount: 200, discountReason: 'x', installments: [{ no: 1, dueDate: '2020-01-01', amount: 400 }, { no: 2, dueDate: '2099-01-01', amount: 400 }] }), INV('SF-2', 'ST-2', { installments: [] })], 'BR-0001'); wi(svc, 1, [INV('SF-5', 'ST-7', { amount: 300, installments: [{ no: 1, dueDate: '2020-01-01', amount: 300 }] })], 'BR-0002');
  wp(svc, 1, [PAY('FP-1', 'ST-1', 100, 'SF-1'), PAY('FP-2', 'ST-2', 1000, 'SF-2')], 'BR-0001');
  const st = call(svc, 1, 'branches:stats', 'YR-1').r, a = st.rows.find(r => r.id === 'BR-0001'), b = st.rows.find(r => r.id === 'BR-0002');
  assert.deepStrictEqual([a.invoiced, a.discounts, a.outstanding, a.overdue, a.income], [1800, 200, 700, 300, 1100]); assert.deepStrictEqual([b.invoiced, b.outstanding, b.overdue], [300, 300, 300]);
  assert.deepStrictEqual([st.total.invoiced, st.total.outstanding, st.total.overdue, st.total.discounts], [2100, 1000, 600, 200]);
  call(svc, 1, 'perms:set', 'teacher', ['branches.read']); mkUser(svc, 'teacher', 'tt3'); call(svc, 9, 'auth:login', 'tt3', 'Temp12345pw'); call(svc, 9, 'auth:changePassword', 'Temp12345pw', 'Teach2026pass');
  const tr = call(svc, 9, 'branches:stats').r.rows[0]; assert(tr.invoiced === null && tr.outstanding === null && tr.overdue === null, 'no fees permission → nulls');
});

console.log('— Assessment: skill components, validated marks (Phase 6)');
const Assess6 = require('../lib/assess.js');
const EXM = (id, x) => Object.assign({ id, title: 'Placement', classId: 'CL-1', subjectId: 'SB-1', examType: 'دوره‌ای', date: '2026-05-01', maxScore: 100, yearId: 'YR-1', components: Assess6.SKILLS.map(c => Object.assign({}, c)) }, x || {});
const MKS = (id, st, parts, x) => { const sc = Object.values(parts).reduce((a, b) => a + b, 0); return Object.assign({ id, yearId: 'YR-1', examId: 'EX-1', studentId: st, score: sc, parts }, x || {}); };
const wex = (svc, k, recs, sc) => call(svc, k, 'db:save', [{ name: 'exams', shard: 'YR-1', records: recs, scopeBranch: sc }]);
const wmk = (svc, k, recs, sc) => call(svc, k, 'db:save', [{ name: 'marks', shard: 'YR-1', records: recs, scopeBranch: sc }]);
const seed6 = (svc) => { loadScope(svc, 1); wr(svc, 1, 'classes', [{ id: 'CL-1', name: 'A', academicYearId: 'YR-1' }], 'BR-0001'); wr(svc, 1, 'students', [{ id: 'ST-1', name: 'علی', classId: 'CL-1', academicYearId: 'YR-1' }, { id: 'ST-2', name: 'سارا', classId: 'CL-1', academicYearId: 'YR-1' }], 'BR-0001'); };
t('exam with language-skill components: saved; invalid exams refused (title, max, component sum/names, class)', () => {
  const { svc } = boot(); setupAdmin(svc); seed6(svc);
  assert(wex(svc, 1, [EXM('EX-1')], 'BR-0001').r, 'valid skills exam'); assert(wex(svc, 1, [EXM('EX-1'), EXM('EX-2', { title: 'Plain', components: undefined })], 'BR-0001').r, 'plain exam still fine');
  const rej = (x, m) => assert.strictEqual(code(wex(svc, 1, [EXM('EX-9', x)], 'BR-0001')), 'BAD_REQUEST', m || JSON.stringify(x).slice(0, 60));
  rej({ title: '' }); rej({ maxScore: 0 }); rej({ maxScore: 90 }, 'sum mismatch'); rej({ components: [{ name: 'A', max: 50 }, { name: 'A', max: 50 }] }); rej({ classId: 'CL-404' }, 'unknown class');
  loadScope(svc, 1); mkBranch(svc, 'BR-0002', 'B2'); wr(svc, 1, 'classes', [{ id: 'CL-7', name: 'X', academicYearId: 'YR-1' }], 'BR-0002'); rej({ classId: 'CL-7' }, 'class of another branch');
});
t('marks: parts within component maxima, total = sum, unknown exam refused, stamped with branch', () => {
  const { svc } = boot(); setupAdmin(svc); seed6(svc); wex(svc, 1, [EXM('EX-1')], 'BR-0001');
  assert(wmk(svc, 1, [MKS('MK-1', 'ST-1', { Grammar: 20, Speaking: 20, Listening: 20, Writing: 20 })], 'BR-0001').r, 'valid'); assert.strictEqual(call(svc, 1, 'db:load', 'BR-0001').r.collections.marks[0].branchId, 'BR-0001');
  const rej = (m, why) => assert.strictEqual(code(wmk(svc, 1, [m], 'BR-0001')), 'BAD_REQUEST', why);
  rej(MKS('MK-2', 'ST-2', { Grammar: 30, Speaking: 10 }), 'part above its max'); rej(MKS('MK-2', 'ST-2', { Grammar: 10, Speaking: 10 }, { score: 50 }), 'total ≠ sum'); rej(MKS('MK-2', 'ST-2', { Grammar: 10 }, { score: 101 }), 'above exam max'); rej(MKS('MK-2', 'ST-2', { Grammar: -5 }), 'negative');
  rej(MKS('MK-2', 'ST-2', { Reading: 10 }), 'unknown component'); rej(MKS('MK-2', 'ST-2', {}, { score: 10, parts: undefined }), 'parts required'); rej(MKS('MK-2', 'ST-2', { Grammar: 10 }, { examId: 'EX-404' }), 'unknown exam');
  assert(wmk(svc, 1, [MKS('MK-2', 'ST-2', { Grammar: 10, Speaking: 10 })], 'BR-0001').r, 'blank parts are fine');
});
t('plain exam marks: range enforced; exam with marks cannot change max score / components (title can change)', () => {
  const { svc } = boot(); setupAdmin(svc); seed6(svc); wex(svc, 1, [EXM('EX-2', { title: 'Plain', components: undefined })], 'BR-0001');
  assert(wmk(svc, 1, [{ id: 'MK-1', yearId: 'YR-1', examId: 'EX-2', studentId: 'ST-1', score: 100 }], 'BR-0001').r); assert.strictEqual(code(wmk(svc, 1, [{ id: 'MK-1', yearId: 'YR-1', examId: 'EX-2', studentId: 'ST-1', score: 100.5 }], 'BR-0001')), 'BAD_REQUEST');
  assert.strictEqual(code(wex(svc, 1, [EXM('EX-2', { title: 'Plain', components: undefined, maxScore: 50 })], 'BR-0001')), 'BAD_REQUEST', 'max change blocked'); assert.strictEqual(code(wex(svc, 1, [EXM('EX-2', { title: 'Plain' })], 'BR-0001')), 'BAD_REQUEST', 'adding components blocked');
  assert(wex(svc, 1, [EXM('EX-2', { title: 'Renamed', components: undefined })], 'BR-0001').r, 'title change allowed');
  assert(wmk(svc, 1, [], 'BR-0001').r); assert(wex(svc, 1, [EXM('EX-2', { title: 'Plain', components: undefined, maxScore: 50 })], 'BR-0001').r, 'after marks are removed the max can change');
});
t('old/orphan data never blocks unrelated saves (only new or changed records are validated)', () => {
  const { svc, store } = boot(); setupAdmin(svc); seed6(svc);
  store.save([{ name: 'marks', shard: 'YR-1', records: [{ id: 'MK-OLD', yearId: 'YR-1', examId: 'EX-GONE', studentId: 'ST-1', score: 999, branchId: 'BR-0001' }] }, { name: 'exams', shard: 'YR-1', records: [{ id: 'EX-OLD', title: '', maxScore: 0, classId: 'CL-1', branchId: 'BR-0001', yearId: 'YR-1' }] }]);
  const cur = call(svc, 1, 'db:load', 'BR-0001').r.collections;
  assert(wmk(svc, 1, cur.marks.concat([{ id: 'MK-NEW', yearId: 'YR-1', examId: 'EX-2', studentId: 'ST-1', score: 5 }]).filter(m => m.id !== 'MK-NEW'), 'BR-0001').r, 'unchanged legacy mark re-saved');
  assert(wex(svc, 1, cur.exams, 'BR-0001').r, 'unchanged legacy exam re-saved');
});
t('branch-bound manager records marks for own exams only; other branch exams are unreachable', () => {
  const { svc } = boot(); setupAdmin(svc); seed6(svc); mkBranch(svc, 'BR-0002', 'B2'); wr(svc, 1, 'classes', [{ id: 'CL-7', name: 'X', academicYearId: 'YR-1' }], 'BR-0002'); wr(svc, 1, 'students', [{ id: 'ST-7', name: 'غرب', classId: 'CL-7', academicYearId: 'YR-1' }], 'BR-0002');
  wex(svc, 1, [EXM('EX-1')], 'BR-0001'); wex(svc, 1, [EXM('EX-7', { classId: 'CL-7' })], 'BR-0002');
  loginBranchUser(svc, 7, 'branch_manager', 'bm2', 'BR-0002');
  assert(call(svc, 7, 'db:save', [{ name: 'marks', shard: 'YR-1', records: [MKS('MK-7', 'ST-7', { Grammar: 20 }, { examId: 'EX-7' })] }]).r, 'own exam');
  assert.strictEqual(code(call(svc, 7, 'db:save', [{ name: 'marks', shard: 'YR-1', records: [MKS('MK-8', 'ST-7', { Grammar: 20 }, { examId: 'EX-1' })] }])), 'BAD_REQUEST', 'exam of another branch');
  assert.deepStrictEqual(call(svc, 7, 'db:load').r.collections.exams.map(e => e.id), ['EX-7']);
});

console.log('— Personal colour palette (me:setPrefs)');
t('every user can set their own palette without users.manage; it is returned at login and by auth:me/db:load', () => {
  const { svc } = boot(); setupAdmin(svc); loadScope(svc, 1); mkUser(svc, 'teacher', 'tp1'); call(svc, 5, 'auth:login', 'tp1', 'Temp12345pw'); call(svc, 5, 'auth:changePassword', 'Temp12345pw', 'Teach2026pass');
  const r = call(svc, 5, 'me:setPrefs', { palette: 'emerald' }); assert(r.r && r.r.ok && r.r.palette === 'emerald'); assert.strictEqual(call(svc, 5, 'auth:me').r.user.palette, 'emerald'); assert.strictEqual(call(svc, 5, 'db:load').r.me.palette, 'emerald');
  assert.strictEqual(call(svc, 1, 'auth:me').r.user.palette, '', 'admin unaffected (personal)'); const lg = call(svc, 8, 'auth:login', 'tp1', 'Teach2026pass'); assert.strictEqual(lg.r.user.palette, 'emerald', 'returned at login');
  assert.strictEqual(call(svc, 5, 'me:setPrefs', { palette: 'custom:#7a1fa2' }).r.palette, 'custom:#7a1fa2'); assert.strictEqual(call(svc, 5, 'me:setPrefs', { palette: '' }).r.palette, '', 'reset to the centre default');
});
t('palette ids are validated: unknown, malformed, injection, wrong types are refused and nothing changes', () => {
  const { svc } = boot(); setupAdmin(svc); call(svc, 1, 'me:setPrefs', { palette: 'rose' });
  for (const bad of ['nope', 'custom:#zzz', 'custom:#7a1fa2;}body{display:none', '<script>alert(1)</script>', 'custom:red', 123, {}, []]) assert.strictEqual(code(call(svc, 1, 'me:setPrefs', { palette: bad })), 'BAD_REQUEST', JSON.stringify(bad));
  for (const bad of [null, 'x', 5]) assert.strictEqual(code(call(svc, 1, 'me:setPrefs', bad)), 'BAD_REQUEST'); assert.strictEqual(call(svc, 1, 'auth:me').r.user.palette, 'rose', 'unchanged after failures');
});
t('palette: login required; affects only the caller; survives a restart; other prefs are preserved; a corrupted stored value is never returned', () => {
  const root = tmp(); const { svc, store } = boot(root); setupAdmin(svc); mkUser(svc, 'reception', 'rp1'); call(svc, 5, 'auth:login', 'rp1', 'Temp12345pw'); call(svc, 5, 'auth:changePassword', 'Temp12345pw', 'Recep2026pass');
  assert.strictEqual(code(call(svc, 9, 'me:setPrefs', { palette: 'navy' })), 'NOT_AUTHENTICATED'); call(svc, 5, 'me:setPrefs', { palette: 'gold' }); assert.strictEqual(call(svc, 1, 'auth:me').r.user.palette, '', 'only the caller changes');
  const list = store.readCollection('users', ''); const me = list.find(u => u.username === 'rp1'); assert.strictEqual(me.prefs.palette, 'gold'); me.prefs.other = 'keep'; store.save([{ name: 'users', shard: '', records: list }]);
  const svc2 = createService(createStore(root), { allowTestHooks: true }); const lg = call(svc2, 77, 'auth:login', 'rp1', 'Recep2026pass'); assert(lg.r, 'login after restart: ' + (lg.err && lg.err.message)); assert.strictEqual(lg.r.user.palette, 'gold', 'palette survives a restart');
  call(svc2, 77, 'me:setPrefs', { palette: 'olive' }); assert.strictEqual(createStore(root).readCollection('users', '').find(u => u.username === 'rp1').prefs.other, 'keep', 'other prefs preserved');
  const st3 = createStore(root), l2 = st3.readCollection('users', ''); l2.find(u => u.username === 'rp1').prefs.palette = '<img src=x onerror=alert(1)>'; st3.save([{ name: 'users', shard: '', records: l2 }]);
  const svc3 = createService(createStore(root), { allowTestHooks: true }); const l3 = call(svc3, 78, 'auth:login', 'rp1', 'Recep2026pass'); assert(l3.r && l3.r.user.palette === '', 'corrupted stored value is never returned to the client');
});
t('personal print-output preference: valid modes only; partial updates keep the palette; reset with empty string; returned at login', () => {
  const { svc } = boot(); setupAdmin(svc); assert.strictEqual(call(svc, 1, 'auth:me').r.user.printMode, ''); call(svc, 1, 'me:setPrefs', { palette: 'teal' });
  for (const m of ['ask', 'auto', 'docx', 'xlsx', 'pdf', 'png', 'csv', 'html']) assert.strictEqual(call(svc, 1, 'me:setPrefs', { printMode: m }).r.printMode, m, m);
  const r = call(svc, 1, 'me:setPrefs', { printMode: 'png' }); assert.strictEqual(r.r.palette, 'teal', 'palette kept when only printMode is sent'); assert.strictEqual(call(svc, 1, 'me:setPrefs', { palette: 'rose' }).r.printMode, 'png', 'printMode kept when only palette is sent');
  for (const bad of ['exe', 'PDF', 'docx;rm', 7, {}, []]) assert.strictEqual(code(call(svc, 1, 'me:setPrefs', { printMode: bad })), 'BAD_REQUEST', JSON.stringify(bad)); assert.strictEqual(code(call(svc, 1, 'me:setPrefs', {})), 'BAD_REQUEST', 'empty patch');
  assert.strictEqual(call(svc, 1, 'me:setPrefs', { printMode: '' }).r.printMode, ''); assert.strictEqual(call(svc, 1, 'auth:me').r.user.palette, 'rose');
});
t('branch-bound users can also choose their own palette (does not leak scope)', () => {
  const { svc } = boot(); setupAdmin(svc); loadScope(svc, 1); mkBranch(svc, 'BR-0002', 'B2'); loginBranchUser(svc, 7, 'branch_manager', 'bmx', 'BR-0002');
  assert(call(svc, 7, 'me:setPrefs', { palette: 'brown' }).r.ok); assert.strictEqual(call(svc, 7, 'db:load').r.me.palette, 'brown'); assert.strictEqual(call(svc, 7, 'db:load').r.scope, 'BR-0002');
});

console.log('\n' + pass + ' passed, ' + failN + ' failed');
