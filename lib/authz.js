'use strict';
/*
 * سیستم مرکزی نقش‌ها و صلاحیت‌ها (Authorization) — تنها منبع حقیقت برای main و renderer.
 * - نقش‌ها مستقل‌اند و صلاحیت‌های هر نقش توسط مدیر سیستم قابل تنظیم است (rolePerms override).
 * - main.js / service.js هر IPC را با این جدول بررسی می‌کنند؛ رابط کاربری فقط نمایش را تنظیم می‌کند.
 */

const ROLES = {
  admin: 'مدیر سیستم',
  manager: 'مدیر کل',
  branch_manager: 'مدیر شعبه',
  deputy: 'معاون',
  head_teacher: 'سرمعلم',
  teacher: 'استاد',
  finance: 'مدیر مالی / حسابدار',
  reception: 'پذیرش',
  administrative_staff: 'کارمند اداری'
};
// نقش‌های نسخه‌های قبلی → نقش جدید
const LEGACY_ROLES = { registrar: 'reception', accountant: 'finance' };

// فهرست کامل صلاحیت‌ها (برچسب فارسی برای ویرایشگر صلاحیت‌ها)
const PERMISSIONS = {
  'students.read': 'مشاهده شاگردان', 'students.write': 'ثبت/ویرایش شاگردان', 'students.delete': 'حذف شاگرد',
  'parents.read': 'مشاهده والدین', 'parents.write': 'ثبت/ویرایش والدین', 'parents.delete': 'حذف ولی',
  'teachers.read': 'مشاهده استادان', 'teachers.write': 'ثبت/ویرایش استادان', 'teachers.delete': 'حذف استاد',
  'staff.read': 'مشاهده کارمندان', 'staff.write': 'ثبت/ویرایش کارمندان', 'staff.delete': 'حذف کارمند',
  'classes.write': 'مدیریت صنوف', 'classes.delete': 'حذف صنف',
  'courses.write': 'مدیریت کورس‌ها و سطوح', 'courses.delete': 'حذف کورس/سطح',
  'transfer.run': 'انتقال شاگرد/استاد/کارمند بین شعبه‌ها',
  'subjects.write': 'مدیریت مضامین', 'subjects.delete': 'حذف مضمون',
  'timetable.read': 'مشاهده تقسیم اوقات', 'timetable.write': 'ویرایش تقسیم اوقات', 'timetable.delete': 'حذف از تقسیم اوقات',
  'attendance.read': 'مشاهده حاضری شاگردان', 'attendance.write': 'ثبت حاضری شاگردان', 'attendance.delete': 'حذف حاضری',
  'staffAttendance.read': 'مشاهده حاضری استادان/کارمندان', 'staffAttendance.write': 'ثبت حاضری استادان/کارمندان', 'staffAttendance.delete': 'حذف حاضری کارکنان',
  'exams.read': 'مشاهده امتحانات', 'exams.write': 'ایجاد/ویرایش امتحان', 'exams.delete': 'حذف امتحان',
  'grades.read': 'مشاهده نمرات', 'grades.write': 'ثبت/ویرایش نمرات', 'grades.delete': 'حذف نمره',
  'fees.read': 'مشاهده فیس', 'fees.write': 'ثبت فیس و پرداخت', 'fees.delete': 'حذف فیس/پرداخت', 'fees.discount': 'اعطای تخفیف فیس',
  'accounting.read': 'مشاهده حسابداری', 'accounting.write': 'ثبت مصارف', 'accounting.delete': 'حذف مصارف',
  'payroll.read': 'مشاهده معاشات', 'payroll.write': 'ثبت/پرداخت معاش', 'payroll.delete': 'حذف معاش',
  'discipline.read': 'مشاهده انضباط', 'discipline.write': 'ثبت رویداد انضباطی', 'discipline.delete': 'حذف رویداد انضباطی',
  'assets.read': 'مشاهده دارایی و گدام', 'assets.write': 'ثبت دارایی/تحویل', 'assets.delete': 'حذف دارایی',
  'announcements.read': 'مشاهده اطلاعیه‌ها', 'announcements.write': 'ایجاد/ویرایش اطلاعیه', 'announcements.delete': 'حذف اطلاعیه',
  'documents.read': 'مشاهده اسناد', 'documents.write': 'ثبت/ویرایش اسناد', 'documents.delete': 'حذف سند',
  'years.manage': 'مدیریت سال تعلیمی',
  'reports.read': 'گزارش‌ها', 'search.use': 'جستجوی پیشرفته',
  'logs.read': 'مشاهده گزارش فعالیت‌ها',
  'branches.read': 'مشاهده شعبه‌ها و گزارش شعبه', 'branches.write': 'مدیریت شعبه‌ها', 'branches.delete': 'حذف شعبه',
  'users.manage': 'مدیریت کاربران و صلاحیت‌ها',
  'settings.manage': 'تغییر تنظیمات',
  'backup.manage': 'پشتیبان‌گیری',
  'restore.run': 'بازیابی پشتیبان'
};
const ALL_PERMS = Object.keys(PERMISSIONS);

function expand(list) { // 'students.*' → همه‌ی صلاحیت‌های students
  const out = new Set();
  list.forEach(p => {
    if (p === '*') ALL_PERMS.forEach(x => out.add(x));
    else if (p.endsWith('.*')) { const pre = p.slice(0, -1); ALL_PERMS.filter(x => x.startsWith(pre)).forEach(x => out.add(x)); }
    else if (PERMISSIONS[p]) out.add(p);
  });
  return Array.from(out);
}
const rw = (m) => [m + '.read', m + '.write'];

const DEFAULT_ROLE_PERMS = {
  admin: ['*'],
  manager: ['transfer.run', 'students.*', 'parents.*', 'teachers.*', 'staff.*', 'classes.*', 'courses.*', 'subjects.*', 'timetable.*', 'attendance.*', 'staffAttendance.*',
    'exams.*', 'grades.*', 'fees.read', 'accounting.read', 'payroll.read', 'discipline.*', 'assets.*', 'announcements.*', 'documents.*',
    'years.manage', 'reports.read', 'search.use', 'logs.read', 'backup.manage', 'branches.*'],
  branch_manager: ['students.*', 'parents.*', 'teachers.*', 'staff.*', 'classes.*', 'courses.*', 'subjects.*', 'timetable.*', 'attendance.*', 'staffAttendance.*',
    'exams.*', 'grades.*', 'fees.read', 'fees.write', 'fees.discount', 'accounting.read', 'accounting.write', 'payroll.read', 'payroll.write', 'discipline.*', 'assets.*',
    'announcements.*', 'documents.*', 'reports.read', 'search.use', 'branches.read'],
  deputy: ['students.read', 'students.write', 'parents.read', 'parents.write', 'teachers.read', 'staff.read', 'classes.write', 'courses.write', 'subjects.write',
    'timetable.*', 'attendance.*', 'staffAttendance.read', 'exams.*', 'grades.*', 'discipline.*', 'assets.read', 'announcements.*',
    'documents.read', 'documents.write', 'reports.read', 'search.use'],
  head_teacher: ['students.read', 'students.write', 'parents.read', 'teachers.read', 'classes.write', 'subjects.write', 'timetable.*',
    'attendance.*', 'staffAttendance.read', 'staffAttendance.write', 'exams.*', 'grades.*', 'discipline.read', 'discipline.write',
    'announcements.read', 'announcements.write', 'reports.read', 'search.use'],
  teacher: ['students.read', 'timetable.read', 'attendance.read', 'attendance.write', 'exams.read', 'exams.write', 'grades.read', 'grades.write',
    'discipline.read', 'discipline.write', 'announcements.read', 'search.use'],
  finance: ['students.read', 'parents.read', 'teachers.read', 'staff.read', 'fees.read', 'fees.write', 'fees.discount', 'accounting.read', 'accounting.write', 'payroll.read', 'payroll.write', 'assets.read',
    'announcements.read', 'reports.read', 'search.use'],
  reception: ['students.read', 'students.write', 'parents.read', 'parents.write', 'attendance.read', 'attendance.write',
    'documents.read', 'documents.write', 'announcements.read', 'search.use'],
  administrative_staff: ['students.read', 'parents.read', 'attendance.read', 'staffAttendance.read', 'documents.read', 'documents.write',
    'assets.read', 'assets.write', 'announcements.read', 'announcements.write', 'search.use']
};

// قوانین مجموعه‌ها برای db:load / db:save. read/write: نام صلاحیت، یا 'auth' (هر کاربر واردشده)، یا null (ممنوع)
const COLLECTION_RULES = {
  academicYears: { read: 'auth', write: 'years.manage', perm: 'years.manage' },
  branches: { read: 'auth', write: 'branches.write', perm: 'branches.delete', audit: true },
  courses: { read: 'auth', write: 'courses.write', perm: 'courses.delete', audit: true },
  levels: { read: 'auth', write: 'courses.write', perm: 'courses.delete', audit: true },
  courseEnrollments: { read: 'auth', write: 'students.write', perm: 'students.delete' },
  classes: { read: 'auth', write: 'classes.write', perm: 'classes.delete' },
  subjects: { read: 'auth', write: 'subjects.write', perm: 'subjects.delete' },
  teachers: { read: 'teachers.read', write: 'teachers.write', perm: 'teachers.delete' },
  staff: { read: 'staff.read', write: 'staff.write', perm: 'staff.delete' },
  parents: { read: 'parents.read', write: 'parents.write', perm: 'parents.delete' },
  students: { read: 'students.read', write: 'students.write', perm: 'students.delete' },
  enrollments: { read: 'students.read', write: 'students.write', perm: 'students.delete' },
  timetable: { read: 'timetable.read', write: 'timetable.write', perm: 'timetable.delete' },
  attendance: { read: 'attendance.read', write: 'attendance.write', perm: 'attendance.delete' },
  staffAttendance: { read: 'staffAttendance.read', write: 'staffAttendance.write', perm: 'staffAttendance.delete' },
  exams: { read: 'exams.read', write: 'exams.write', perm: 'exams.delete' },
  marks: { read: 'grades.read', write: 'grades.write', perm: 'grades.delete', audit: true },
  feeStructures: { read: 'fees.read', write: 'fees.write', perm: 'fees.delete', audit: true },
  feePayments: { read: 'fees.read', write: 'fees.write', perm: 'fees.delete', audit: true },
  studentFees: { read: 'fees.read', write: 'fees.write', perm: 'fees.delete', audit: true },
  expenses: { read: 'accounting.read', write: 'accounting.write', perm: 'accounting.delete', audit: true },
  payroll: { read: 'payroll.read', write: 'payroll.write', perm: 'payroll.delete', audit: true },
  discipline: { read: 'discipline.read', write: 'discipline.write', perm: 'discipline.delete', audit: true },
  assets: { read: 'assets.read', write: 'assets.write', perm: 'assets.delete' },
  assetMovements: { read: 'assets.read', write: 'assets.write', perm: 'assets.delete' },
  announcements: { read: 'announcements.read', write: 'announcements.write', perm: 'announcements.delete' },
  documents: { read: 'documents.read', write: 'documents.write', perm: 'documents.delete' },
  notifications: { read: 'auth', write: 'auth', perm: null }
};
const OBJECT_RULES = {
  settings: { read: 'auth', write: 'settings.manage', audit: true },
  seq: { read: 'auth', write: 'auth' }
};
// مجموعه‌هایی که هر رکوردشان به یک شعبه تعلق دارد (branchId). بقیه (سال تعلیمی، کاربران، تنظیمات) مشترک‌اند.
const BRANCH_SCOPED = ['courses', 'levels', 'courseEnrollments', 'classes', 'subjects', 'teachers', 'staff', 'parents', 'students', 'enrollments', 'timetable', 'attendance', 'staffAttendance', 'exams', 'marks',
  'feeStructures', 'studentFees', 'feePayments', 'expenses', 'payroll', 'discipline', 'assets', 'assetMovements', 'announcements', 'documents', 'notifications'];
const SHARDED = { enrollments: 1, attendance: 1, staffAttendance: 1, exams: 1, marks: 1, fees: 1, feePayments: 1, timetable: 1, payroll: 1, discipline: 1 };

// صلاحیت لازم برای هر کانال IPC. 'public' بدون ورود؛ 'auth' هر کاربر واردشده؛ {any:[...]} یکی از صلاحیت‌ها
const CHANNEL_RULES = {
  'auth:state': 'public', 'branding:get': 'public', 'branding:apply': 'auth', 'auth:setup': 'public', 'auth:login': 'public', 'recovery:reset': 'public',
  'auth:logout': 'mustchange-ok', 'auth:changePassword': 'mustchange-ok', 'auth:me': 'mustchange-ok',
  'db:load': 'auth', 'db:save': 'auth', 'db:log': 'auth',
  'logs:read': 'logs.read', 'branches:stats': 'branches.read', 'transfer:run': 'transfer.run',
  'users:save': 'users.manage', 'users:delete': 'users.manage', 'users:setPassword': 'users.manage',
  'perms:matrix': 'users.manage', 'perms:set': 'users.manage', 'recovery:regenerate': 'users.manage',
  'backup:create': 'backup.manage', 'backup:list': 'backup.manage', 'backup:info': 'backup.manage', 'backup:verify': 'backup.manage',
  'backup:setConfig': 'backup.manage', 'backup:chooseDir': 'backup.manage', 'backup:pickFile': 'restore.run', 'backup:openFolder': 'backup.manage',
  'backup:restore': 'restore.run',
  'file:save': { any: ['students.write', 'teachers.write', 'staff.write', 'documents.write', 'settings.manage'] },
  'file:delete': { any: ['students.write', 'teachers.write', 'staff.write', 'documents.write', 'settings.manage'] },
  'file:get': { any: ['students.read', 'teachers.read', 'staff.read', 'documents.read', 'settings.manage'] },
  'print:pdf': 'auth', 'print:office': 'auth', 'print:saveFiles': 'auth', 'me:setPrefs': 'auth', 'file:showInFolder': 'auth', 'dialog:saveText': 'auth'
};

function normalizeRole(r) { return LEGACY_ROLES[r] || r; }
function effectivePerms(role, overrides) {
  role = normalizeRole(role);
  if (role === 'admin') return ALL_PERMS.slice();           // مدیر سیستم همیشه همه‌ی صلاحیت‌ها را دارد (غیرقابل تغییر)
  if (!ROLES[role]) return [];
  const ov = overrides && Array.isArray(overrides[role]) ? overrides[role] : null;
  return ov ? ov.filter(p => PERMISSIONS[p]) : expand(DEFAULT_ROLE_PERMS[role]);
}
function hasPerm(perms, need) {
  if (need === 'auth' || need === 'public') return true;
  if (need && need.any) return need.any.some(p => perms.indexOf(p) >= 0);
  return perms.indexOf(need) >= 0;
}

module.exports = { BRANCH_SCOPED, ROLES, LEGACY_ROLES, PERMISSIONS, ALL_PERMS, DEFAULT_ROLE_PERMS, COLLECTION_RULES, OBJECT_RULES, SHARDED, CHANNEL_RULES,
  normalizeRole, effectivePerms, hasPerm, expand };
