import { Hono } from 'hono';
import { newId, nowIso, normalizePhone } from '../util.js';
import { audit } from '../audit.js';
import { type PaymentInput, ingestPayments, assignPayment, cancelPayment, linkRefund, clearReview, revertBatch, PassInUseError, AssignError } from '../domain/payments.js';
import { idemKey, idemGet, idemPut } from '../idempotency.js';
import { toPayment } from '../serialize.js';
import { passNotifier } from '../notify/link.js';
import { type AppEnv, type Deps, clock, body, bad, notFound, str, optStr, num, maxLen, LIMITS, ownerOnly, clientIp } from './common.js';

const isErased = (db: any, id: string) => !!(db.prepare('select erased_at from members where id=?').get(id) as { erased_at: string | null } | undefined)?.erased_at;

const MAX_ROWS = 2000;
const MAX_REJECTED = 50;
/** 한 행의 문제(없으면 null). 문제 있는 행만 빼고 나머지는 적재한다. */
export function rowProblem(r: any): string | null {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return 'BAD_ROW';
  if (r.source !== 'KIOSK' && r.source !== 'MANUAL') return 'BAD_ROW';
  if (!str(r.paidAt) || Number.isNaN(Date.parse(r.paidAt))) return 'BAD_DATE';
  if (!num(r.amount)) return 'BAD_AMOUNT';
  if (!str(r.productName)) return 'NO_PRODUCT';
  if (!maxLen(r.productName, LIMITS.productName)) return 'PRODUCT_TOO_LONG';
  if (!optStr(r.externalId) || !maxLen(r.externalId, 100)) return 'ID_TOO_LONG';
  if (!optStr(r.payerName) || !maxLen(r.payerName, LIMITS.payerName)) return 'NAME_TOO_LONG';
  if (!(optStr(r.payerPhone) || typeof r.payerPhone === 'number') || String(r.payerPhone ?? '').length > 30) return 'BAD_PHONE';
  if (r.status !== undefined && r.status !== 'APPROVED' && r.status !== 'CANCELLED') return 'BAD_STATUS';
  return null;
}
const BATCH = /^[A-Za-z0-9_-]{8,40}$/;

export function paymentRoutes(d: Deps) {
  const r = new Hono<AppEnv>(); const db = d.db; const onPass = passNotifier(d);

  // 행마다 검사해 문제 없는 행만 적재하고, 문제 행은 rejected 로 돌려준다(index = 이 요청 rows 안의 순번, 최대 50개).
  // batchId(선택): 한 업로드를 여러 요청으로 나눠 보낼 때 같은 값을 보내면 한 묶음으로 되돌릴 수 있다.
  r.post('/payments/import', async (c) => {
    const b = await body(c);
    if (!b || !Array.isArray(b.rows) || (b.batchId !== undefined && !(typeof b.batchId === 'string' && BATCH.test(b.batchId)))) return bad(c);
    if (b.rows.length > MAX_ROWS) return c.json({ error: 'TOO_MANY' }, 413);
    const good: PaymentInput[] = []; const rejected: { index: number; reason: string }[] = []; let rejectedCount = 0;
    b.rows.forEach((row: unknown, index: number) => {
      const why = rowProblem(row);
      if (!why) { good.push(row as PaymentInput); return; }
      rejectedCount++;
      if (rejected.length < MAX_REJECTED) rejected.push({ index, reason: why });
    });
    const res = ingestPayments(db, good, c.get('me').staffId, onPass, { batchId: b.batchId });
    return c.json({ ...res, rejected, rejectedCount });
  });

  // 잘못 올린 업로드 묶음 되돌리기(원장). 출석에 쓰인 수강권의 결제는 남긴다.
  r.post('/payments/import-batches/:id/revert', ownerOnly, (c) => {
    const id = c.req.param('id');
    if (!BATCH.test(id)) return bad(c);
    return c.json(revertBatch(db, id, c.get('me').staffId));
  });

  // Manual single entry. Linked to memberId when given, otherwise to the only member with the payer's phone (same rule as import).
  r.post('/payments', async (c) => {
    const b = await body(c);
    if (!b || !num(b.amount) || !str(b.productName) || !maxLen(b.productName, LIMITS.productName) || !optStr(b.payerName) || !maxLen(b.payerName, LIMITS.payerName) || !optStr(b.payerPhone) || !optStr(b.memberId) || (b.paidAt !== undefined && !(str(b.paidAt) && !Number.isNaN(Date.parse(b.paidAt))))) return bad(c);
    if (b.memberId && !db.prepare('select 1 from members where id=?').get(b.memberId)) return notFound(c);
    if (b.memberId && isErased(db, b.memberId)) return c.json({ error: 'ERASED' }, 409);
    const staffId = c.get('me').staffId; const phone = normalizePhone(b.payerPhone);
    // 같은 Idempotency-Key 로 다시 오면(두 번 누름, 응답을 못 받고 다시 보냄) 처음 만든 결제를 그대로 돌려준다.
    const key = idemKey(c); const hit = idemGet(db, key, staffId, 'payments');
    if (hit) return c.json(hit.body as object, hit.status as 200);
    const id = db.transaction(() => {
      const id = newId();
      db.prepare('insert into payments(id,source,external_id,paid_at,amount,payer_name,payer_phone,product_name,status,created_by,created_at) values(?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, 'MANUAL', null, b.paidAt ? new Date(b.paidAt).toISOString() : nowIso(clock(d)), Math.round(b.amount), b.payerName ?? null, phone, b.productName, 'APPROVED', staffId, nowIso());
      audit(db, staffId, 'payment.manual', 'payment', id);
      let memberId: string | undefined = b.memberId ?? undefined;
      if (!memberId && phone) { const m = db.prepare('select id from members where phone=?').all(phone) as { id: string }[]; if (m.length === 1) memberId = m[0].id; }
      if (memberId) assignPayment(db, id, memberId, staffId, onPass);
      idemPut(db, key, staffId, 'payments', 200, toPayment(db.prepare('select * from payments where id=?').get(id), c.get('me').role));
      return id;
    })();
    return c.json(toPayment(db.prepare('select * from payments where id=?').get(id), c.get('me').role));
  });

  r.post('/payments/:id/assign', async (c) => {
    const b = await body(c); const id = c.req.param('id');
    if (!b || !str(b.memberId)) return bad(c);
    if (!db.prepare('select 1 from payments where id=?').get(id) || !db.prepare('select 1 from members where id=?').get(b.memberId)) return notFound(c);
    if (isErased(db, b.memberId)) return c.json({ error: 'ERASED' }, 409);
    try { return c.json(assignPayment(db, id, b.memberId, c.get('me').staffId, onPass)); } catch (e) {
      if (e instanceof AssignError) return c.json({ error: e.code }, 409);
      if (e instanceof PassInUseError) return c.json({ error: 'PASS_IN_USE', used: e.used }, 409);
      throw e;
    }
  });

  // 원 결제를 찾지 못한 환불 행에 원 결제를 고른다(원 결제 취소).
  r.post('/payments/:id/refund-of', async (c) => {
    const b = await body(c); const id = c.req.param('id');
    if (!b || !str(b.originalId)) return bad(c);
    try {
      const r = linkRefund(db, id, b.originalId, c.get('me').staffId);
      if (r !== 'OK') return c.json({ error: r }, r === 'NOT_REFUND' && !db.prepare('select 1 from payments where id=?').get(id) ? 404 : 409);
    } catch (e) {
      if (e instanceof PassInUseError) return c.json({ error: 'PASS_IN_USE', used: e.used }, 409);
      throw e;
    }
    return c.json({ ok: true });
  });

  // 확인 필요 표시 지우기(사람이 확인함).
  r.post('/payments/:id/review-clear', (c) => {
    const id = c.req.param('id');
    if (!db.prepare('select 1 from payments where id=?').get(id)) return notFound(c);
    clearReview(db, id, c.get('me').staffId);
    return c.json({ ok: true });
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
