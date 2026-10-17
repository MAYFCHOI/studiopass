// server/src/domain/payments.ts
import type { Db } from '../db.js';
import { newId, nowIso, kstDate, addDays, normalizePhone } from '../util.js';
import { audit } from '../audit.js';
export type PaymentInput = { source: 'KIOSK' | 'MANUAL'; externalId?: string | null; paidAt: string; amount: number; payerName?: string | null; payerPhone?: string | null; productName: string; status?: 'APPROVED' | 'CANCELLED'; raw?: unknown };
type ProductRow = { id: string; name: string; course_id: string | null; pass_kind: 'COUNT' | 'PERIOD'; count: number; period_days: number };
export class PassInUseError extends Error { constructor(public used: number) { super(`pass used ${used} times`); } }
export function findProduct(db: Db, name: string) {
  const all = db.prepare('select id,name,course_id,pass_kind,count,period_days from products where active=1').all() as ProductRow[];
  const n = (name ?? '').trim();
  if (!n) return undefined;
  const exact = all.find((p) => p.name.trim() === n);
  if (exact) return exact;
  return all.filter((p) => p.name.trim() && n.includes(p.name.trim())).sort((a, b) => b.name.length - a.name.length)[0];
}
function createPass(db: Db, paymentId: string, memberId: string, productName: string, paidAt: string, amount: number) {
  const prod = findProduct(db, productName); if (!prod) return null;
  const from = kstDate(new Date(paidAt)); const id = newId();
  db.prepare('insert into passes(id,member_id,product_id,course_id,kind,total_count,remaining,valid_from,valid_to,payment_id,price,created_at) values(?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, memberId, prod.id, prod.course_id, prod.pass_kind, prod.count, prod.count, from, addDays(from, prod.period_days), paymentId, amount, nowIso());
  return id;
}
export function assignPayment(db: Db, paymentId: string, memberId: string, staffId: string | null) {
  return db.transaction(() => {
    const p = db.prepare('select * from payments where id=?').get(paymentId) as any;
    if (!p || p.pass_id || p.status !== 'APPROVED') return { passId: null };
    const passId = createPass(db, p.id, memberId, p.product_name, p.paid_at, p.amount);
    db.prepare('update payments set member_id=?, pass_id=? where id=?').run(memberId, passId, p.id);
    audit(db, staffId, 'payment.assign', 'payment', p.id, { memberId, passId });
    return { passId };
  })();
}
export function ingestPayments(db: Db, rows: PaymentInput[], staffId: string | null) {
  return db.transaction(() => {
    let added = 0, dup = 0, matched = 0;
    const seen = new Set<string>();
    for (const r of rows) {
      const phone = normalizePhone(r.payerPhone);
      const key = r.externalId ? 'x:' + r.externalId : `k:${phone}|${r.paidAt}|${r.amount}`;
      const exists = seen.has(key) || (r.externalId
        ? db.prepare('select 1 from payments where external_id=?').get(r.externalId)
        : db.prepare('select 1 from payments where external_id is null and payer_phone=? and paid_at=? and amount=?').get(phone, r.paidAt, r.amount));
      if (exists) { dup++; continue; }
      seen.add(key);
      const id = newId();
      db.prepare('insert into payments(id,source,external_id,paid_at,amount,payer_name,payer_phone,product_name,status,raw_json,created_by,created_at) values(?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, r.source, r.externalId ?? null, r.paidAt, Math.round(r.amount), r.payerName ?? null, phone, r.productName, r.status ?? 'APPROVED', r.raw === undefined ? null : JSON.stringify(r.raw), staffId, nowIso());
      added++;
      if ((r.status ?? 'APPROVED') !== 'APPROVED' || !phone) continue;
      const m = db.prepare('select id from members where phone=?').all(phone) as { id: string }[];
      if (m.length === 1) { assignPayment(db, id, m[0].id, staffId); matched++; }
    }
    return { added, dup, matched };
  })();
}
export function cancelPayment(db: Db, paymentId: string, staffId: string | null) {
  db.transaction(() => {
    const p = db.prepare('select id, pass_id, status from payments where id=?').get(paymentId) as { id: string; pass_id: string | null; status: string } | undefined;
    if (!p || p.status === 'CANCELLED') return;
    if (p.pass_id) {
      const used = (db.prepare('select count(*) n from attendances where pass_id=? and cancelled_at is null').get(p.pass_id) as { n: number }).n;
      if (used > 0) throw new PassInUseError(used);
      db.prepare('delete from attendances where pass_id=?').run(p.pass_id);
      db.prepare('delete from passes where id=?').run(p.pass_id);
    }
    db.prepare("update payments set status='CANCELLED', pass_id=null where id=?").run(p.id);
    audit(db, staffId, 'payment.cancel', 'payment', p.id);
  })();
}
