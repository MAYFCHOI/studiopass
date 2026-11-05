// server/test/toss.test.ts
import { describe, it, expect, vi } from 'vitest';
import { makeDb } from './fixtures.js';
import { createApp } from '../src/app.js';
import { sign, verifySignature } from '../src/toss/signature.js';
import { loadTossConfig } from '../src/toss/config.js';
import { tossTime, productNameFor, toPaymentInput, UNKNOWN_PRODUCT } from '../src/toss/mapper.js';
import { processPending, reconcile, ingestToss, issueTracker, MAX_ORDER_ATTEMPTS } from '../src/toss/sync.js';
import { tossClient, TossApiError, type TossClient, type TossOrder, type TossPayment } from '../src/toss/client.js';
import { assignPayment } from '../src/domain/payments.js';
import { attend } from '../src/domain/attendance.js';

const SECRET = 'whsec-test';
const NOW = Date.parse('2026-10-19T10:30:00Z');
const cfg = loadTossConfig({ SP_TOSS_ACCESS_KEY: 'ak', SP_TOSS_SECRET_KEY: 'sk', SP_TOSS_MERCHANT_ID: '42', SP_TOSS_WEBHOOK_SECRET: SECRET });
const pay = (o: Partial<TossPayment> = {}): TossPayment => ({ id: '640000000000000001', orderId: '620000000000000001', state: 'APPROVED', amount: 180000, approvedNo: '00000001', approvedAt: '2026-10-19T19:12:00', ...o });
const order = (titles: string[], payments: TossPayment[] = [pay()]): TossOrder => ({ id: payments[0]?.orderId ?? 'o', orderState: 'COMPLETED', lineItems: titles.map((t) => ({ item: { title: t }, quantity: 1 })), payments });
const fakeClient = (o: Partial<TossClient> = {}): TossClient => ({ getOrder: vi.fn(async () => order(['정규 클래스 8회권'])), listOrders: vi.fn(async () => []), ...o });

function setup() {
  const f = makeDb(); const onReceived = vi.fn();
  const app = createApp({ db: f.db, secureCookies: false, allowedOrigin: null, now: () => new Date(NOW), toss: { cfg, onReceived } });
  const hook = (event: object, o: { webhookId?: string; secret?: string; ts?: number } = {}) => {
    const raw = JSON.stringify(event); const ts = String(o.ts ?? NOW);
    return app.request('/hooks/toss', { method: 'POST', body: raw, headers: { 'content-type': 'application/json', 'x-toss-webhook-id': o.webhookId ?? 'w1', 'x-toss-timestamp': ts, 'x-toss-signature': sign(o.secret ?? SECRET, ts, raw) } });
  };
  const ev = (type: string, payment: TossPayment, merchantId = 42) => ({ id: 'w', type, createdAt: '2026-10-19T10:12:00Z', merchantId, app: 'studiopass', data: { payment } });
  return { ...f, app, hook, ev, onReceived };
}

describe('toss signature', () => {
  it('matches the example in the Toss Place webhook docs', () => {
    const body = '{"id":"000000000000000000000000","type":"_test.v1","createdAt":"2026-01-01T00:00:00.000Z","merchantId":42,"app":"my-awesome-app","data": {}}';
    const sig = 'v1=0398718113ed9a277320953cd613e4ecad4fed4a6dc843064ec311e14368774e';
    expect(sign('GA1k8THAGeGihd_Z0rW0MqpRTDQGYIktHBfmCWbsZn0', '1767225600000', body)).toBe(sig);
    expect(verifySignature('GA1k8THAGeGihd_Z0rW0MqpRTDQGYIktHBfmCWbsZn0', '1767225600000', body, sig, 1767225600000)).toBe(true);
  });
  it('rejects a stale timestamp, a changed body and a missing header', () => {
    const s = sign(SECRET, String(NOW), '{}');
    expect(verifySignature(SECRET, String(NOW), '{}', s, NOW + 6 * 60_000)).toBe(false);
    expect(verifySignature(SECRET, String(NOW), '{"a":1}', s, NOW)).toBe(false);
    expect(verifySignature(SECRET, undefined, '{}', s, NOW)).toBe(false);
  });
});

describe('toss config', () => {
  it('is off unless every key is set and the merchant id is numeric', () => {
    expect(cfg.enabled).toBe(true);
    expect(loadTossConfig({}).enabled).toBe(false);
    expect(loadTossConfig({ SP_TOSS_ACCESS_KEY: 'a', SP_TOSS_SECRET_KEY: 'b', SP_TOSS_MERCHANT_ID: 'x', SP_TOSS_WEBHOOK_SECRET: 'c' }).enabled).toBe(false);
  });
});

describe('toss mapper', () => {
  it('reads a timestamp without offset as KST', () => {
    expect(tossTime('2026-10-19T19:12:00')).toBe('2026-10-19T10:12:00.000Z');
    expect(tossTime('2026-10-19T10:12:00Z')).toBe('2026-10-19T10:12:00.000Z');
    expect(tossTime(null)).toBeNull();
  });
  it('takes the product from order line items, else a unique price, else marks it unknown', () => {
    const { db } = makeDb();
    expect(productNameFor(db, pay(), order(['정규 클래스 8회권']))).toBe('정규 클래스 8회권');
    expect(productNameFor(db, pay(), order(['정규 클래스 1회권', '정규 클래스 4회권']))).toBe('정규 클래스 1회권 + 정규 클래스 4회권');
    expect(productNameFor(db, pay({ amount: 100000 }), null)).toBe('정규 클래스 4회권');
    expect(productNameFor(db, pay({ amount: 12345 }), null)).toBe(UNKNOWN_PRODUCT);
  });
  it('skips unknown states and zero amounts', () => {
    const { db } = makeDb();
    expect(toPaymentInput(db, pay({ state: 'UNDEFINED' }), null)).toBeNull();
    expect(toPaymentInput(db, pay({ amount: 0 }), null)).toBeNull();
    expect(toPaymentInput(db, pay(), null)).toMatchObject({ source: 'KIOSK', externalId: 'toss:640000000000000001', paidAt: '2026-10-19T10:12:00.000Z', amount: 180000, status: 'APPROVED' });
  });
});

describe('toss webhook route', () => {
  it('rejects a bad signature', async () => {
    const { hook, ev, db } = setup();
    const res = await hook(ev('payment.payment.approved.v1', pay()), { secret: 'wrong' });
    expect(res.status).toBe(401);
    expect((db.prepare('select count(*) n from toss_events').get() as any).n).toBe(0);
  });
  it('stores a payment event once per webhook id and wakes the processor', async () => {
    const { hook, ev, db, onReceived } = setup();
    expect((await hook(ev('payment.payment.approved.v1', pay()))).status).toBe(200);
    expect((await hook(ev('payment.payment.approved.v1', pay()))).status).toBe(200); // 재전송
    expect(db.prepare('select type, status, payment_id from toss_events').all()).toEqual([{ type: 'payment.payment.approved.v1', status: 'PENDING', payment_id: '640000000000000001' }]);
    await new Promise((r) => setImmediate(r));
    expect(onReceived).toHaveBeenCalled();
  });
  it('acknowledges but ignores other merchants and other event types', async () => {
    const { hook, ev, db } = setup();
    expect((await hook(ev('payment.payment.approved.v1', pay(), 7), { webhookId: 'a' })).status).toBe(200);
    expect((await hook({ id: 'b', type: 'app.installation.created.v1', merchantId: 42, data: {} }, { webhookId: 'b' })).status).toBe(200);
    expect((db.prepare("select group_concat(status) s from toss_events").get() as any).s).toBe('IGNORED,IGNORED');
  });
  it('is not mounted when toss is off', async () => {
    const { db } = makeDb();
    const app = createApp({ db, secureCookies: false, allowedOrigin: null });
    expect((await app.request('/hooks/toss', { method: 'POST', body: '{}' })).status).toBe(404);
  });
});

describe('toss sync', () => {
  it('approval then cancel: creates the payment with the order product, cancel removes the unused pass', async () => {
    const { hook, ev, db, member } = setup(); const m = member();
    await hook(ev('payment.payment.approved.v1', pay()), { webhookId: 'w1' });
    const client = fakeClient();
    expect(await processPending(db, client)).toMatchObject({ done: 1, retry: 0, stuck: 0 });
    const p = db.prepare("select * from payments where external_id='toss:640000000000000001'").get() as any;
    expect(p).toMatchObject({ product_name: '정규 클래스 8회권', amount: 180000, status: 'APPROVED', member_id: null, paid_at: '2026-10-19T10:12:00.000Z' });
    expect(assignPayment(db, p.id, m, 'st').passId).toBeTruthy(); // 데스크에서 회원 연결
    await hook(ev('payment.payment.cancelled.v1', pay({ state: 'CANCELLED', cancelledAt: '2026-10-19T19:20:00' })), { webhookId: 'w2' });
    await processPending(db, client);
    expect(db.prepare('select status, pass_id from payments where id=?').get(p.id)).toEqual({ status: 'CANCELLED', pass_id: null });
    expect(client.getOrder).toHaveBeenCalledTimes(1); // 취소에는 주문 조회가 필요 없다
  });
  it('cancel of a used pass keeps the payment and flags it for review', async () => {
    const { db, member, course } = makeDb(); const m = member();
    ingestToss(db, pay(), order(['정규 클래스 8회권']));
    const p = db.prepare('select id from payments').get() as any;
    const passId = assignPayment(db, p.id, m, 'st').passId!;
    expect(attend(db, { memberId: m, courseId: course().id, staffId: 'st', now: new Date('2026-10-20T10:00:00Z') })).toMatchObject({ ok: true });
    expect(db.prepare('select count(*) n from attendances where pass_id=?').get(passId)).toEqual({ n: 1 });
    expect(ingestToss(db, pay({ state: 'CANCELLED' }), null)).toBe('CANCEL_FAILED');
    expect(db.prepare('select status, review from payments where id=?').get(p.id)).toEqual({ status: 'APPROVED', review: 'REFUND_IN_USE' });
  });
  it('drops a cancel whose approval we never stored', () => {
    const { db } = makeDb();
    expect(ingestToss(db, pay({ state: 'CANCELLED' }), null)).toBe('SKIPPED');
    expect((db.prepare('select count(*) n from payments').get() as any).n).toBe(0);
  });
  it('retries the order lookup, then stores the payment by price so it is never lost', async () => {
    const { hook, ev, db } = setup();
    await hook(ev('payment.payment.approved.v1', pay()));
    const client = fakeClient({ getOrder: vi.fn(async () => { throw new TossApiError(500, 'X'); }) });
    for (let i = 1; i < MAX_ORDER_ATTEMPTS; i++) expect(await processPending(db, client)).toMatchObject({ done: 0, retry: 1 });
    expect(await processPending(db, client)).toMatchObject({ done: 1, retry: 0, stuck: 0 });
    expect(db.prepare('select product_name from payments').get()).toEqual({ product_name: '정규 클래스 8회권' }); // 180000원 = 8회권 하나
    expect(db.prepare('select status, last_error from toss_events').get()).toEqual({ status: 'DONE', last_error: 'NO_ORDER' });
  });
  it('reconcile fills a missed webhook and is idempotent', async () => {
    const { db } = makeDb();
    const client = fakeClient({ listOrders: vi.fn(async (_f: string, _t: string, page: number) => (page === 1 ? [order(['정규 클래스 4회권'], [pay({ id: 'p2', amount: 100000 })])] : [])) });
    const from = new Date(NOW - 48 * 3600_000), to = new Date(NOW);
    expect(await reconcile(db, client, from, to)).toEqual({ orders: 1, added: 1, cancelled: 0, cancelFailed: 0 });
    expect(await reconcile(db, client, from, to)).toEqual({ orders: 1, added: 0, cancelled: 0, cancelFailed: 0 });
    expect(db.prepare('select external_id, product_name from payments').all()).toEqual([{ external_id: 'toss:p2', product_name: '정규 클래스 4회권' }]);
  });
});

describe('toss client', () => {
  it('sends the key headers to the merchant path and unwraps success', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ resultType: 'SUCCESS', success: { id: 'o1' } }), { status: 200 }));
    const c = tossClient(cfg, fetchImpl as any);
    expect(await c.getOrder('o1')).toEqual({ id: 'o1' });
    const [url, init] = (fetchImpl.mock.calls[0] as unknown) as [string, RequestInit];
    expect(url).toBe('https://open-api.tossplace.com/api-public/openapi/v1/merchants/42/order/orders/o1');
    expect(init.headers).toMatchObject({ 'x-access-key': 'ak', 'x-secret-key': 'sk' });
  });
  it('turns a FAIL body into TossApiError', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ resultType: 'FAIL', error: { errorCode: '4010' } }), { status: 401 }));
    await expect(tossClient(cfg, fetchImpl as any).getOrder('o1')).rejects.toMatchObject({ status: 401, code: '4010' });
  });
});

describe('issue tracker', () => {
  it('sends ISSUE once and RESOLVED once with the open count', () => {
    const sent: string[] = []; const issue = issueTracker((t, b) => sent.push(`${t} ${b}`));
    issue('a', true, 'x'); issue('a', true, 'x'); issue('b', true, 'y'); issue('a', false, 'x'); issue('a', false, 'x');
    expect(sent).toEqual(['[ISSUE] studiopass x (미해결 1건)', '[ISSUE] studiopass y (미해결 2건)', '[RESOLVED] studiopass x 정상화 (미해결 1건)']);
  });
});
