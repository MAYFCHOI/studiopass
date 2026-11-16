// server/src/domain/attendance.ts
import type { Db } from '../db.js';
import { newId, nowIso, kstDate } from '../util.js';
import { audit } from '../audit.js';
export type PassRow = { id: string; kind: 'COUNT' | 'PERIOD'; course_id: string | null; remaining: number; total_count: number; valid_from: string; valid_to: string };
export type AttendFail = 'UNKNOWN_MEMBER' | 'UNKNOWN_COURSE' | 'INACTIVE_COURSE' | 'ALREADY' | 'PRO_ONLY' | 'EMPTY' | 'EXPIRED' | 'NO_PASS';
export type AttendResult = { ok: true; attendanceId: string; memberId: string; passId: string; remaining: number; total: number; validTo: string } | { ok: false; reason: AttendFail; memberId?: string; remaining?: number; total?: number; validTo?: string };
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
    const course = db.prepare('select id, kind, instructor_id, active from courses where id=?').get(a.courseId) as { id: string; kind: 'GENERAL' | 'PRO'; instructor_id: string; active: number } | undefined;
    if (!course) return { ok: false, reason: 'UNKNOWN_COURSE', memberId: a.memberId };
    if (!course.active) return { ok: false, reason: 'INACTIVE_COURSE', memberId: a.memberId };
    const prior = db.prepare('select p.remaining, p.total_count, p.valid_to from attendances a join passes p on p.id=a.pass_id where a.member_id=? and a.course_id=? and a.attended_on=? and a.cancelled_at is null').get(a.memberId, course.id, today) as { remaining: number; total_count: number; valid_to: string } | undefined;
    // A retried scan whose first response was lost still shows the remaining count.
    if (prior) return { ok: false, reason: 'ALREADY', memberId: a.memberId, remaining: prior.remaining, total: prior.total_count, validTo: prior.valid_to };
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
export type BackfillFail = 'BAD_DATE' | 'UNKNOWN_MEMBER' | 'UNKNOWN_COURSE' | 'WRONG_DAY' | 'UNKNOWN_PASS' | 'NOT_FOR_COURSE' | 'EMPTY' | 'ALREADY';
/**
 * 지난 출석 넣기(앱 쓰기 전이나 출석 체크를 빠뜨린 수업). 그 날짜·수업으로 출석을 만들어 그날 강사 정산에 들어간다.
 * 횟수 맞추기로 빼 둔 횟수(adjusted_used)가 있으면 그걸 먼저 출석으로 바꾸고(남은 횟수 그대로), 없으면 남은 횟수에서 뺀다.
 * 수강권 유효기간은 보지 않는다(결제가 수업보다 늦게 들어온 경우). 날짜는 오늘 포함 최근 62일.
 */
export function backfillAttendance(db: Db, a: { memberId: string; passId: string; courseId: string; date: string; staffId: string | null; now?: Date }):
  { ok: true; attendanceId: string } | { ok: false; reason: BackfillFail } {
  const today = kstDate(a.now ?? new Date());
  const earliest = new Date(new Date(today + 'T00:00:00Z').getTime() - 62 * 86400000).toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(a.date) || isNaN(Date.parse(a.date)) || a.date > today || a.date < earliest) return { ok: false, reason: 'BAD_DATE' };
  return db.transaction(() => {
    if (!db.prepare('select 1 from members where id=? and erased_at is null').get(a.memberId)) return { ok: false as const, reason: 'UNKNOWN_MEMBER' as const };
    const course = db.prepare('select id, kind, instructor_id, weekday, start_time from courses where id=?').get(a.courseId) as { id: string; kind: 'GENERAL' | 'PRO'; instructor_id: string; weekday: number; start_time: string } | undefined;
    if (!course) return { ok: false as const, reason: 'UNKNOWN_COURSE' as const };
    if (new Date(a.date + 'T00:00:00Z').getUTCDay() !== course.weekday) return { ok: false as const, reason: 'WRONG_DAY' as const };
    const p = db.prepare('select id, kind, course_id, remaining, total_count, valid_from, valid_to, adjusted_used from passes where id=? and member_id=?').get(a.passId, a.memberId) as (PassRow & { adjusted_used: number | null }) | undefined;
    if (!p) return { ok: false as const, reason: 'UNKNOWN_PASS' as const };
    if (!fits(p, course)) return { ok: false as const, reason: 'NOT_FOR_COURSE' as const };
    const fromAdj = (p.adjusted_used ?? 0) > 0;
    if (!fromAdj && p.remaining <= 0) return { ok: false as const, reason: 'EMPTY' as const };
    if (db.prepare('select 1 from attendances where member_id=? and course_id=? and attended_on=? and cancelled_at is null').get(a.memberId, course.id, a.date)) return { ok: false as const, reason: 'ALREADY' as const };
    const id = newId();
    const at = new Date(`${a.date}T${course.start_time}:00+09:00`).toISOString();
    db.prepare('insert into attendances(id,member_id,pass_id,course_id,instructor_id,attended_on,attended_at,created_by,backfilled) values(?,?,?,?,?,?,?,?,?)').run(id, a.memberId, p.id, course.id, course.instructor_id, a.date, at, a.staffId, fromAdj ? 'ADJ' : 'REM');
    if (fromAdj) db.prepare('update passes set adjusted_used = nullif(adjusted_used - 1, 0) where id=?').run(p.id);
    else db.prepare('update passes set remaining = remaining - 1 where id=?').run(p.id);
    audit(db, a.staffId, 'attendance.backfill', 'attendance', id, { date: a.date, courseId: course.id, passId: p.id, from: fromAdj ? 'ADJ' : 'REM' });
    return { ok: true as const, attendanceId: id };
  })();
}
export function cancelAttendance(db: Db, id: string, staffId: string | null) {
  return db.transaction(() => {
    const r = db.prepare('select pass_id, cancelled_at, backfilled from attendances where id=?').get(id) as { pass_id: string; cancelled_at: string | null; backfilled: string | null } | undefined;
    if (!r || r.cancelled_at) return false;
    db.prepare('update attendances set cancelled_at=?, cancelled_by=? where id=?').run(nowIso(), staffId, id);
    // 빼 둔 횟수에서 바꾼 지난 출석은 빼 둔 횟수로 돌려준다(남은 횟수가 늘지 않게)
    if (r.backfilled === 'ADJ') db.prepare('update passes set adjusted_used = coalesce(adjusted_used, 0) + 1 where id=?').run(r.pass_id);
    else db.prepare('update passes set remaining = remaining + 1 where id=?').run(r.pass_id);
    audit(db, staffId, 'attendance.cancel', 'attendance', id);
    return true;
  })();
}
