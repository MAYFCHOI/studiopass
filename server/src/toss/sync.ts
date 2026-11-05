// 웹훅으로 받은 토스 결제를 적재하고(processPending), 주기적으로 주문 목록과 대조해 빠진 웹훅을 채운다(reconcile).
// 적재는 ingestPayments 를 그대로 쓴다: 같은 결제 ID 는 중복, 같은 결제의 취소는 수강권 취소(출석에 쓰였으면 확인 필요).
import type { Db } from '../db.js';
import { nowIso } from '../util.js';
import { ingestPayments, type PaymentInput } from '../domain/payments.js';
import type { TossClient, TossOrder, TossPayment } from './client.js';
import { toPaymentInput } from './mapper.js';

type OnPass = Parameters<typeof ingestPayments>[3];
/** 주문 조회가 이만큼 실패하면 상품명 없이(금액으로) 적재한다. 결제를 잃지 않는 게 먼저다. */
export const MAX_ORDER_ATTEMPTS = 5;

const exists = (db: Db, externalId: string) => !!db.prepare('select 1 from payments where external_id=?').get(externalId);

/**
 * 한 결제를 적재한다. 우리 쪽에 승인 기록이 없는 취소는 버린다(승인·취소가 둘 다 빠졌던 결제라 남길 게 없고,
 * 적재하면 원 결제를 못 찾은 환불로 확인 필요에 올라 데스크만 헷갈린다).
 */
export function ingestToss(db: Db, payment: TossPayment, order: TossOrder | null, onPass?: OnPass) {
  const input = toPaymentInput(db, payment, order);
  if (!input) return 'SKIPPED' as const;
  if (input.status === 'CANCELLED' && !exists(db, input.externalId!)) return 'SKIPPED' as const;
  const r = ingestPayments(db, [input as PaymentInput], null, onPass);
  return r.added ? 'ADDED' as const : r.cancelled ? 'CANCELLED' as const : r.cancelFailed ? 'CANCEL_FAILED' as const : 'DUP' as const;
}

type EventRow = { webhook_id: string; payload: string; attempts: number };

/** 대기 중인 웹훅을 처리한다. 승인 결제는 상품명을 위해 주문을 조회하고, 조회가 계속 실패하면 주문 없이 적재한다. */
export async function processPending(db: Db, client: TossClient, onPass?: OnPass) {
  const rows = db.prepare("select webhook_id, payload, attempts from toss_events where status='PENDING' order by webhook_id limit 50").all() as EventRow[];
  let done = 0, retry = 0;
  for (const e of rows) {
    const payment = JSON.parse(e.payload) as TossPayment;
    let order: TossOrder | null = null;
    if (payment.state === 'APPROVED' && !exists(db, 'toss:' + payment.id)) {
      try { order = await client.getOrder(payment.orderId); } catch (err) {
        const attempts = e.attempts + 1;
        if (attempts < MAX_ORDER_ATTEMPTS) {
          db.prepare('update toss_events set attempts=?, last_error=? where webhook_id=?').run(attempts, String((err as Error).message).slice(0, 200), e.webhook_id);
          retry++;
          continue;
        }
      }
    }
    const result = ingestToss(db, payment, order, onPass);
    db.prepare("update toss_events set status='DONE', attempts=attempts+1, last_error=?, processed_at=? where webhook_id=?").run(order || payment.state !== 'APPROVED' ? null : 'NO_ORDER', nowIso(), e.webhook_id);
    if (result !== 'SKIPPED') done++;
  }
  return { done, retry, stuck: (db.prepare("select count(*) n from toss_events where status='PENDING' and attempts>=3").get() as { n: number }).n };
}

/** from~to 사이에 결제가 바뀐 주문을 모두 훑어 적재한다(이미 있는 결제는 중복으로 지나간다). */
export async function reconcile(db: Db, client: TossClient, from: Date, to: Date, onPass?: OnPass) {
  const counts = { orders: 0, added: 0, cancelled: 0, cancelFailed: 0 };
  for (let page = 1; page <= 50; page++) {
    const orders = await client.listOrders(from.toISOString(), to.toISOString(), page);
    for (const o of orders) {
      counts.orders++;
      for (const p of o.payments ?? []) {
        const r = ingestToss(db, p, o, onPass);
        if (r === 'ADDED') counts.added++; else if (r === 'CANCELLED') counts.cancelled++; else if (r === 'CANCEL_FAILED') counts.cancelFailed++;
      }
    }
    if (orders.length < 100) break;
  }
  return counts;
}

/**
 * 열린 문제 목록을 들고 있다가 생기면 [ISSUE], 풀리면 [RESOLVED] 를 남은 건수와 함께 보낸다.
 * 본문에 키·금액·이름을 넣지 않는다(공개 ntfy 서버를 거친다).
 */
export function issueTracker(send: (title: string, body: string) => void) {
  const open = new Set<string>();
  return (key: string, bad: boolean, text: string) => {
    if (bad && !open.has(key)) { open.add(key); send('[ISSUE] studiopass', `${text} (미해결 ${open.size}건)`); }
    else if (!bad && open.has(key)) { open.delete(key); send('[RESOLVED] studiopass', `${text} 정상화 (미해결 ${open.size}건)`); }
  };
}
export function ntfySender(topic: string, fetchImpl: typeof fetch = fetch) {
  return (title: string, body: string) => {
    if (!topic) return;
    fetchImpl(`https://ntfy.sh/${topic}`, { method: 'POST', headers: { Title: title }, body, signal: AbortSignal.timeout(10_000) }).catch(() => {});
  };
}
