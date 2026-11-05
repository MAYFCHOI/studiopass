// 토스 결제(+주문)를 키오스크 엑셀 행과 같은 PaymentInput 으로 바꾼다. 이후 처리(중복·취소·환불·수강권)는 ingestPayments 그대로.
import type { Db } from '../db.js';
import type { PaymentInput } from '../domain/payments.js';
import type { TossOrder, TossPayment } from './client.js';

/** 토스 결제 ID 앞에 붙여 엑셀 승인번호와 섞이지 않게 한다. */
export const EXT_PREFIX = 'toss:';
/** 상품을 알 수 없을 때 남기는 이름. 수강권은 만들지 않고 결제만 남는다(데스크에서 확인). */
export const UNKNOWN_PRODUCT = '(토스 상품 미확인)';

/** 토스 시각을 ISO(UTC)로. 문서 예시는 오프셋 없는 "2025-09-01T00:00:00" 이라 그 경우 한국 시각으로 본다(실데이터로 확인 필요). */
export function tossTime(s: string | null | undefined): string | null {
  if (!s) return null;
  const withZone = /([zZ]|[+-]\d{2}:?\d{2})$/.test(s) ? s : s + '+09:00';
  const t = Date.parse(withZone);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/**
 * 상품명: 주문 내역 상품명이 한 가지면 그 이름, 여러 가지면 " + " 로 잇는다(수강권 하나만 매칭되니 데스크 확인 대상).
 * 주문 내역이 없으면 결제 금액과 가격이 같은 판매 중 상품이 정확히 하나일 때 그 이름.
 */
export function productNameFor(db: Db, payment: TossPayment, order: TossOrder | null): string {
  const titles = [...new Set((order?.lineItems ?? []).map((l) => l.item?.title?.trim()).filter((t): t is string => !!t))];
  if (titles.length) return titles.join(' + ');
  const byPrice = db.prepare('select name from products where active=1 and price=?').all(Math.round(payment.amount)) as { name: string }[];
  return byPrice.length === 1 ? byPrice[0].name : UNKNOWN_PRODUCT;
}

export function toPaymentInput(db: Db, payment: TossPayment, order: TossOrder | null): PaymentInput | null {
  if (payment.state !== 'APPROVED' && payment.state !== 'CANCELLED') return null;
  const paidAt = tossTime(payment.approvedAt) ?? tossTime(payment.createdAt);
  if (!paidAt || !(payment.amount > 0)) return null;
  return { source: 'KIOSK', externalId: EXT_PREFIX + payment.id, paidAt, amount: payment.amount, payerName: null, payerPhone: null, productName: productNameFor(db, payment, order).slice(0, 100), status: payment.state };
}
