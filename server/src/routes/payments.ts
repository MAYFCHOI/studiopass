import { Hono } from 'hono';
import { newId, nowIso, normalizePhone } from '../util.js';
import { audit } from '../audit.js';
import { type PaymentInput, ingestPayments, assignPayment, cancelPayment, PassInUseError } from '../domain/payments.js';
import { toPayment } from '../serialize.js';
import { passNotifier } from '../notify/link.js';
import { type AppEnv, type Deps, clock, body, bad, notFound, str, optStr, num, maxLen, LIMITS, ownerOnly, clientIp } from './common.js';

const isErased = (db: any, id: string) => !!(db.prepare('select erased_at from members where id=?').get(id) as { erased_at: string | null } | undefined)?.erased_at;

const MAX_ROWS = 2000;
const validRow = (r: any): r is PaymentInput => !!r && typeof r === 'object' && (r.source === 'KIOSK' || r.source === 'MANUAL') && str(r.paidAt) && !Number.isNaN(Date.parse(r.paidAt)) && num(r.amount) && str(r.productName) && maxLen(r.productName, LIMITS.productName)
  && optStr(r.externalId) && maxLen(r.externalId, 100) && optStr(r.payerName) && maxLen(r.payerName, LIMITS.payerName) && (optStr(r.payerPhone) || typeof r.payerPhone === 'number') && (r.status === undefined || r.status === 'APPROVED' || r.status === 'CANCELLED');

export function paymentRoutes(d: Deps) {
  const r = new Hono<AppEnv>(); const db = d.db; const onPass = passNotifier(d);

  r.post('/payments/import', async (c) => {
    const b = await body(c);
    if (!b || !Array.isArray(b.rows)) return bad(c);
    if (b.rows.length > MAX_ROWS) return c.json({ error: 'TOO_MANY' }, 413);
    if (!b.rows.every(validRow)) return bad(c);
    return c.json(ingestPayments(db, b.rows, c.get('me').staffId, onPass));
  });

  // Manual single entry. Linked to memberId when given, otherwise to the only member with the payer's phone (same rule as import).
  r.post('/payments', async (c) => {
    const b = await body(c);
    if (!b || !num(b.amount) || !str(b.productName) || !maxLen(b.productName, LIMITS.productName) || !optStr(b.payerName) || !maxLen(b.payerName, LIMITS.payerName) || !optStr(b.payerPhone) || !optStr(b.memberId) || (b.paidAt !== undefined && !(str(b.paidAt) && !Number.isNaN(Date.parse(b.paidAt))))) return bad(c);
    if (b.memberId && !db.prepare('select 1 from members where id=?').get(b.memberId)) return notFound(c);
    if (b.memberId && isErased(db, b.memberId)) return c.json({ error: 'ERASED' }, 409);
    const staffId = c.get('me').staffId; const phone = normalizePhone(b.payerPhone);
    const id = db.transaction(() => {
      const id = newId();
      db.prepare('insert into payments(id,source,external_id,paid_at,amount,payer_name,payer_phone,product_name,status,created_by,created_at) values(?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, 'MANUAL', null, b.paidAt ? new Date(b.paidAt).toISOString() : nowIso(clock(d)), Math.round(b.amount), b.payerName ?? null, phone, b.productName, 'APPROVED', staffId, nowIso());
      audit(db, staffId, 'payment.manual', 'payment', id);
      let memberId: string | undefined = b.memberId ?? undefined;
      if (!memberId && phone) { const m = db.prepare('select id from members where phone=?').all(phone) as { id: string }[]; if (m.length === 1) memberId = m[0].id; }
      if (memberId) assignPayment(db, id, memberId, staffId, onPass);
      return id;
    })();
    return c.json(toPayment(db.prepare('select * from payments where id=?').get(id), c.get('me').role));
  });

  r.post('/payments/:id/assign', async (c) => {
    const b = await body(c); const id = c.req.param('id');
    if (!b || !str(b.memberId)) return bad(c);
    if (!db.prepare('select 1 from payments where id=?').get(id) || !db.prepare('select 1 from members where id=?').get(b.memberId)) return notFound(c);
    if (isErased(db, b.memberId)) return c.json({ error: 'ERASED' }, 409);
    return c.json(assignPayment(db, id, b.memberId, c.get('me').staffId, onPass));
  });

  // 회원과 연결되지 않은 결제의 결제자 이름·전화 파기(금액·상품·일시는 정산·법정 보관용으로 남긴다).
  // 연결된 결제는 회원 정보 삭제(/members/:id/erase)로 지운다.
  r.post('/payments/:id/erase-payer', ownerOnly, (c) => {
    const id = c.req.param('id');
    const p = db.prepare('select member_id from payments where id=?').get(id) as { member_id: string | null } | undefined;
    if (!p) return notFound(c);
    if (p.member_id) return c.json({ error: 'LINKED' }, 409);
    db.transaction(() => {
      db.prepare("update payments set payer_name=null, payer_phone='' where id=?").run(id);
      audit(db, c.get('me').staffId, 'payment.erase_payer', 'payment', id, undefined, clientIp(c));
    })();
    return c.json(toPayment(db.prepare('select * from payments where id=?').get(id), c.get('me').role));
  });

  r.post('/payments/:id/cancel', (c) => {
    const id = c.req.param('id');
    if (!db.prepare('select 1 from payments where id=?').get(id)) return notFound(c);
    try { cancelPayment(db, id, c.get('me').staffId); } catch (e) {
      if (e instanceof PassInUseError) return c.json({ error: 'PASS_IN_USE', used: e.used }, 409);
      throw e;
    }
    return c.json({ ok: true });
  });
  return r;
}
