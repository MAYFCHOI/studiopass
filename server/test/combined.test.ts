import { it, expect } from 'vitest';
import { makeDb } from './fixtures.js';
import { ingestPayments, cancelPayment, assignPayment, repairCombinedPayments, splitAmount, comboAmounts, PassInUseError } from '../src/domain/payments.js';
import { settle } from '../src/domain/settlement.js';
const row = (externalId: string, productName: string, amount: number) => ({ source: 'KIOSK' as const, externalId, paidAt: '2026-11-12T10:08:00Z', amount, payerName: 'x', payerPhone: '01077778888', productName });
const passesOf = (db: any, paymentId: string) => db.prepare('select product_id, price, total_count, remaining from passes where payment_id=? order by price').all(paymentId);

it('splits the amount by list price, remainder on the last', () => {
  expect(splitAmount(350000, [150000, 200000])).toEqual([150000, 200000]);
  expect(splitAmount(100000, [1, 1, 1])).toEqual([33333, 33333, 33334]);
  expect(splitAmount(9000, [0, 0])).toEqual([4500, 4500]);
});

it('a kiosk "A + B" payment makes one pass per product, priced by share; cancel and reassign treat them together', () => {
  const { db, member } = makeDb();
  const m = member('유', '01077778888'); const other = member('다른', '01099990000');
  ingestPayments(db, [row('c1', '정규 클래스 4회권 + 정규 클래스 8회권', 280000)], null);
  const pay = db.prepare("select id, pass_id from payments where external_id='c1'").get() as { id: string; pass_id: string };
  expect(pay.pass_id).toBeTruthy();
  expect(passesOf(db, pay.id)).toEqual([
    { product_id: 'p_four', price: 100000, total_count: 4, remaining: 4 },
    { product_id: 'p_eight', price: 180000, total_count: 8, remaining: 8 },
  ]);
  expect(db.prepare('select count(*) n from passes where member_id=?').get(m)).toEqual({ n: 2 });
  assignPayment(db, pay.id, other, null);
  expect(db.prepare('select count(*) n from passes where member_id=?').get(other)).toEqual({ n: 2 });
  // 한 장이라도 출석에 쓰였으면 취소 막힘
  const eight = db.prepare("select id from passes where payment_id=? and product_id='p_eight'").get(pay.id) as { id: string };
  db.prepare("insert into attendances(id,member_id,pass_id,course_id,instructor_id,attended_on,attended_at) select 'a1',?,?,c.id,c.instructor_id,'2026-11-12','2026-11-12T10:00:00Z' from courses c limit 1").run(other, eight.id);
  expect(() => cancelPayment(db, pay.id, null)).toThrow(PassInUseError);
  db.prepare('delete from attendances').run();
  cancelPayment(db, pay.id, null);
  expect(db.prepare('select count(*) n from passes where payment_id=?').get(pay.id)).toEqual({ n: 0 });
});

it('an unknown part or a drop-in part keeps the old single-pass behaviour', () => {
  const { db, member } = makeDb();
  member('유', '01077778888');
  ingestPayments(db, [row('c2', '정규 클래스 4회권 + 없는 상품', 100000)], null);
  const pay = db.prepare("select id from payments where external_id='c2'").get() as { id: string };
  expect(passesOf(db, pay.id)).toEqual([{ product_id: 'p_four', price: 100000, total_count: 4, remaining: 4 }]);
});

it('repairs an old combined payment that made only one pass, once, keeping its attendances and start date', () => {
  const { db, member } = makeDb();
  const m = member('유', '01077778888');
  db.prepare("insert into payments(id,source,external_id,paid_at,amount,payer_phone,product_name,status,created_at,member_id) values('old','KIOSK','o1','2026-11-12T10:08:00Z',280000,'01077778888','정규 클래스 4회권 + 정규 클래스 8회권','APPROVED','2026-11-12T10:08:00Z',?)").run(m);
  db.prepare("insert into passes(id,member_id,product_id,course_id,kind,total_count,remaining,valid_from,valid_to,payment_id,price,created_at) values('keep',?,'p_eight',null,'COUNT',8,5,'2026-10-29','2026-12-28','old',280000,'x')").run(m);
  db.prepare("update payments set pass_id='keep' where id='old'").run();
  expect(repairCombinedPayments(db)).toBe(1);
  expect(repairCombinedPayments(db)).toBe(0);
  expect(db.prepare("select price, remaining, valid_from from passes where id='keep'").get()).toEqual({ price: 180000, remaining: 5, valid_from: '2026-10-29' });
  expect(db.prepare("select product_id, price, remaining, valid_from, member_id from passes where payment_id='old' and id<>'keep'").get()).toEqual({ product_id: 'p_four', price: 100000, remaining: 4, valid_from: '2026-10-29', member_id: m });
  expect(db.prepare("select count(*) n from audit_log where action='payment.split'").get()).toEqual({ n: 1 });
});

it('a combined drop-in payment settles each part to its own class; a part without a class uses the chosen class', () => {
  const { db } = makeDb();
  const cs = db.prepare("select id, instructor_id from courses where kind='GENERAL' limit 2").all() as { id: string; instructor_id: string }[];
  const pr = db.prepare("insert into products(id,name,course_id,pass_kind,count,period_days,price,drop_in) values(?,?,?,'COUNT',1,6,?,1)");
  pr.run('t_a', '(1 TICKET) AAA', cs[0].id, 35000);
  pr.run('t_w', 'WARM UP TRAINING', null, 30000);
  ingestPayments(db, [{ ...row('d1', '(1 TICKET) AAA + WARM UP TRAINING', 65000), payerPhone: '' }], null);
  ingestPayments(db, [{ ...row('d2', '(1 TICKET) AAA + 없는 워크숍', 80000), payerPhone: '' }], null);
  expect(db.prepare("select drop_in from payments where external_id='d1'").get()).toEqual({ drop_in: 1 });
  db.prepare("update payments set course_id=? where external_id='d1'").run(cs[1].id);
  const lines = settle(db, '2026-11');
  const rev = (ins: string) => lines.filter((l) => l.instructorId === ins).reduce((n, l) => n + l.courses.reduce((m, c) => m + c.revenue, 0), 0);
  if (cs[0].instructor_id === cs[1].instructor_id) expect(rev(cs[0].instructor_id)).toBe(35000 + 30000 + 35000);
  else { expect(rev(cs[0].instructor_id)).toBe(35000 + 35000); expect(rev(cs[1].instructor_id)).toBe(30000); }
  expect(comboAmounts(80000, [{ price: 35000 } as any, undefined])).toEqual([35000, 45000]);
});
