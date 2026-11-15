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
it('one instructor with a ratio class and a per-session class', () => {
  const { db, member, pass } = makeDb();
  const ins = (db.prepare("select instructor_id from courses where kind='GENERAL' limit 1").get() as any).instructor_id;
  const [c1, c2] = db.prepare("select id from courses where kind='GENERAL' limit 2").all() as { id: string }[];
  db.prepare('update courses set instructor_id=? where id in (?,?)').run(ins, c1.id, c2.id);
  db.prepare("update instructors set settlement_type='RATIO', ratio_instructor=50 where id=?").run(ins);
  db.prepare("update courses set settlement_type='PER_SESSION', per_session_fee=40000 where id=?").run(c2.id);
  const a = member('가', '01000000001'); pass(a, { total: 8, remaining: 8 }); // 22500 / 회
  attend(db, { memberId: a, courseId: c1.id, staffId: null, now: new Date('2026-10-19T10:30:00Z') });
  attend(db, { memberId: a, courseId: c2.id, staffId: null, now: new Date('2026-10-20T10:30:00Z') });
  attend(db, { memberId: a, courseId: c2.id, staffId: null, now: new Date('2026-10-21T10:30:00Z') });
  const line = settle(db, '2026-10').find((l) => l.instructorId === ins)!;
  const r = line.courses.find((c) => c.courseId === c1.id)!, t = line.courses.find((c) => c.courseId === c2.id)!;
  expect(r).toMatchObject({ type: 'RATIO', custom: false, sessions: 1, revenue: 22500, instructorPay: 11250 });
  expect(t).toMatchObject({ type: 'PER_SESSION', custom: true, perSessionFee: 40000, sessions: 2, revenue: 45000, instructorPay: 80000 });
  expect(t.days.map((d) => [d.date, d.heads, d.people[0].name, d.people[0].value])).toEqual([['2026-10-20', 1, '가', 22500], ['2026-10-21', 1, '가', 22500]]);
  // 합계 = 수업별 합, 학원 몫은 비율제 수업에서만 강사 몫을 뺀다
  expect(line).toMatchObject({ sessions: 3, revenue: 67500, instructorPay: 91250, academyPay: 67500 - 11250 });
});
it('a drop-in product without a class counts for the class picked on the payment', () => {
  const { db, course } = makeDb();
  const c = course(); const ins = c.instructor_id;
  db.prepare("update courses set settlement_type='PER_SESSION', per_session_fee=40000 where id=?").run(c.id);
  db.prepare("insert into products(id,name,course_id,pass_kind,count,period_days,price,drop_in) values('p_w','WARM UP TRAINING',null,'COUNT',1,7,30000,1)").run();
  const pay = db.prepare("insert into payments(id,source,external_id,paid_at,amount,payer_phone,product_name,status,created_at,drop_in,course_id,payer_name) values(?,'KIOSK',?,?,30000,'','WARM UP TRAINING','APPROVED','x',1,?,?)");
  pay.run('w1', 'e1', '2026-10-19T09:00:00Z', c.id, '손님1');
  pay.run('w2', 'e2', '2026-10-19T09:05:00Z', c.id, '손님2');
  pay.run('w3', 'e3', '2026-10-20T09:00:00Z', null, '손님3'); // 수업 안 고름 → 아무 강사도 아님
  const line = settle(db, '2026-10').find((l) => l.instructorId === ins)!;
  expect(line).toMatchObject({ sessions: 1, heads: 2, dropIns: 2, revenue: 60000, instructorPay: 40000 });
  expect(line.courses[0].days[0].people.map((p) => p.name)).toEqual(['손님1', '손님2']);
  expect(settle(db, '2026-10').reduce((n, l) => n + l.dropIns, 0)).toBe(2);
});
it('a drop-in paid a day early counts on the class day, not as a second session', () => {
  const { db, member, pass, course } = makeDb();
  const c = course(); const ins = c.instructor_id;
  const wd = (db.prepare('select weekday from courses where id=?').get(c.id) as { weekday: number }).weekday;
  db.prepare("update courses set settlement_type='PER_SESSION', per_session_fee=40000 where id=?").run(c.id);
  // 2026-10 의 그 요일 중 1일보다 뒤인 날 하나와 그 전날
  let day = 8; while (new Date(Date.UTC(2026, 9, day)).getUTCDay() !== wd) day++;
  const iso = (dd: number, h: number) => new Date(Date.UTC(2026, 9, dd, h)).toISOString();
  const a = member('가', '01000000001'); pass(a, { total: 8, remaining: 8 });
  attend(db, { memberId: a, courseId: c.id, staffId: null, now: new Date(iso(day, 10)) });
  db.prepare("insert into products(id,name,course_id,pass_kind,count,period_days,price,drop_in) values('p_w','WARM UP',null,'COUNT',1,7,30000,1)").run();
  db.prepare("insert into payments(id,source,external_id,paid_at,amount,payer_phone,product_name,status,created_at,drop_in,course_id,payer_name) values('w1','KIOSK','e1',?,30000,'','WARM UP','APPROVED','x',1,?,'손님')").run(iso(day - 1, 5), c.id);
  const line = settle(db, '2026-10').find((l) => l.instructorId === ins)!;
  expect(line).toMatchObject({ sessions: 1, heads: 2, instructorPay: 40000 });
});
