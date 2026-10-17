// server/test/payments.test.ts
import { describe, it, expect } from 'vitest';
import { makeDb } from './fixtures.js';
import { ingestPayments, assignPayment, cancelPayment, PassInUseError } from '../src/domain/payments.js';
import { attend } from '../src/domain/attendance.js';
const row = (o: any = {}) => ({ source: 'KIOSK' as const, externalId: '30000001', paidAt: '2026-10-19T09:12:00Z', amount: 180000, payerName: '김서연', payerPhone: '010-1111-2222', productName: '정규 클래스 8회권', ...o });
describe('payments', () => {
  it('dedupes by approval number, matches phone, creates pass from product', () => {
    const { db, member } = makeDb(); const m = member('김서연', '01011112222');
    expect(ingestPayments(db, [row(), row()], null)).toEqual({ added: 1, dup: 1, matched: 1 });
    expect(ingestPayments(db, [row()], null)).toEqual({ added: 0, dup: 1, matched: 0 });
    const p = db.prepare('select * from passes where member_id=?').get(m) as any;
    expect(p).toMatchObject({ kind: 'COUNT', total_count: 8, remaining: 8, valid_from: '2026-10-19', valid_to: '2026-12-18', price: 180000 });
  });
  it('dedupes rows without approval number by phone+time+amount', () => {
    const { db } = makeDb();
    expect(ingestPayments(db, [row({ externalId: null }), row({ externalId: null })], null)).toMatchObject({ added: 1, dup: 1 });
  });
  it('leaves unmatched payments for manual assignment', () => {
    const { db, member } = makeDb(); const m = member('신예은', '01099998888');
    ingestPayments(db, [row({ payerPhone: '' })], null);
    const pay = db.prepare('select id, member_id from payments').get() as any;
    expect(pay.member_id).toBeNull();
    expect(assignPayment(db, pay.id, m, 'st').passId).toBeTruthy();
    expect(assignPayment(db, pay.id, m, 'st').passId).toBeNull(); // 두 번째는 아무것도 안 만든다
    expect((db.prepare('select count(*) n from passes').get() as any).n).toBe(1);
  });
  it('unknown product name keeps payment but creates no pass', () => {
    const { db, member } = makeDb(); member();
    ingestPayments(db, [row({ productName: '음료' })], null);
    expect((db.prepare('select count(*) n from passes').get() as any).n).toBe(0);
    expect((db.prepare('select member_id from payments').get() as any).member_id).toBeTruthy();
  });
  it('refuses to cancel a payment whose pass was used', () => {
    const { db, member, course } = makeDb(); const m = member(); ingestPayments(db, [row()], null);
    const pay = db.prepare('select id from payments').get() as any;
    attend(db, { memberId: m, courseId: course().id, staffId: null, now: new Date('2026-10-19T10:30:00Z') });
    expect(() => cancelPayment(db, pay.id, 'st')).toThrow(PassInUseError);
    expect((db.prepare('select status from payments').get() as any).status).toBe('APPROVED');
  });
  it('cancels an unused payment and removes its pass', () => {
    const { db, member } = makeDb(); member(); ingestPayments(db, [row()], null);
    const pay = db.prepare('select id from payments').get() as any;
    cancelPayment(db, pay.id, 'st');
    expect((db.prepare('select status from payments').get() as any).status).toBe('CANCELLED');
    expect((db.prepare('select count(*) n from passes').get() as any).n).toBe(0);
  });
  it('does not auto-assign when two members share the phone', () => {
    const { db, member } = makeDb(); member('가', '01011112222'); member('나', '01011112222');
    expect(ingestPayments(db, [row()], null).matched).toBe(0);
  });
  it('blank product name creates no pass', () => {
    const { db, member } = makeDb(); member();
    ingestPayments(db, [row({ productName: '' }), row({ externalId: '2', productName: '  ' })], null);
    expect((db.prepare('select count(*) n from passes').get() as any).n).toBe(0);
  });
  it('matches kiosk name with suffix to the product', () => {
    const { db, member } = makeDb(); member();
    ingestPayments(db, [row({ productName: '정규 클래스 8회권 (카드)' })], null);
    expect((db.prepare('select total_count c from passes').get() as any).c).toBe(8);
  });
  it('short name matches nothing', () => {
    const { db, member } = makeDb(); member();
    ingestPayments(db, [row({ productName: '회권' })], null);
    expect((db.prepare('select count(*) n from passes').get() as any).n).toBe(0);
  });
  it('cancelling twice writes one audit row', () => {
    const { db, member } = makeDb(); member(); ingestPayments(db, [row()], null);
    const pay = db.prepare('select id from payments').get() as any;
    cancelPayment(db, pay.id, 'st'); cancelPayment(db, pay.id, 'st');
    expect((db.prepare("select count(*) n from audit_log where action='payment.cancel'").get() as any).n).toBe(1);
  });
});
