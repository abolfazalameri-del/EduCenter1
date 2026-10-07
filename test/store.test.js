'use strict';
const assert = require('assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { createStore } = require('../lib/store');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'educenter-'));
const s = createStore(base);
let n = 0; const t = (name, fn) => { fn(); n++; console.log('  ✓', name); };

t('save + load roundtrip (plain + sharded)', () => {
  s.save([{ name: 'users', shard: '', records: [{ id: 'US-1', username: 'a', password: s.hashPassword('Aaaa1111x'), role: 'admin', status: 'فعال' }] },
          { name: 'students', shard: '', records: [{ id: 'ST-1', name: 'الف' }] },
          { name: 'attendance', shard: 'Y1', records: [{ id: 'a1', yearId: 'Y1' }] },
          { name: 'attendance', shard: 'Y2', records: [{ id: 'a2', yearId: 'Y2' }] },
          { name: 'settings', object: { schoolName: 'مرکز آموزشی' } }]);
  const l = s.loadAll();
  assert.equal(l.collections.students.length, 1);
  assert.equal(l.collections.attendance.length, 2);
  assert.equal(l.objects.settings.schoolName, 'مرکز آموزشی');
});
t('backup skipped when nothing changed since last backup', () => {
  const b1 = s.createBackup('manual');           // dirty → creates
  assert.ok(b1.ok);
  const b2 = s.createBackup('auto');             // no change → skipped
  assert.ok(b2.skipped);
  const b3 = s.createBackup('exit'); assert.ok(b3.skipped);
  assert.equal(s.listBackups().length, 1);
});
t('change after backup makes next backup happen exactly once', () => {
  s.save([{ name: 'students', shard: '', records: [{ id: 'ST-1', name: 'الف' }, { id: 'ST-2', name: 'ب' }] }]);
  assert.ok(s.createBackup('exit').ok);
  assert.ok(s.createBackup('exit').skipped);
  assert.equal(s.listBackups().length, 2);
});
t('notifications do not dirty the backup state', () => {
  s.save([{ name: 'notifications', shard: '', records: [{ id: 'n1' }] }]);
  assert.ok(s.createBackup('auto').skipped);
});
t('restore replaces data, makes pre-restore safety copy, keeps logs', () => {
  s.appendLogs([{ user: 'x', action: 'ورود' }]);
  const first = s.listBackups().slice(-1)[0];      // oldest: only ST-1
  s.save([{ name: 'students', shard: '', records: [{ id: 'ST-9' }] }]);
  const r = s.restoreBackup(first.path);
  assert.ok(r.ok && r.safety);
  const l = s.loadAll();
  assert.deepEqual(l.collections.students.map(x => x.id), ['ST-1']);
  assert.equal(l.collections.attendance.length, 2);
  assert.equal(l.logs.length, 1);
  assert.ok(s.listBackups().some(b => b.reason === 'pre-restore'));
  assert.ok(s.createBackup('auto').skipped);        // restored state == backup state
});
t('corrupt backup is rejected, data untouched', () => {
  const bad = path.join(base, 'bad.json'); fs.writeFileSync(bad, '{"app":"edu-center","data":{"collections":{}},"checksum":"x"}');
  assert.throws(() => s.restoreBackup(bad));
  assert.equal(s.loadAll().collections.students.length, 1);
});
t('crash between renames: .prev fallback loads old data', () => {
  const f = path.join(s.dataDir, 'students.json');
  fs.copyFileSync(f, f + '.prev'); fs.unlinkSync(f);
  assert.equal(s.loadAll().collections.students.length, 1);
  fs.copyFileSync(f + '.prev', f);
  fs.writeFileSync(f, '{broken');                   // corrupt main → prev used
  assert.equal(s.loadAll().collections.students.length, 1);
});
t('retention keeps only N automatic backups', () => {
  s.setConfig({ keepAuto: 3 });
  for (let i = 0; i < 6; i++) { s.save([{ name: 'expenses', shard: '', records: [{ id: 'e' + i }] }]); s.createBackup('periodic'); }
  const auto = s.listBackups().filter(b => b.reason === 'periodic' || b.reason === 'auto' || b.reason === 'exit');
  assert.ok(auto.length <= 3, 'auto=' + auto.length);
});
t('volume: 5000 students + 60k marks/attendance shards persist & reload fast', () => {
  const st = Array.from({ length: 5000 }, (_, i) => ({ id: 'ST-' + i, name: 'شاگرد ' + i, fatherName: 'پدر ' + i, phone: '07' + i }));
  const at = Array.from({ length: 6000 }, (_, i) => ({ id: 'A' + i, yearId: 'Y1', classId: 'C' + (i % 30), date: '2026-01-01', entries: Object.fromEntries(Array.from({ length: 40 }, (_, k) => ['S' + k, 'p'])) }));
  const mk = Array.from({ length: 20000 }, (_, i) => ({ id: 'M' + i, yearId: 'Y1', scores: { a: 50, b: 60, c: 70, d: 80 } }));
  let t0 = Date.now();
  s.save([{ name: 'students', shard: '', records: st }, { name: 'attendance', shard: 'Y1', records: at }, { name: 'marks', shard: 'Y1', records: mk }]);
  const wr = Date.now() - t0; t0 = Date.now();
  const l = s.loadAll(); const rd = Date.now() - t0;
  assert.equal(l.collections.students.length, 5000);
  assert.equal(l.collections.marks.length, 20000);
  console.log('    write ' + wr + 'ms, load ' + rd + 'ms');
  assert.ok(rd < 4000);
});
t('files: save/read', () => { s.saveFile('abc123', Buffer.from('hello').toString('base64')); assert.equal(Buffer.from(s.readFile('abc123'), 'base64').toString(), 'hello'); assert.equal(s.readFile('../x'), null); });
t('recovery code: only a hash is stored; verify accepts the right code (any case/dashes), rejects others', () => {
  assert.ok(!s.hasRecovery());
  const code = s.generateRecoveryCode();
  assert.ok(/^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/.test(code));
  assert.ok(s.hasRecovery());
  const raw = fs.readFileSync(path.join(base, 'recovery.json'), 'utf8');
  assert.ok(!raw.includes(code.replace(/-/g, '')));
  const s2 = createStore(base);          // restart
  assert.ok(s2.verifyRecoveryCode(code)); assert.ok(s2.verifyRecoveryCode(code.toLowerCase().replace(/-/g, ' ')));
  assert.ok(!s2.verifyRecoveryCode('AAAA-BBBB-CCCC-DDDD'));
  assert.notEqual(s2.generateRecoveryCode(), code); assert.ok(!s2.verifyRecoveryCode(code));   // old code invalid after regeneration
});
t('password hash: legacy 100k-iteration format still verifies; plaintext never verifies', () => {
  const crypto = require('crypto'); const salt = crypto.randomBytes(16);
  const legacy = 'pbkdf2:' + salt.toString('hex') + ':' + crypto.pbkdf2Sync('Legacy123x', salt, 100000, 32, 'sha256').toString('hex');
  assert.ok(s.verifyPassword('Legacy123x', legacy)); assert.ok(!s.verifyPassword('legacy123x', legacy)); assert.ok(!s.verifyPassword('1234', '1234'));
});
console.log(n + ' store tests passed'); fs.rmSync(base, { recursive: true, force: true });
