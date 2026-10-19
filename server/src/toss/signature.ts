// 토스플레이스 웹훅 서명: x-toss-signature = "v1=" + hex(HMAC-SHA256(secret, "<x-toss-timestamp>.<raw body>")).
import { createHmac, timingSafeEqual } from 'node:crypto';

/** 보낸 시각과 이만큼 넘게 차이 나면 거부한다(재전송 공격 방지). */
export const MAX_SKEW_MS = 5 * 60_000;

export function sign(secret: string, timestamp: string, rawBody: string) {
  return 'v1=' + createHmac('sha256', secret).update(`${timestamp}.${rawBody}`, 'utf8').digest('hex');
}

export function verifySignature(secret: string, timestamp: string | undefined, rawBody: string, signature: string | undefined, now = Date.now()) {
  if (!timestamp || !signature || !/^\d{10,16}$/.test(timestamp)) return false;
  if (Math.abs(now - Number(timestamp)) > MAX_SKEW_MS) return false;
  const want = Buffer.from(sign(secret, timestamp, rawBody));
  const got = Buffer.from(signature);
  return want.length === got.length && timingSafeEqual(want, got);
}
