'use strict';
const assert = require('assert'); const F = require('../lib/finance.js');
let pass = 0, fail = 0; const t = (n, f) => { try { f(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + e.message); } };
console.log('— Finance library');
t('invoiceNet: amount minus discount, never negative', () => { assert.strictEqual(F.invoiceNet({ amount: 1000, discount: 150 }), 850); assert.strictEqual(F.invoiceNet({ amount: 100, discount: 500 }), 0); assert.strictEqual(F.invoiceNet({}), 0); });
t('addMonths clamps the day to the target month and crosses years', () => { assert.strictEqual(F.addMonths('2026-01-31', 1), '2026-02-28'); assert.strictEqual(F.addMonths('2028-01-31', 1), '2028-02-29'); assert.strictEqual(F.addMonths('2026-11-15', 3), '2027-02-15'); assert.strictEqual(F.addMonths('bad', 1), ''); });
t('buildSchedule: equal parts, remainder on the last installment, sums exactly to net', () => {
  for (const [net, n] of [[1000, 3], [100, 7], [0.05, 3], [12345.67, 12], [999.99, 36], [10, 1]]) { const s = F.buildSchedule(net, n, '2026-01-10', 1); assert.strictEqual(s.length, n); assert.strictEqual(F.r2(s.reduce((a, x) => a + x.amount, 0)), net, net + '/' + n); assert(s.every(x => x.amount > 0 || net < 0.1)); }
  assert.strictEqual(F.buildSchedule(500, 2, '', 1)[0].dueDate, '', 'no due date when none given'); assert.strictEqual(F.buildSchedule(500, 99, '2026-01-01', 1).length, 36, 'capped'); assert.strictEqual(F.buildSchedule(500, 0, '2026-01-01', 1).length, 1);
});
t('allocate: payments fill installments oldest-first; states are right', () => {
  const inv = { installments: [{ no: 1, dueDate: '2026-01-01', amount: 100 }, { no: 2, dueDate: '2026-02-01', amount: 100 }, { no: 3, dueDate: '2026-03-01', amount: 100 }] };
  const a = F.allocate(inv, 150, '2026-02-15'); assert.deepStrictEqual(a.map(x => x.state), ['پرداخت‌شده', 'سررسید گذشته', 'در انتظار']); assert.deepStrictEqual(a.map(x => x.paid), [100, 50, 0]);
  assert.strictEqual(F.allocate(inv, 120, '2026-01-15')[1].state, 'نیمه‌پرداخت'); assert.strictEqual(F.allocate(inv, 999, '2030-01-01').every(x => x.state === 'پرداخت‌شده'), true, 'overpay cannot create negatives');
  assert.strictEqual(F.allocate({ installments: [{ no: 1, dueDate: '', amount: 10 }] }, 0, '2030-01-01')[0].state, 'در انتظار', 'no due date is never overdue');
});
const S = { id: 'ST-1', classId: 'CL-1', academicYearId: 'YR-1' };
t('legacy class fee structure behaves exactly as before (discount, per-year payments, clamp at 0)', () => {
  const ctx = { structures: [{ classId: 'CL-1', yearId: 'YR-1', regFee: 100, monthlyFee: 50, monthsCount: 10, examFee: 20, otherFee: 30 }], payments: [{ studentId: 'ST-1', yearId: 'YR-1', amount: 300 }, { studentId: 'ST-1', yearId: 'YR-0', amount: 9999 }, { studentId: 'ST-2', yearId: 'YR-1', amount: 9999 }] };
  const b = F.studentBalance(Object.assign({ feeDiscount: 50 }, S), ctx); assert.deepStrictEqual([b.total, b.paid, b.remaining, b.overdue], [600, 300, 300, 0]);
  assert.strictEqual(F.studentBalance(S, { structures: ctx.structures, payments: [{ studentId: 'ST-1', yearId: 'YR-1', amount: 5000 }] }).remaining, 0);
  assert.deepStrictEqual(F.studentBalance(S, {}), { total: 0, paid: 0, remaining: 0, overdue: 0, oldestDue: '', invoiced: 0, discounts: 0, invoices: [] });
  assert.strictEqual(F.studentBalance({ id: 'X', classId: 'CL-1', academicYearId: 'YR-1' }, { structures: [{ classId: 'CL-1', yearId: 'YR-1', regFee: 10 }] }).total, 10, 'monthsCount undefined → 12 months of 0');
});
t('invoices add to the balance; invoice payments settle only their invoice; debts of older years are kept', () => {
  const inv = [{ id: 'SF-1', studentId: 'ST-1', yearId: 'YR-0', title: 'English', amount: 1000, discount: 200, installments: [{ no: 1, dueDate: '2026-01-01', amount: 400 }, { no: 2, dueDate: '2026-02-01', amount: 400 }] }, { id: 'SF-2', studentId: 'ST-1', yearId: 'YR-1', title: 'Math', amount: 300, discount: 0, installments: [], cancelled: true }, { id: 'SF-3', studentId: 'ST-9', yearId: 'YR-1', title: 'x', amount: 5000 }];
  const pay = [{ studentId: 'ST-1', invoiceId: 'SF-1', yearId: 'YR-1', amount: 500 }, { studentId: 'ST-1', yearId: 'YR-1', amount: 70 }];
  const b = F.studentBalance(S, { invoices: inv, payments: pay, today: '2026-02-10', structures: [{ classId: 'CL-1', yearId: 'YR-1', regFee: 100 }] });
  assert.strictEqual(b.total, 900, 'legacy 100 + invoice net 800, cancelled and other students ignored'); assert.strictEqual(b.paid, 570); assert.strictEqual(b.remaining, 330, 'legacy 30 + invoice 300');
  assert.strictEqual(b.overdue, 300, 'second installment (due Feb 1) has 300 unpaid'); assert.strictEqual(b.oldestDue, '2026-02-01'); assert.strictEqual(b.invoiced, 800); assert.strictEqual(b.discounts, 200);
  assert.deepStrictEqual(b.invoices[0].schedule.map(x => x.state), ['پرداخت‌شده', 'سررسید گذشته']);
  assert.strictEqual(F.studentBalance(S, { invoices: inv, payments: pay.concat([{ studentId: 'ST-1', invoiceId: 'SF-1', yearId: 'YR-1', amount: 300 }]), today: '2026-02-10' }).remaining, 0, 'fully paid');
});
t('validateInvoice: required fields, discount rules, installment sums and dates', () => {
  const ok = { title: 'T', amount: 1000, discount: 100, discountReason: 'یتیم', installments: [{ no: 1, dueDate: '2026-01-01', amount: 450 }, { no: 2, dueDate: '2026-02-01', amount: 450 }] };
  assert.strictEqual(F.validateInvoice(ok), null);
  const bad = (x) => F.validateInvoice(Object.assign({}, ok, x)); assert(bad({ title: ' ' })); assert(bad({ amount: 0 })); assert(bad({ amount: 'x' })); assert(bad({ discount: -1 })); assert(bad({ discount: 2000 })); assert(bad({ discountReason: '' }), 'discount needs a reason');
  assert(bad({ installments: [{ no: 1, dueDate: '2026-01-01', amount: 100 }] }), 'sum mismatch'); assert(bad({ installments: [{ no: 1, dueDate: '01/01/2026', amount: 900 }] }), 'bad date'); assert(bad({ installments: [{ no: 1, dueDate: '', amount: 0 }, { no: 2, dueDate: '', amount: 900 }] }), 'zero installment');
  assert.strictEqual(F.validateInvoice({ title: 'T', amount: 50 }), null, 'no discount / no installments is fine'); assert(F.validateInvoice(null));
});
console.log('\n' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
