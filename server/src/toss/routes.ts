// 토스플레이스 웹훅 수신. /api 밖에 둔다(세션·Origin 검사 대상이 아니다). 서명이 맞는 요청만 받는다.
// 받으면 기록만 하고 바로 200 을 준다(토스는 타임아웃이 짧다). 처리는 onReceived 가 뒤에서 한다.
import { Hono } from 'hono';
import type { Db } from '../db.js';
import { nowIso } from '../util.js';
import type { TossConfig } from './config.js';
import { verifySignature } from './signature.js';

const MAX_BODY = 256 * 1024;
const PAYMENT_EVENTS = new Set(['payment.payment.approved.v1', 'payment.payment.cancelled.v1']);

export function tossRoutes(db: Db, cfg: TossConfig, onReceived: () => void, now: () => number = Date.now) {
  const r = new Hono();
  r.post('/toss', async (c) => {
    if (!cfg.enabled) return c.json({ error: 'DISABLED' }, 404);
    const len = Number(c.req.header('content-length') ?? 0);
    if (len > MAX_BODY) return c.json({ error: 'TOO_LARGE' }, 413);
    const raw = await c.req.text();
    if (raw.length > MAX_BODY) return c.json({ error: 'TOO_LARGE' }, 413);
    if (!verifySignature(cfg.webhookSecret, c.req.header('x-toss-timestamp'), raw, c.req.header('x-toss-signature'), now())) return c.json({ error: 'BAD_SIGNATURE' }, 401);
    let ev: { id?: unknown; type?: unknown; merchantId?: unknown; data?: { payment?: { id?: unknown } } };
    try { ev = JSON.parse(raw); } catch { return c.json({ error: 'BAD_REQUEST' }, 400); }
    const webhookId = c.req.header('x-toss-webhook-id') ?? (typeof ev.id === 'string' ? ev.id : '');
    if (!webhookId || typeof ev.type !== 'string') return c.json({ error: 'BAD_REQUEST' }, 400);
    // 다른 매장 이벤트는 받아만 두고 처리하지 않는다(200 을 안 주면 토스가 계속 재전송한다).
    const ours = String(ev.merchantId) === cfg.merchantId;
    const payment = ev.data?.payment;
    const isPayment = ours && PAYMENT_EVENTS.has(ev.type) && payment && typeof payment.id === 'string';
    db.prepare('insert or ignore into toss_events(webhook_id,type,payment_id,payload,status,received_at) values(?,?,?,?,?,?)')
      .run(webhookId.slice(0, 100), ev.type.slice(0, 100), isPayment ? payment!.id : null, isPayment ? JSON.stringify(payment) : null, isPayment ? 'PENDING' : 'IGNORED', nowIso());
    if (isPayment) setImmediate(onReceived);
    return c.json({ ok: true });
  });
  return r;
}
