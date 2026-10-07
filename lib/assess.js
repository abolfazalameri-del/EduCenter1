/* منطق مشترک ارزیابی (امتحان، نمره‌ی اجزا/مهارت‌ها، رتبه، پیشرفت) — هم در main (اعتبارسنجی) و هم در رندرر (نمایش) استفاده می‌شود.
   بدون وابستگی به Node/DOM؛ در مرورگر با <script src="lib/assess.js"> بارگذاری می‌شود (window.Assess). */
(function (root) {
  'use strict';
  const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
  const SKILLS = [{ name: 'Grammar', max: 25 }, { name: 'Speaking', max: 25 }, { name: 'Listening', max: 25 }, { name: 'Writing', max: 25 }];

  function components(exam) { return exam && Array.isArray(exam.components) ? exam.components : []; }
  function pct(score, max) { return Number(max) > 0 ? r2(Number(score) / Number(max) * 100) : 0; }

  // امتحان: عنوان، نمره‌ی کامل مثبت، و در صورت داشتن اجزا: نام یکتا، سقف مثبت، مجموع سقف‌ها = نمره‌ی کامل
  function validateExam(exam) {
    if (!exam || typeof exam !== 'object') return 'امتحان نامعتبر است.';
    if (!String(exam.title || '').trim()) return 'عنوان امتحان الزامی است.';
    const max = Number(exam.maxScore); if (!isFinite(max) || max <= 0) return 'نمره‌ی کامل امتحان باید بیشتر از صفر باشد.';
    if (exam.components === undefined || (Array.isArray(exam.components) && !exam.components.length)) return null;
    if (!Array.isArray(exam.components) || exam.components.length > 8) return 'اجزای امتحان نامعتبر است (حداکثر ۸ جزء).';
    const names = new Set(); let sum = 0;
    for (const c of exam.components) {
      const n = String(c && c.name || '').trim(); if (!n || n.length > 40) return 'نام هر جزء/مهارت الزامی است.';
      if (names.has(n.toLowerCase())) return 'نام جزء «' + n + '» تکراری است.'; names.add(n.toLowerCase());
      const m = Number(c.max); if (!isFinite(m) || m <= 0) return 'نمره‌ی کامل جزء «' + n + '» باید بیشتر از صفر باشد.'; sum += m;
    }
    if (Math.abs(r2(sum) - r2(max)) > 0.01) return 'مجموع نمره‌ی اجزا (' + r2(sum) + ') باید برابر نمره‌ی کامل امتحان (' + r2(max) + ') باشد.';
    return null;
  }

  // نمره: عدد در بازه‌ی [0, کامل]؛ اگر امتحان اجزا دارد، parts الزامی، هر جزء در بازه‌ی خودش و مجموع = score
  function validateMark(mark, exam) {
    if (!exam) return 'امتحان این نمره یافت نشد.';
    const s = Number(mark && mark.score); if (!isFinite(s) || s < 0) return 'نمره نامعتبر است.';
    if (s > Number(exam.maxScore) + 0.0001) return 'نمره نمی‌تواند بیشتر از نمره‌ی کامل (' + exam.maxScore + ') باشد.';
    const comps = components(exam);
    if (comps.length) {
      const parts = mark.parts; if (!parts || typeof parts !== 'object') return 'نمره‌ی اجزای امتحان الزامی است.';
      let sum = 0;
      for (const k of Object.keys(parts)) { if (!comps.some((c) => c.name === k)) return 'جزء «' + k + '» در این امتحان نیست.'; }
      for (const c of comps) { const v = parts[c.name]; if (v === undefined || v === null || v === '') continue; const n = Number(v); if (!isFinite(n) || n < 0) return 'نمره‌ی «' + c.name + '» نامعتبر است.'; if (n > Number(c.max) + 0.0001) return 'نمره‌ی «' + c.name + '» نمی‌تواند بیشتر از ' + c.max + ' باشد.'; sum += n; }
      if (Math.abs(r2(sum) - r2(s)) > 0.01) return 'مجموع نمره‌ی اجزا با نمره‌ی کل برابر نیست.';
    } else if (mark.parts !== undefined && mark.parts !== null && Object.keys(mark.parts).length) return 'این امتحان جزء ندارد.';
    return null;
  }

  // رتبه‌بندی رقابتی: امتیاز برابر ⇒ رتبه‌ی برابر و رتبه‌ی بعدی می‌پرد (1,1,3)
  function competitionRank(items, valueOf) {
    const sorted = items.map((it) => ({ it, v: Number(valueOf(it)) })).filter((x) => isFinite(x.v)).sort((a, b) => b.v - a.v);
    const out = new Map(); let rank = 0, prev = null;
    sorted.forEach((x, i) => { if (prev === null || Math.abs(x.v - prev) > 1e-9) { rank = i + 1; prev = x.v; } out.set(x.it, { rank, total: sorted.length }); });
    return out;
  }

  // نتایج یک امتحان: ردیف‌های مرتب‌شده با رتبه، فیصدی، آمار
  function examResults(exam, marks, students, passPercent) {
    const pass = Number(passPercent) > 0 ? Number(passPercent) : 50;
    const byStudent = new Map(); marks.filter((m) => m.examId === exam.id).forEach((m) => byStudent.set(m.studentId, m));
    const rows = students.filter((s) => byStudent.has(s.id)).map((s) => { const m = byStudent.get(s.id); return { studentId: s.id, name: s.name, score: Number(m.score), parts: m.parts || null, pct: pct(m.score, exam.maxScore) }; });
    const ranks = competitionRank(rows, (r) => r.score);
    rows.forEach((r) => { const k = ranks.get(r); r.rank = k.rank; r.result = r.pct >= pass ? 'قبول' : 'ناکام'; });
    rows.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
    const sc = rows.map((r) => r.score);
    const stats = rows.length ? { count: rows.length, avg: r2(sc.reduce((a, b) => a + b, 0) / rows.length), max: Math.max.apply(null, sc), min: Math.min.apply(null, sc), passed: rows.filter((r) => r.result === 'قبول').length, passRate: r2(rows.filter((r) => r.result === 'قبول').length / rows.length * 100) } : { count: 0, avg: 0, max: 0, min: 0, passed: 0, passRate: 0 };
    return { rows, stats, absent: students.filter((s) => !byStudent.has(s.id)).map((s) => s.name) };
  }

  // سابقه‌ی نمرات یک شاگرد به ترتیب تاریخ
  function studentHistory(studentId, exams, marks) {
    const mm = new Map(); marks.filter((m) => m.studentId === studentId).forEach((m) => mm.set(m.examId, m));
    return exams.filter((e) => mm.has(e.id)).map((e) => { const m = mm.get(e.id); return { examId: e.id, title: e.title, date: e.date || '', subjectId: e.subjectId, score: Number(m.score), max: Number(e.maxScore), pct: pct(m.score, e.maxScore), parts: m.parts || null, components: components(e) }; })
      .sort((a, b) => (a.date || '').localeCompare(b.date || '') || a.title.localeCompare(b.title));
  }

  // میانگین هر مهارت/جزء در همه‌ی امتحان‌ها (فقط امتحان‌هایی که آن جزء را دارند)
  function skillAverages(history) {
    const acc = new Map();
    history.forEach((h) => (h.components || []).forEach((c) => { const v = h.parts && h.parts[c.name]; if (v === undefined || v === null || v === '') return; const a = acc.get(c.name) || { name: c.name, score: 0, max: 0, count: 0 }; a.score += Number(v); a.max += Number(c.max); a.count++; acc.set(c.name, a); }));
    return Array.from(acc.values()).map((a) => ({ name: a.name, score: r2(a.score), max: r2(a.max), pct: pct(a.score, a.max), count: a.count }));
  }

  // روند پیشرفت: مقایسه‌ی نیمه‌ی دوم با نیمه‌ی اول (حداقل ۲ امتحان)
  function trend(history) {
    if (history.length < 2) return { label: 'داده‌ی کافی نیست', diff: 0 };
    const h = Math.floor(history.length / 2), avg = (a) => a.reduce((t, x) => t + x.pct, 0) / a.length;
    const diff = r2(avg(history.slice(history.length - h)) - avg(history.slice(0, h)));
    return { label: diff > 2 ? 'صعودی' : diff < -2 ? 'نزولی' : 'ثابت', diff };
  }

  function overall(history) { const sc = history.reduce((t, h) => t + h.score, 0), mx = history.reduce((t, h) => t + h.max, 0); return { score: r2(sc), max: r2(mx), pct: pct(sc, mx) }; }

  const api = { r2, SKILLS, components, pct, validateExam, validateMark, competitionRank, examResults, studentHistory, skillAverages, trend, overall };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Assess = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
