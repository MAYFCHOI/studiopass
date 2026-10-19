// 토스플레이스 Open API 호출(읽기만). 결제 웹훅에 없는 상품명을 주문에서 가져오고, 하루치 주문으로 빠진 웹훅을 채운다.
import type { TossConfig } from './config.js';

const BASE = 'https://open-api.tossplace.com/api-public/openapi/v1';
const TIMEOUT_MS = 10_000;

export type TossPayment = { id: string; orderId: string; state: string; amount: number; approvedNo?: string; approvedAt?: string | null; cancelledAt?: string | null; createdAt?: string };
export type TossOrder = { id: string; orderState: string; lineItems: { item: { title: string }; quantity: number }[]; payments: TossPayment[] };

export class TossApiError extends Error { constructor(public status: number, public code: string) { super(`toss ${status} ${code}`); } }

export function tossClient(cfg: TossConfig, fetchImpl: typeof fetch = fetch) {
  async function get<T>(path: string, query: Record<string, string | string[]> = {}): Promise<T> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) for (const x of Array.isArray(v) ? v : [v]) qs.append(k, x);
    const url = `${BASE}/merchants/${cfg.merchantId}${path}${qs.size ? '?' + qs : ''}`;
    let res: Response;
    try {
      res = await fetchImpl(url, { headers: { 'x-access-key': cfg.accessKey, 'x-secret-key': cfg.secretKey, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch { throw new TossApiError(0, 'NETWORK'); }
    const json = await res.json().catch(() => null) as { resultType?: string; success?: T; error?: { errorCode?: string } } | null;
    if (!res.ok || json?.resultType !== 'SUCCESS') throw new TossApiError(res.status, json?.error?.errorCode ?? 'BAD_RESPONSE');
    return json.success as T;
  }
  return {
    getOrder: (orderId: string) => get<TossOrder>(`/order/orders/${encodeURIComponent(orderId)}`),
    /** 결제 내역이 from~to 사이에 바뀐 완료·취소 주문(한 페이지). */
    listOrders: (from: string, to: string, page: number, size = 100) =>
      get<TossOrder[]>('/order/orders', { from, to, orderStates: ['COMPLETED', 'CANCELLED'], page: String(page), size: String(size), sortOrder: 'ASC' }),
  };
}
export type TossClient = ReturnType<typeof tossClient>;
