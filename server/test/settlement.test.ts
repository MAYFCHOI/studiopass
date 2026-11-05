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
it('drop-in payments count for the course instructor without a member', () => {
  const { db, course } = makeDb();
  const c = course(); const ins = c.instructor_id;
  db.prepare("insert into products(id,name,course_id,pass_kind,count,period_days,price,drop_in) values('p_t','(1 TICKET) X',?, 'COUNT',1,30,35000,1)").run(c.id);
  db.prepare("insert into products(id,name,course_id,pass_kind,count,period_days,price,drop_in) values('p_w','WARM UP',null,'COUNT',1,30,30000,1)").run();
  const ins2 = db.prepare("insert into payments(id,source,external_id,paid_at,amount,payer_phone,product_name,status,created_at,drop_in) values(?,?,?,?,?,'',?,'APPROVED','x',1)");
  ins2.run('d1', 'KIOSK', 'e1', '2026-10-19T09:22:12Z', 35000, '(1 TICKET) X');
  ins2.run('d2', 'KIOSK', 'e2', '2026-10-19T11:00:00Z', 35000, '(1 TICKET) X');
  ins2.run('d3', 'KIOSK', 'e3', '2026-10-31T15:30:00Z', 35000, '(1 TICKET) X'); // KST 11-01 00:30 → 다음 달
  ins2.run('d4', 'KIOSK', 'e4', '2026-10-19T09:30:00Z', 30000, 'WARM UP'); // 수업 없음 → 강사 없음
  const line = settle(db, '2026-10').find((l) => l.instructorId === ins)!;
  expect(line).toMatchObject({ sessions: 1, heads: 2, revenue: 70000, dropIns: 2, instructorPay: 35000 });
  expect(settle(db, '2026-10').reduce((n, l) => n + l.revenue, 0)).toBe(70000);
  expect(settle(db, '2026-11').find((l) => l.instructorId === ins)!.dropIns).toBe(1);
});
