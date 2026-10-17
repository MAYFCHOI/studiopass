import { it, expect } from 'vitest';
import { makeDb } from './fixtures.js';
import { attend } from '../src/domain/attendance.js';
import { settle } from '../src/domain/settlement.js';
it('ratio, per-session and monthly pass rules', () => {
  const { db, member, pass, course } = makeDb();
  const c = course(); const ins = c.instructor_id;
  const a = member('가', '01000000001'); pass(a, { total: 8, remaining: 8 }); // 180000/8 = 22500
  const b = member('나', '01000000002'); pass(b, { kind: 'PERIOD', total: 12, remaining: 12 });
  attend(db, { memberId: a, courseId: c.id, staffId: null, now: new Date('2026-10-19T10:30:00Z') });
  attend(db, { memberId: b, courseId: c.id, staffId: null, now: new Date('2026-10-19T10:31:00Z') });
  attend(db, { memberId: a, courseId: c.id, staffId: null, now: new Date('2026-11-02T10:30:00Z') }); // 다른 달
  let line = settle(db, '2026-10').find((l) => l.instructorId === ins)!;
  expect(line).toMatchObject({ sessions: 1, heads: 2, revenue: 22500, instructorPay: 11250, academyPay: 11250, proTickets: 1 });
  db.prepare("update instructors set settlement_type='PER_SESSION', per_session_fee=40000 where id=?").run(ins);
  line = settle(db, '2026-10').find((l) => l.instructorId === ins)!;
  expect(line).toMatchObject({ sessions: 1, instructorPay: 40000, academyPay: 22500 });
});
