# TEST REPORT (اجرای واقعی در محیط Claude، 2026-10-02)

محیط: Node v22.22.2، Chromium (Playwright)، بدون اینترنت، بدون Electron/ویندوز.
نتیجه: store 12/12 · service 44/44 · E2E 60/60 · ۱۷ PDF واقعی (همگی ۱ صفحه، متن و تصویر غیرخالی).
**اجرا نشده (نیاز به GitHub Actions/ویندوز):** Electron واقعی، printToPDF، electron-builder، Installer، نصب/حذف.

## Unit + service (test/store.test.js, test/service.test.js)
```
  ✓ save + load roundtrip (plain + sharded)
  ✓ backup skipped when nothing changed since last backup
  ✓ change after backup makes next backup happen exactly once
  ✓ notifications do not dirty the backup state
  ✓ restore replaces data, makes pre-restore safety copy, keeps logs
  ✓ corrupt backup is rejected, data untouched
  ✓ crash between renames: .prev fallback loads old data
  ✓ retention keeps only N automatic backups
    write 36ms, load 44ms
  ✓ volume: 5000 students + 60k marks/attendance shards persist & reload fast
  ✓ files: save/read
  ✓ recovery code: only a hash is stored; verify accepts the right code (any case/dashes), rejects others
  ✓ password hash: legacy 100k-iteration format still verifies; plaintext never verifies
12 store tests passed
— Authentication / passwords
  ✓ fresh store needs setup; no default user/password exists
  ✓ weak setup passwords rejected (short / no digit / common / = username)
  ✓ setup works once, returns recovery code, second setup refused
  ✓ password stored as PBKDF2 salted hash, never plaintext
  ✓ same password → different salt/hash
  ✓ wrong password rejected; 5 failures lock the account for a while
  ✓ db:load never exposes password hashes to the renderer
  ✓ unauthenticated IPC calls are rejected
  ✓ unknown channel rejected
— Forced password change
  ✓ admin-created user must change password; every other IPC blocked until then
  ✓ admin password reset forces change at next login and kills other sessions
  ✓ legacy plaintext/weak passwords from older data are migrated and force a change
  ✓ legacy role names are migrated (registrar→reception, accountant→finance)
— Recovery code
  ✓ recovery code resets admin password, is single-use (new code issued), stored hashed
  ✓ recovery attempts are rate limited
— Roles & IPC-level permissions
  ✓ all 8 roles exist with labels; defaults only reference known permissions
  ✓ every IPC channel has an explicit rule
  ✓ finance: can write fees/payroll, cannot touch grades, users, settings, backup, restore
  ✓ finance cannot create an admin by sending a hand-made users record through db:save
  ✓ teacher: grades + attendance yes; fees, payroll, students write, delete no
  ✓ deleting records requires the delete permission (grades: teacher can write but not delete)
  ✓ student soft-delete requires students.delete (reception can write but not delete)
  ✓ all 8 roles log in and get a role-appropriate load; admin_staff/deputy/head_teacher/manager defined
  ✓ role permissions are configurable by admin and enforced immediately (perms:set)
  ✓ cannot remove/disable/demote the last admin or yourself
  ✓ disabled user is logged out immediately and cannot log in
  ✓ invalid input rejected: duplicate username, bad role, bad ids, duplicate record ids, path traversal in shard/file id
  ✓ file size/format validation (corrupt base64, empty, oversize)
  ✓ restore only accepts known backup paths or dialog-picked paths
— Audit log
  ✓ login/logout/failed login/denied access/user & permission changes/grade+finance changes are logged by main with the real user
  ✓ renderer cannot forge the user name in db:log
— Backup / atomic restore
  ✓ backup file is checksummed, listed, verified; corrupted backup is detected
  ✓ restore brings back exact data, creates pre-restore safety backup, ends all sessions
  ✓ injected failure at "stage" → current data preserved (rollback), no leftovers, app keeps working
  ✓ injected failure at "validate" → current data preserved (rollback), no leftovers, app keeps working
  ✓ injected failure at "swap" → current data preserved (rollback), no leftovers, app keeps working
  ✓ injected failure at "post-swap-check" → current data preserved (rollback), no leftovers, app keeps working
  ✓ backup that passes checksum but has structurally invalid data (no admin) is refused before touching data
  ✓ exit backup is only created when data changed since last backup; keepAuto rotation works
  ✓ backup config validation (bad dir/number rejected, custom dir accepted)
  ✓ corrupt data file: store survives (reads as empty) and a fresh backup still restorable
— Concurrency / scale
  ✓ two rapid sequential saves to the same collection: last write wins, no corruption
  ✓ 5000 students: save+load < 3s, filter/search over 5000 < 50ms
  ✓ large attendance/marks sets across years (20k marks) persist per-year shards

44 passed, 0 failed
```

## E2E (test/e2e.test.js)
```
— First run / authentication
  ✓ first run shows setup form (no default admin/1234) 
  ✓ weak password rejected in setup UI 
  ✓ setup creates admin, logs in, shows one-time recovery code 
  ✓ password stored hashed on disk (no plaintext anywhere in data dir) 
— Core setup via UI
  ✓ create academic year 
  ✓ create class (+ second class) 
  ✓ create subject 
  ✓ create teacher (with salary) 
  ✓ create staff member 
  ✓ create parent 
  ✓ student form: required-field validation shown, nothing saved 
  ✓ corrupt image file: clear error, student still saved without photo 
  ✓ create student with photo in the create form (select → preview → compress → save) — stored 1529 bytes JPEG
  ✓ parent ↔ student link stored (both directions) 
  ✓ edit form shows existing photo; replace photo deletes the old file 
  ✓ remove photo from edit form 
  ✓ re-add photo (kept for the rest of the flow) 
  ✓ student search / filter 
— Teaching flow
  ✓ timetable slot saved; teacher double-booking (other class, same slot) refused — blocked: ذخیره شد. | ذخیره شد. | ذخیره شد. | تضاد زمانی: این استاد در
  ✓ student attendance saved and retrievable 
  ✓ staff/teacher attendance saved and retrievable 
  ✓ staff attendance monthly report 
  ✓ exam created, marks entered & persisted 
  ✓ marks above the maximum are rejected 
  ✓ report card: correct computation + real PDF — 87076 bytes, 1 page(s), ink=3647
  ✓ student history tabs: attendance / marks / fees / discipline all render 
— Finance
  ✓ fee payment → receipt shown → receipt PDF 
  ✓ negative / zero fee amount rejected 
  ✓ expense recorded 
  ✓ payroll: net = base + additions − deductions, status/remaining computed, duplicate period refused 
  ✓ payroll receipt PDF + payroll report PDF 
  ✓ accounting summary: income − expenses − payroll paid is correct 
— Discipline / assets / notices / parent report / documents
  ✓ discipline event saved with responsible user; appears in student history tab 
  ✓ discipline report PDF 
  ✓ asset: register, issue, over-issue refused, return, history, availability math 
  ✓ asset in use cannot be deleted 
  ✓ announcement created 
  ✓ parent report shows linked student + PDF 
  ✓ teacher documents: open, add record, stored with relatedType=teacher 
  ✓ students list PDF + every report type produces a non-blank PDF — 10 report PDFs OK
  ✓ search page works 
— Users / permissions through the real UI
  ✓ create finance user in UI 
  ✓ user created with valid temp password 
  ✓ permission editor opens, lists permissions and saves a change 
  ✓ logout; wrong password shows clear error 
  ✓ finance login → forced password change modal (cannot be dismissed), weak new password refused 
  ✓ finance UI: sees fees/accounting/payroll, NOT users/settings/backup/exams/discipline 
  ✓ finance DIRECT IPC attempts are refused by main (not just hidden menus) — 10 malicious IPC calls refused
  ✓ finance cannot delete payments (write w/o delete permission) – data intact 
  ✓ finance logs out; admin logs back in 
  ✓ audit log recorded login/logout/failed login/denied/grade+finance/user changes 
— Backup / modify / exit backup / restore / verify
  ✓ manual backup from UI — EduCenter-Backup_2026-10-02_05-56-06_manual.json
  ✓ modify data after backup (rename student, add expense, delete discipline event) 
  ✓ exit → automatic backup created because data changed (store.createBackup("exit"), same call main.js makes on close) 
  ✓ restore the manual backup from UI file picker (confirm dialog → atomic restore) 
  ✓ login again after restore (new password retained) and verify ALL data is the pre-change state — all collections verified
  ✓ data persists across a true restart (new store+service on the same folder, fresh browser page) 
  ✓ recovery code (from first run) resets the admin password; old recovery code is then invalid 
  ✓ no external network requests were needed (offline): page loaded only file:// resources 
  ✓ no uncaught page errors during the whole flow 

60/60 E2E steps passed; 17 PDFs written to /home/claude/work/e2e-out
```
