/* منطق مالی مشترک بین main (اعتبارسنجی و گزارش شعبه‌ها) و رندرر (نمایش) — یک منبع واحد تا اعداد هیچ‌وقت ناهمخوان نشوند.
   فاقد وابستگی به Node/DOM است؛ در Node با require و در مرورگر با <script src="lib/finance.js"> بارگذاری می‌شود (window.Finance). */
(function (root) {
  'use strict';
  const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
  const num = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };
  const ISO = /^\d{4}-\d{2}-\d{2}$/;

  function invoiceNet(inv) { return r2(Math.max(0, num(inv && inv.amount) - num(inv && inv.discount))); }

  function addMonths(iso, n) {
    if (!ISO.test(iso || '')) return '';
    const [y, m, d] = iso.split('-').map(Number);
    const t = (m - 1) + n, ny = y + Math.floor(t / 12), nm = ((t % 12) + 12) % 12;
    const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
    return ny + '-' + String(nm + 1).padStart(2, '0') + '-' + String(Math.min(d, last)).padStart(2, '0');
  }

  // تقسیم مبلغ خالص به چند قسط مساوی؛ باقی‌مانده‌ی گردکردن به قسط آخر می‌رود
  function buildSchedule(net, count, firstDue, intervalMonths) {
    count = Math.max(1, Math.min(36, Math.floor(num(count)) || 1)); net = r2(net);
    const base = Math.floor(net / count * 100) / 100, out = []; let acc = 0;
    for (let i = 0; i < count; i++) {
      const amount = i === count - 1 ? r2(net - acc) : base; acc = r2(acc + amount);
      out.push({ no: i + 1, dueDate: firstDue ? addMonths(firstDue, i * (Math.max(1, Math.floor(num(intervalMonths)) || 1))) : '', amount });
    }
    return out;
  }

  // پرداخت‌ها به‌ترتیب روی قسط‌ها تخصیص می‌یابد (قدیمی‌ترین ابتدا)
  function allocate(inv, paid, today) {
    let left = r2(paid);
    return (inv.installments || []).map((it) => {
      const amount = r2(it.amount), p = r2(Math.min(left, amount)); left = r2(left - p);
      const remaining = r2(amount - p), overdue = remaining > 0 && it.dueDate && today && it.dueDate < today;
      return { no: it.no, dueDate: it.dueDate || '', amount, paid: p, remaining, state: remaining <= 0 ? 'پرداخت‌شده' : overdue ? 'سررسید گذشته' : p > 0 ? 'نیمه‌پرداخت' : 'در انتظار' };
    });
  }

  function structureTotal(fs) { return fs ? num(fs.regFee) + num(fs.monthlyFee) * (num(fs.monthsCount) || 12) + num(fs.examFee) + num(fs.otherFee) : 0; }

  // موجودی مالی یک شاگرد = ساختار فیس صنف (روش قبلی، بر اساس سال) + مجموع فیس‌نامه‌ها (از همه‌ی سال‌ها تا بدهی سال قبل گم نشود)
  function studentBalance(student, ctx) {
    ctx = ctx || {}; const today = ctx.today || '';
    const structures = ctx.structures || [], invoices = ctx.invoices || [], payments = ctx.payments || [];
    const fs = structures.find((f) => f.classId === student.classId && f.yearId === student.academicYearId);
    const legacyTotal = r2(Math.max(0, structureTotal(fs) - num(student.feeDiscount)));
    const legacyPaid = r2(payments.filter((p) => p.studentId === student.id && !p.invoiceId && p.yearId === student.academicYearId).reduce((t, p) => t + num(p.amount), 0));
    const legacyRemaining = r2(Math.max(0, legacyTotal - legacyPaid));
    let total = legacyTotal, paid = legacyPaid, remaining = legacyRemaining, overdue = 0, oldestDue = '', discounts = 0, invoiced = 0;
    const list = [];
    invoices.filter((i) => i.studentId === student.id && !i.cancelled).forEach((inv) => {
      const net = invoiceNet(inv), ip = r2(payments.filter((p) => p.invoiceId === inv.id).reduce((t, p) => t + num(p.amount), 0)), rem = r2(Math.max(0, net - ip));
      const sched = allocate(inv, ip, today), od = r2(sched.filter((x) => x.state === 'سررسید گذشته').reduce((t, x) => t + x.remaining, 0));
      const next = sched.find((x) => x.remaining > 0 && x.dueDate); const due = next ? next.dueDate : '';
      total = r2(total + net); paid = r2(paid + ip); remaining = r2(remaining + rem); overdue = r2(overdue + od); invoiced = r2(invoiced + net); discounts = r2(discounts + num(inv.discount));
      if (due && (!oldestDue || due < oldestDue)) oldestDue = due;
      list.push({ id: inv.id, title: inv.title, net, paid: ip, remaining: rem, overdue: od, nextDue: due, schedule: sched });
    });
    return { total: r2(total), paid: r2(paid), remaining: r2(remaining), overdue, oldestDue, invoiced, discounts, invoices: list };
  }

  // اعتبارسنجی ساختاری یک فیس‌نامه؛ رشته‌ی خطا یا null
  function validateInvoice(inv) {
    if (!inv || typeof inv !== 'object') return 'فیس‌نامه نامعتبر است.';
    if (!String(inv.title || '').trim()) return 'عنوان فیس‌نامه الزامی است.';
    if (String(inv.title).length > 150) return 'عنوان فیس‌نامه بسیار طولانی است.';
    const amount = Number(inv.amount), disc = inv.discount === undefined || inv.discount === '' ? 0 : Number(inv.discount);
    if (!isFinite(amount) || amount <= 0) return 'مبلغ فیس‌نامه باید بیشتر از صفر باشد.';
    if (!isFinite(disc) || disc < 0) return 'تخفیف نمی‌تواند منفی باشد.';
    if (disc > amount) return 'تخفیف نمی‌تواند بیشتر از مبلغ فیس‌نامه باشد.';
    if (disc > 0 && !String(inv.discountReason || '').trim()) return 'برای تخفیف، دلیل آن را بنویسید.';
    const inst = inv.installments || [];
    if (!Array.isArray(inst) || inst.length > 36) return 'تعداد قسط‌ها نامعتبر است (حداکثر ۳۶).';
    if (inst.length) {
      let sum = 0;
      for (const it of inst) { if (it.dueDate && !ISO.test(it.dueDate)) return 'تاریخ سررسید قسط نامعتبر است.'; const a = Number(it.amount); if (!isFinite(a) || a <= 0) return 'مبلغ هر قسط باید بیشتر از صفر باشد.'; sum += a; }
      if (Math.abs(r2(sum) - invoiceNet(inv)) > 0.01) return 'مجموع قسط‌ها باید برابر مبلغ خالص فیس‌نامه باشد.';
    }
    return null;
  }

  const api = { r2, invoiceNet, addMonths, buildSchedule, allocate, structureTotal, studentBalance, validateInvoice };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Finance = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
