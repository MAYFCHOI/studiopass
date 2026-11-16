import { it, expect } from 'vitest';
import { makeDb } from './fixtures.js';
import { backfillAttendance, cancelAttendance } from '../src/domain/attendance.js';
import { settle } from '../src/domain/settlement.js';
const now = new Date('2026-11-16T05:00:00Z'); // KST 11-16 월
it('turns pre-app usage into attendance on the class day, then takes from remaining, and cancel gives back to the same place', () => {
  const { db, member, pass, course } = makeDb();
  const c = db.prepare('select id, instructor_id, weekday from courses where id=?').get(course().id) as any;
  const m = member('가', '01000000001');
  const p = pass(m, { total: 4, remaining: 1, from: '2026-11-15' });
  db.prepare('update passes set adjusted_used=3 where id=?').run(p);
  // 그 수업 요일인 최근 날짜
  const d = new Date('2026-11-16T00:00:00Z'); while (d.getUTCDay() !== c.weekday) d.setUTCDate(d.getUTCDate() - 1);
  const day = d.toISOString().slice(0, 10);
  const prev = new Date(d.getTime() - 7 * 86400000).toISOString().slice(0, 10);
  const wrong = new Date(d.getTime() - 86400000).toISOString().slice(0, 10);
  const bf = (date: string, passId = p) => backfillAttendance(db, { memberId: m, passId, courseId: c.id, date, staffId: null, now });
  expect(bf(wrong)).toEqual({ ok: false, reason: 'WRONG_DAY' });
  expect(bf('2026-11-17')).toEqual({ ok: false, reason: 'BAD_DATE' });
  expect(bf('2026-08-01')).toEqual({ ok: false, reason: 'BAD_DATE' });
  expect(bf(day, 'nope')).toEqual({ ok: false, reason: 'UNKNOWN_PASS' });
  const r = bf(day); expect(r.ok).toBe(true);
  expect(bf(day)).toEqual({ ok: false, reason: 'ALREADY' });
  expect(db.prepare('select remaining, adjusted_used from passes where id=?').get(p)).toEqual({ remaining: 1, adjusted_used: 2 });
  expect(db.prepare('select attended_on, backfilled from attendances where pass_id=?').get(p)).toEqual({ attended_on: day, backfilled: 'ADJ' });
  const month = day.slice(0, 7);
  expect(settle(db, month).find((l) => l.instructorId === c.instructor_id)!.heads).toBe(1);
  if (r.ok) cancelAttendance(db, r.attendanceId, null);
  expect(db.prepare('select remaining, adjusted_used from passes where id=?').get(p)).toEqual({ remaining: 1, adjusted_used: 3 });
  db.prepare('update passes set adjusted_used=null where id=?').run(p);
  const r2 = bf(prev); expect(r2.ok).toBe(true);
  expect(db.prepare('select remaining from passes where id=?').get(p)).toEqual({ remaining: 0 });
  expect(bf(day)).toEqual({ ok: false, reason: 'EMPTY' });
  if (r2.ok) cancelAttendance(db, r2.attendanceId, null);
  expect(db.prepare('select remaining from passes where id=?').get(p)).toEqual({ remaining: 1 });
});
