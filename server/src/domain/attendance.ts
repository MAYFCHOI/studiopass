// server/src/domain/attendance.ts
import type { Db } from '../db.js';
import { newId, nowIso, kstDate } from '../util.js';
import { audit } from '../audit.js';
export type PassRow = { id: string; kind: 'COUNT' | 'PERIOD'; course_id: string | null; remaining: number; total_count: number; valid_from: string; valid_to: string };
export type AttendFail = 'UNKNOWN_MEMBER' | 'UNKNOWN_COURSE' | 'ALREADY' | 'PRO_ONLY' | 'EMPTY' | 'EXPIRED' | 'NO_PASS';
export type AttendResult = { ok: true; attendanceId: string; memberId: string; passId: string; remaining: number; total: number; validTo: string } | { ok: false; reason: AttendFail; memberId?: string };
const fits = (p: PassRow, c: { id: string; kind: string }) => (p.kind === 'PERIOD' ? true : c.kind === 'PRO' ? false : p.course_id ? p.course_id === c.id : true);
const rank = (p: PassRow) => (p.kind === 'PERIOD' ? 2 : p.course_id ? 0 : 1);
export function pickPass(passes: PassRow[], course: { id: string; kind: 'GENERAL' | 'PRO' }, today: string) {
  return passes.filter((p) => fits(p, course) && p.remaining > 0 && p.valid_from <= today && p.valid_to >= today)
    .sort((a, b) => rank(a) - rank(b) || a.valid_to.localeCompare(b.valid_to))[0];
}
export function attend(db: Db, a: { memberId: string; courseId: string; staffId: string | null; now?: Date }): AttendResult {
  const now = a.now ?? new Date(); const today = kstDate(now);
  return db.transaction((): AttendResult => {
    if (!db.prepare('select 1 from members where id=? and erased_at is null').get(a.memberId)) return { ok: false, reason: 'UNKNOWN_MEMBER' };
    const course = db.prepare('select id, kind, instructor_id from courses where id=?').get(a.courseId) as { id: string; kind: 'GENERAL' | 'PRO'; instructor_id: string } | undefined;
    if (!course) return { ok: false, reason: 'UNKNOWN_COURSE', memberId: a.memberId };
    if (db.prepare('select 1 from attendances where member_id=? and course_id=? and attended_on=? and cancelled_at is null').get(a.memberId, course.id, today)) return { ok: false, reason: 'ALREADY', memberId: a.memberId };
    const passes = db.prepare('select id, kind, course_id, remaining, total_count, valid_from, valid_to from passes where member_id=?').all(a.memberId) as PassRow[];
    const p = pickPass(passes, course, today);
    if (!p) {
      const usable = passes.filter((x) => fits(x, course));
      if (course.kind === 'PRO' && !usable.length && passes.length) return { ok: false, reason: 'PRO_ONLY', memberId: a.memberId };
      if (!usable.length) return { ok: false, reason: 'NO_PASS', memberId: a.memberId };
      const latest = usable.sort((x, y) => y.valid_to.localeCompare(x.valid_to))[0];
      return { ok: false, reason: latest.valid_to < today || latest.valid_from > today ? 'EXPIRED' : 'EMPTY', memberId: a.memberId };
    }
    const id = newId();
    db.prepare('insert into attendances(id,member_id,pass_id,course_id,instructor_id,attended_on,attended_at,created_by) values(?,?,?,?,?,?,?,?)').run(id, a.memberId, p.id, course.id, course.instructor_id, today, nowIso(now), a.staffId);
    db.prepare('update passes set remaining = remaining - 1 where id=? and remaining > 0').run(p.id);
    return { ok: true, attendanceId: id, memberId: a.memberId, passId: p.id, remaining: p.remaining - 1, total: p.total_count, validTo: p.valid_to };
  })();
}
export function cancelAttendance(db: Db, id: string, staffId: string | null) {
  return db.transaction(() => {
    const r = db.prepare('select pass_id, cancelled_at from attendances where id=?').get(id) as { pass_id: string; cancelled_at: string | null } | undefined;
    if (!r || r.cancelled_at) return false;
    db.prepare('update attendances set cancelled_at=?, cancelled_by=? where id=?').run(nowIso(), staffId, id);
    db.prepare('update passes set remaining = remaining + 1 where id=?').run(r.pass_id);
    audit(db, staffId, 'attendance.cancel', 'attendance', id);
    return true;
  })();
}
