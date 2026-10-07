'use strict';
const assert = require('assert'); const A = require('../lib/assess.js');
let pass = 0, fail = 0; const t = (n, f) => { try { f(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + e.message); } };
console.log('— Assessment library');
const LANG = { id: 'EX-1', title: 'Placement', maxScore: 100, components: A.SKILLS };
t('validateExam: title, positive max, component names unique, positive, sum equals max, ≤ 8', () => {
  assert.strictEqual(A.validateExam(LANG), null); assert.strictEqual(A.validateExam({ title: 'T', maxScore: 100 }), null, 'plain exam'); assert.strictEqual(A.validateExam({ title: 'T', maxScore: 100, components: [] }), null);
  const bad = (x) => assert(A.validateExam(Object.assign({}, LANG, x)), JSON.stringify(x).slice(0, 70));
  bad({ title: ' ' }); bad({ maxScore: 0 }); bad({ maxScore: 'x' }); bad({ maxScore: 90 }); bad({ components: [{ name: 'A', max: 50 }, { name: 'a', max: 50 }] }); bad({ components: [{ name: '', max: 100 }] }); bad({ components: [{ name: 'A', max: 0 }, { name: 'B', max: 100 }] });
  bad({ components: Array.from({ length: 9 }, (_, i) => ({ name: 'C' + i, max: 100 / 9 })) }); bad({ components: 'x' }); assert(A.validateExam(null));
});
t('validateMark: range, parts per component, sum equals total, unknown part, plain exams have no parts', () => {
  const ok = { score: 80, parts: { Grammar: 20, Speaking: 20, Listening: 20, Writing: 20 } }; assert.strictEqual(A.validateMark(ok, LANG), null);
  const bad = (m, e) => assert(A.validateMark(m, e || LANG), JSON.stringify(m).slice(0, 80));
  bad({ score: 101, parts: ok.parts }); bad({ score: -1, parts: ok.parts }); bad({ score: 'x' }); bad({ score: 80 }, LANG); bad({ score: 80, parts: { Grammar: 30, Speaking: 20, Listening: 15, Writing: 15 } }); bad({ score: 80, parts: { Grammar: 20, Speaking: 20, Listening: 20, Writing: 10 } }); bad({ score: 20, parts: { Grammar: 20, Reading: 0 } });
  assert.strictEqual(A.validateMark({ score: 40, parts: { Grammar: 20, Speaking: 20 } }, LANG), null, 'blank parts allowed, sum of provided = total');
  const plain = { id: 'EX-2', title: 'P', maxScore: 50 }; assert.strictEqual(A.validateMark({ score: 50 }, plain), null); bad({ score: 51 }, plain); bad({ score: 10, parts: { X: 10 } }, plain); assert(A.validateMark({ score: 1 }, null));
});
t('competitionRank: ties share a rank and the next rank is skipped; NaN ignored', () => {
  const r = A.competitionRank([{ v: 90 }, { v: 80 }, { v: 80 }, { v: 70 }, { v: NaN }], (x) => x.v); const out = Array.from(r.entries()).map(([k, v]) => [k.v, v.rank]);
  assert.deepStrictEqual(out.filter(x => !isNaN(x[0])).sort((a, b) => b[0] - a[0]), [[90, 1], [80, 2], [80, 2], [70, 4]]); assert.strictEqual(Array.from(r.values())[0].total, 4);
});
const ST = [{ id: 'S1', name: 'علی' }, { id: 'S2', name: 'سارا' }, { id: 'S3', name: 'کریم' }];
const MK = [{ examId: 'EX-1', studentId: 'S1', score: 80, parts: { Grammar: 20, Speaking: 20, Listening: 20, Writing: 20 } }, { examId: 'EX-1', studentId: 'S2', score: 80, parts: { Grammar: 25, Speaking: 25, Listening: 15, Writing: 15 } }, { examId: 'EX-9', studentId: 'S3', score: 99 }];
t('examResults: ranking with ties, pass threshold, stats, absent list; other exams ignored', () => {
  const r = A.examResults(LANG, MK, ST, 60); assert.deepStrictEqual(r.rows.map(x => [x.studentId, x.rank, x.result]), [['S2', 1, 'قبول'], ['S1', 1, 'قبول']].sort((a, b) => ST.find(s => s.id === a[0]).name.localeCompare(ST.find(s => s.id === b[0]).name)));
  assert.deepStrictEqual([r.stats.count, r.stats.avg, r.stats.max, r.stats.min, r.stats.passRate], [2, 80, 80, 80, 100]); assert.deepStrictEqual(r.absent, ['کریم']);
  assert.strictEqual(A.examResults(LANG, MK, ST, 90).rows.every(x => x.result === 'ناکام'), true, 'threshold respected'); assert.strictEqual(A.examResults(LANG, MK, ST).rows[0].result, 'قبول', 'default 50');
  assert.deepStrictEqual(A.examResults(LANG, [], ST).stats, { count: 0, avg: 0, max: 0, min: 0, passed: 0, passRate: 0 });
});
t('history, skill averages, trend and overall for a student', () => {
  const E2 = { id: 'EX-2', title: 'Mid', maxScore: 100, date: '2026-06-01' }, E1 = Object.assign({}, LANG, { date: '2026-05-01' });
  const marks = MK.concat([{ examId: 'EX-2', studentId: 'S1', score: 95 }]); const h = A.studentHistory('S1', [E2, E1], marks);
  assert.deepStrictEqual(h.map(x => x.examId), ['EX-1', 'EX-2'], 'chronological'); assert.deepStrictEqual(h.map(x => x.pct), [80, 95]);
  const sk = A.skillAverages(h); assert.deepStrictEqual(sk.map(x => [x.name, x.pct]), [['Grammar', 80], ['Speaking', 80], ['Listening', 80], ['Writing', 80]]);
  assert.deepStrictEqual(A.trend(h), { label: 'صعودی', diff: 15 }); assert.strictEqual(A.trend(h.slice(0, 1)).label, 'داده‌ی کافی نیست'); assert.strictEqual(A.trend([{ pct: 70 }, { pct: 71 }]).label, 'ثابت'); assert.strictEqual(A.trend([{ pct: 90 }, { pct: 60 }]).label, 'نزولی');
  assert.deepStrictEqual(A.overall(h), { score: 175, max: 200, pct: 87.5 }); assert.deepStrictEqual(A.overall([]), { score: 0, max: 0, pct: 0 });
});
console.log('\n' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
