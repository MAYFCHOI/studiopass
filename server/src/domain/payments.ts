// server/src/domain/payments.ts
import type { Db } from '../db.js';
import { newId, nowIso, kstDate, addDays, normalizePhone } from '../util.js';
import { audit } from '../audit.js';
export type PaymentInput = { source: 'KIOSK' | 'MANUAL'; externalId?: string | null; paidAt: string; amount: number; payerName?: string | null; payerPhone?: string | null; productName: string; status?: 'APPROVED' | 'CANCELLED' };
type ProductRow = { id: string; name: string; course_id: string | null; pass_kind: 'COUNT' | 'PERIOD'; count: number; period_days: number };
type OnPass = (memberId: string, passId: string, staffId: string | null) => void;
export class PassInUseError extends Error { constructor(public used: number) { super(`pass used ${used} times`); } }
/** 연결할 수 없는 결제: 취소된 결제(PAYMENT_CANCELLED). 출석에 쓰인 수강권을 다른 회원으로 옮기려 하면 PassInUseError. */
export class AssignError extends Error { constructor(public code: 'PAYMENT_CANCELLED') { super(code); } }
/** 환불 행이 원 결제를 찾는 기간(일). */
export const REFUND_MATCH_DAYS = 30;

const squash = (s: string) => (s ?? '').replace(/\s+/g, '');
export function findProduct(db: Db, name: string) {
  const all = db.prepare('select id,name,course_id,pass_kind,count,period_days from products where active=1').all() as ProductRow[];
  const n = squash(name);
  if (!n) return undefined;
  // 띄어쓰기만 다른 이름("정규 클래스  1회권" / "정규클래스 1회권")은 같은 상품으로 본다.
  const exact = all.find((p) => squash(p.name) === n);
  if (exact) return exact;
  return all.filter((p) => squash(p.name) && n.includes(squash(p.name))).sort((a, b) => squash(b.name).length - squash(a.name).length)[0];
}
function createPass(db: Db, paymentId: string, memberId: string, productName: string, paidAt: string, amount: number) {
  const prod = findProduct(db, productName); if (!prod) return null;
  const from = kstDate(new Date(paidAt)); const id = newId();
  db.prepare('insert into passes(id,member_id,product_id,course_id,kind,total_count,remaining,valid_from,valid_to,payment_id,price,created_at) values(?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, memberId, prod.id, prod.course_id, prod.pass_kind, prod.count, prod.count, from, addDays(from, prod.period_days), paymentId, amount, nowIso());
  return id;
}
const usedCount = (db: Db, passId: string) => (db.prepare('select count(*) n from attendances where pass_id=? and cancelled_at is null').get(passId) as { n: number }).n;

/**
 * 결제를 회원에게 연결하고 수강권을 만든다. onPass 는 수강권이 새로 생기거나 다른 회원에게 옮겨졌을 때 불린다
 * (트랜잭션 안에서 불리므로 부작용은 호출 쪽이 미뤄야 한다).
 * - 이미 같은 회원 수강권이 있으면 그대로 돌려준다(두 번 눌러도 하나).
 * - 다른 회원으로 바꾸면 수강권을 새 회원에게 옮긴다. 출석에 쓰인 수강권이면 PassInUseError.
 * - 취소된 결제는 AssignError('PAYMENT_CANCELLED').
 */
export function assignPayment(db: Db, paymentId: string, memberId: string, staffId: string | null, onPass?: OnPass) {
  return db.transaction((): { passId: string | null; moved?: boolean } => {
    const p = db.prepare('select * from payments where id=?').get(paymentId) as any;
    if (!p) return { passId: null };
    if (p.status !== 'APPROVED') throw new AssignError('PAYMENT_CANCELLED');
    if (p.pass_id) {
      if (p.member_id === memberId) return { passId: p.pass_id };
      const used = usedCount(db, p.pass_id);
      if (used > 0) throw new PassInUseError(used);
      db.prepare('update passes set member_id=? where id=?').run(memberId, p.pass_id);
      db.prepare('update payments set member_id=? where id=?').run(memberId, p.id);
      audit(db, staffId, 'payment.reassign', 'payment', p.id, { from: p.member_id, to: memberId, passId: p.pass_id });
      onPass?.(memberId, p.pass_id, staffId);
      return { passId: p.pass_id, moved: true };
    }
    const passId = createPass(db, p.id, memberId, p.product_name, p.paid_at, p.amount);
    db.prepare('update payments set member_id=?, pass_id=? where id=?').run(memberId, passId, p.id);
    audit(db, staffId, 'payment.assign', 'payment', p.id, { memberId, passId });
    if (passId) onPass?.(memberId, passId, staffId);
    return { passId };
  })();
}

export type IngestResult = { added: number; dup: number; matched: number; cancelled: number; cancelFailed: number; refundUnmatched: number; refundSuggested: number; batchId: string; dupBatches: { batchId: string; count: number }[] };

/**
 * 키오스크 행 적재. 같은 승인번호가 다시 오면 중복으로 센다. 단, 나중 행이 취소(환불)이고 저장된 결제가 승인 상태면
 * 그 결제를 취소한다(cancelled). 수강권이 이미 출석에 쓰였으면 승인 상태로 두고 cancelFailed 로 세며 확인 필요(REFUND_IN_USE)에 올린다.
 * 승인번호가 다른 환불 행은 자동으로 취소하지 않는다(가족이 번호를 같이 쓰면 남의 수강권을 지울 수 있고, 취소는 되돌릴 수 없다).
 * 같은 전화·금액·상품의 30일 안 승인 결제 중 후보가 하나로 좁혀지면 REFUND_SUGGESTED(refund_suggested_of)로,
 * 아니면 REFUND_UNMATCHED 로 확인 필요에 올린다. 사람이 linkRefund 로 확정한다.
 */
export function ingestPayments(db: Db, rows: PaymentInput[], staffId: string | null, onPass?: OnPass, opts: { batchId?: string } = {}) {
  const batchId = opts.batchId ?? newId();
  return db.transaction((): IngestResult => {
    let added = 0, dup = 0, matched = 0, cancelled = 0, cancelFailed = 0, refundUnmatched = 0, refundSuggested = 0;
    const seen = new Set<string>();
    const dupBatches = new Map<string, number>();
    const refunds: { id: string; phone: string; r: PaymentInput }[] = [];
    const extIds = new Map<string, number>();
    for (const r of rows) if (r.externalId) extIds.set(r.externalId, (extIds.get(r.externalId) ?? 0) + 1);
    const markInUse = (id: string) => db.prepare("update payments set review='REFUND_IN_USE' where id=?").run(id);
    for (const r of rows) {
      const phone = normalizePhone(r.payerPhone);
      const key = r.externalId ? 'x:' + r.externalId : `k:${phone}|${r.paidAt}|${r.amount}`;
      const existing = r.externalId
        ? db.prepare('select id, import_batch_id from payments where external_id=?').get(r.externalId)
        : db.prepare('select id, import_batch_id from payments where external_id is null and payer_phone=? and paid_at=? and amount=?').get(phone, r.paidAt, r.amount);
      if (seen.has(key) || existing) {
        const stored = r.status === 'CANCELLED' && r.externalId
          ? db.prepare("select id from payments where external_id=? and status='APPROVED'").get(r.externalId) as { id: string } | undefined
          : undefined;
        if (!stored) {
          dup++;
          const b = (existing as { import_batch_id: string | null } | undefined)?.import_batch_id;
          if (b && b !== batchId) dupBatches.set(b, (dupBatches.get(b) ?? 0) + 1);
          continue;
        }
        try { cancelPayment(db, stored.id, staffId); cancelled++; } catch (e) {
          if (!(e instanceof PassInUseError)) throw e;
          markInUse(stored.id); cancelFailed++;
        }
        continue;
      }
      seen.add(key);
      const id = newId();
      // Only the whitelisted fields above are stored; a client-sent raw kiosk row is ignored (raw_json stays null).
      db.prepare('insert into payments(id,source,external_id,paid_at,amount,payer_name,payer_phone,product_name,status,created_by,created_at,import_batch_id) values(?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, r.source, r.externalId ?? null, r.paidAt, Math.round(r.amount), r.payerName ?? null, phone, r.productName, r.status ?? 'APPROVED', staffId, nowIso(), batchId);
      added++;
      // A refund whose approval number appears only once in this file is matched after every approval row is in.
      if (r.status === 'CANCELLED') { if (!r.externalId || extIds.get(r.externalId) === 1) refunds.push({ id, phone, r }); continue; }
      if (!phone) continue;
      const m = db.prepare('select id from members where phone=? and erased_at is null').all(phone) as { id: string }[];
      if (m.length === 1) { assignPayment(db, id, m[0].id, staffId, onPass); matched++; }
    }
    for (const f of refunds) {
      const cands = f.phone ? db.prepare(`select id, pass_id, member_id, payer_name from payments where status='APPROVED' and payer_phone=? and amount=? and product_name=? and id<>?
          and julianday(paid_at) between julianday(?) - ? and julianday(?) and id not in (select refund_of from payments where refund_of is not null) order by paid_at desc`)
        .all(f.phone, Math.round(f.r.amount), f.r.productName, f.id, f.r.paidAt, REFUND_MATCH_DAYS, f.r.paidAt) as { id: string; pass_id: string | null; member_id: string | null; payer_name: string | null }[] : [];
      const pick = suggestOriginal(db, cands, f.r.payerName);
      if (pick) {
        db.prepare("update payments set review='REFUND_SUGGESTED', refund_suggested_of=? where id=?").run(pick, f.id);
        refundSuggested++;
      } else {
        db.prepare("update payments set review='REFUND_UNMATCHED' where id=?").run(f.id);
        refundUnmatched++;
      }
    }
    return { added, dup, matched, cancelled, cancelFailed, refundUnmatched, refundSuggested, batchId, dupBatches: [...dupBatches].map(([batchId, count]) => ({ batchId, count })).sort((a, b) => b.count - a.count) };
  })();
}
/**
 * 환불 행의 원 결제 후보를 하나로 좁힌다(없으면 null). 후보(최근 순) 중 출석 없는 것을 먼저 보고, 없으면 전부를 본다.
 * 그 후보가 모두 한 회원(또는 모두 미연결) 것이면 가장 최근 것, 여러 회원이면 결제자 이름이 환불 행과 같은 것이 정확히 하나일 때 그것.
 */
function suggestOriginal(db: Db, cands: { id: string; pass_id: string | null; member_id: string | null; payer_name: string | null }[], payerName?: string | null) {
  if (!cands.length) return null;
  const free = cands.filter((x) => !x.pass_id || usedCount(db, x.pass_id) === 0);
  const pool = free.length ? free : cands;
  if (new Set(pool.map((x) => x.member_id ?? '')).size === 1) return pool[0].id;
  const name = (payerName ?? '').trim();
  const same = name ? pool.filter((x) => (x.payer_name ?? '').trim() === name) : [];
  return same.length === 1 ? same[0].id : null;
}
export function cancelPayment(db: Db, paymentId: string, staffId: string | null) {
  db.transaction(() => {
    const p = db.prepare('select id, pass_id, status from payments where id=?').get(paymentId) as { id: string; pass_id: string | null; status: string } | undefined;
    if (!p || p.status === 'CANCELLED') return;
    if (p.pass_id) {
      const used = usedCount(db, p.pass_id);
      if (used > 0) throw new PassInUseError(used);
      db.prepare('delete from attendances where pass_id=?').run(p.pass_id);
      db.prepare('delete from passes where id=?').run(p.pass_id);
    }
    db.prepare("update payments set status='CANCELLED', pass_id=null, review=null where id=?").run(p.id);
    audit(db, staffId, 'payment.cancel', 'payment', p.id);
  })();
}
/**
 * 확인 필요의 환불 행(REFUND_UNMATCHED / REFUND_SUGGESTED, 아직 원 결제 없음)에 원 결제를 확정한다: 원 결제를 취소하고 표시를 지운다.
 * 사람이 고른 원 결제만 취소된다(제안은 제안일 뿐).
 */
export function linkRefund(db: Db, refundId: string, originalId: string, staffId: string | null) {
  return db.transaction((): 'OK' | 'NOT_FOUND' | 'NOT_REFUND' | 'NOT_APPROVED' => {
    const f = db.prepare('select status, review, refund_of from payments where id=?').get(refundId) as { status: string; review: string | null; refund_of: string | null } | undefined;
    const o = db.prepare('select status from payments where id=?').get(originalId) as { status: string } | undefined;
    if (!f) return 'NOT_FOUND';
    if (f.status !== 'CANCELLED' || (f.review !== 'REFUND_UNMATCHED' && f.review !== 'REFUND_SUGGESTED') || f.refund_of) return 'NOT_REFUND';
    if (!o || o.status !== 'APPROVED') return 'NOT_APPROVED';
    cancelPayment(db, originalId, staffId); // PassInUseError goes to the caller
    db.prepare('update payments set review=null, refund_of=?, refund_suggested_of=null where id=?').run(originalId, refundId);
    audit(db, staffId, 'payment.refund_link', 'payment', refundId, { originalId });
    return 'OK';
  })();
}
export function clearReview(db: Db, paymentId: string, staffId: string | null) {
  const n = db.prepare('update payments set review=null where id=? and review is not null').run(paymentId).changes;
  if (n) audit(db, staffId, 'payment.review_clear', 'payment', paymentId);
  return n > 0;
}
/**
 * 잘못 올린 업로드 묶음 되돌리기: 그 묶음으로 들어온 결제와 그 수강권을 지운다(같은 파일을 고친 매핑으로 다시 올릴 수 있게).
 * 출석에 쓰인 수강권의 결제는 남기고 kept 로 센다.
 */
export function revertBatch(db: Db, batchId: string, staffId: string | null) {
  return db.transaction((): { removed: number; kept: number } | { error: 'REFUND_LINKED'; count: number } => {
    // 이 묶음의 환불 행으로 이미 취소된 원 결제가 있으면 되돌리지 않는다(지운 수강권은 다시 만들 수 없다).
    const linked = (db.prepare("select count(*) n from payments f join payments o on o.id=f.refund_of where f.import_batch_id=? and o.status='CANCELLED'").get(batchId) as { n: number }).n;
    if (linked > 0) return { error: 'REFUND_LINKED', count: linked };
    const rows = db.prepare('select id, pass_id from payments where import_batch_id=?').all(batchId) as { id: string; pass_id: string | null }[];
    let removed = 0, kept = 0;
    for (const p of rows) {
      if (p.pass_id && usedCount(db, p.pass_id) > 0) { kept++; continue; }
      if (p.pass_id) { db.prepare('delete from attendances where pass_id=?').run(p.pass_id); db.prepare('delete from passes where id=?').run(p.pass_id); }
      db.prepare('update payments set refund_of=null where refund_of=?').run(p.id);
      db.prepare("update payments set refund_suggested_of=null, review=case when review='REFUND_SUGGESTED' then 'REFUND_UNMATCHED' else review end where refund_suggested_of=?").run(p.id);
      db.prepare('delete from payments where id=?').run(p.id);
      removed++;
    }
    if (rows.length) audit(db, staffId, 'payment.import_revert', 'import_batch', batchId, { removed, kept });
    return { removed, kept };
  })();
}
