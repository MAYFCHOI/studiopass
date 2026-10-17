// server/test/attendance.test.ts
import { describe, it, expect } from 'vitest';
import { makeDb } from './fixtures.js';
import { attend, cancelAttendance } from '../src/domain/attendance.js';
const T = new Date('2026-10-19T10:30:00Z'); // KST 2026-10-19 19:30
const rem = (db: any, id: string) => (db.prepare('select remaining r from passes where id=?').get(id) as any).r;
describe('attend', () => {
  it('records attendance and decrements the pass once', () => {
    const { db, member, course, pass } = makeDb(); const m = member(); const s = pass(m, {}); const c = course();
    const r = attend(db, { memberId: m, courseId: c.id, staffId: null, now: T });
    expect(r).toMatchObject({ ok: true, passId: s, remaining: 7, total: 8 });
    expect(rem(db, s)).toBe(7);
  });
  it('rejects a second scan of the same course on the same KST day', () => {
    const { db, member, course, pass } = makeDb(); const m = member(); const s = pass(m, {}); const c = course();
    attend(db, { memberId: m, courseId: c.id, staffId: null, now: T });
    expect(attend(db, { memberId: m, courseId: c.id, staffId: null, now: new Date('2026-10-19T14:59:00Z') })).toMatchObject({ ok: false, reason: 'ALREADY' });
    expect(rem(db, s)).toBe(7);
  });
  it('uses KST date near midnight', () => {
    const { db, member, course, pass } = makeDb(); const m = member(); pass(m, { from: '2026-10-20', to: '2026-10-20' }); const c = course();
    expect(attend(db, { memberId: m, courseId: c.id, staffId: null, now: new Date('2026-10-19T15:10:00Z') })).toMatchObject({ ok: true }); // KST 10-20 00:10
  });
  it('picks course pass, then common count pass, then monthly pass, earliest expiry first', () => {
    const { db, member, course, pass } = makeDb(); const m = member(); const c = course();
    const monthly = pass(m, { kind: 'PERIOD', total: 12, remaining: 12 });
    const commonLate = pass(m, { to: '2026-12-31' }); const commonEarly = pass(m, { to: '2026-11-05' });
    const own = pass(m, { courseId: c.id, to: '2026-12-31' });
    expect(attend(db, { memberId: m, courseId: c.id, staffId: null, now: T })).toMatchObject({ passId: own });
    db.prepare('update passes set remaining=0 where id=?').run(own);
    expect(attend(db, { memberId: m, courseId: c.id, staffId: null, now: new Date('2026-10-20T10:30:00Z') })).toMatchObject({ passId: commonEarly });
    db.prepare('update passes set remaining=0 where id in (?,?)').run(commonEarly, commonLate);
    expect(attend(db, { memberId: m, courseId: c.id, staffId: null, now: new Date('2026-10-21T10:30:00Z') })).toMatchObject({ passId: monthly });
  });
  it('PRO class accepts only the monthly pass', () => {
    const { db, member, course, pass } = makeDb(); const m = member(); pass(m, {}); const pro = course('PRO');
    expect(attend(db, { memberId: m, courseId: pro.id, staffId: null, now: T })).toMatchObject({ ok: false, reason: 'PRO_ONLY' });
    pass(m, { kind: 'PERIOD', total: 12, remaining: 12 });
    expect(attend(db, { memberId: m, courseId: pro.id, staffId: null, now: T })).toMatchObject({ ok: true });
  });
  it('explains empty, expired and missing passes', () => {
    const { db, member, course, pass } = makeDb(); const c = course();
    const a = member('가', '01000000001'); pass(a, { remaining: 0 });
    const b = member('나', '01000000002'); pass(b, { to: '2026-10-18' });
    const d = member('다', '01000000003');
    expect(attend(db, { memberId: a, courseId: c.id, staffId: null, now: T })).toMatchObject({ reason: 'EMPTY' });
    expect(attend(db, { memberId: b, courseId: c.id, staffId: null, now: T })).toMatchObject({ reason: 'EXPIRED' });
    expect(attend(db, { memberId: d, courseId: c.id, staffId: null, now: T })).toMatchObject({ reason: 'NO_PASS' });
    expect(attend(db, { memberId: 'nope', courseId: c.id, staffId: null, now: T })).toMatchObject({ reason: 'UNKNOWN_MEMBER' });
  });
  it('cancel restores the count once and allows a new scan', () => {
    const { db, member, course, pass } = makeDb(); const m = member(); const s = pass(m, {}); const c = course();
    const r = attend(db, { memberId: m, courseId: c.id, staffId: 'st', now: T }) as any;
    expect(cancelAttendance(db, r.attendanceId, 'st')).toBe(true);
    expect(cancelAttendance(db, r.attendanceId, 'st')).toBe(false);
    expect(rem(db, s)).toBe(8);
    expect(attend(db, { memberId: m, courseId: c.id, staffId: null, now: T })).toMatchObject({ ok: true });
    expect((db.prepare("select count(*) n from audit_log where action='attendance.cancel'").get() as any).n).toBe(1);
  });
});
describe('attend concurrency', () => {
  it('two simultaneous scans of the same QR decrement once', async () => {
    const { db, member, course, pass } = makeDb(); const m = member(); const s = pass(m, {}); const c = course();
    const run = () => Promise.resolve().then(() => attend(db, { memberId: m, courseId: c.id, staffId: null, now: T }));
    const rs = await Promise.all([run(), run()]);
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
    expect(rs.find((r) => !r.ok)).toMatchObject({ reason: 'ALREADY' });
    expect(rem(db, s)).toBe(7);
  });
  it('partial unique index blocks a duplicate row even if the check is bypassed', () => {
    const { db, member, course, pass } = makeDb(); const m = member(); const s = pass(m, {}); const c = course();
    const ins = () => db.prepare('insert into attendances(id,member_id,pass_id,course_id,instructor_id,attended_on,attended_at) values(?,?,?,?,?,?,?)').run(Math.random().toString(), m, s, c.id, c.instructor_id, '2026-10-19', 'x');
    ins(); expect(ins).toThrow(/UNIQUE/);
  });
});
