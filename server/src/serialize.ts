// Row (snake_case) -> API (camelCase) mappers. DESK never receives money or settlement-term keys.
export type Role = 'OWNER' | 'DESK';
const opt = <T>(v: T | null | undefined) => (v === null ? undefined : v);
const owner = (role: Role) => role === 'OWNER';
export type TierRow = { name: string; min_count: number; min_years?: number | null };
/** 다닌 햇수: since(처음 온 날, 없으면 등록일)부터 now 까지 */
export function yearsSince(since: string | null | undefined, createdAt: string, now: Date) {
  const from = Date.parse((since ?? createdAt.slice(0, 10)) + 'T00:00:00+09:00');
  return Number.isNaN(from) ? 0 : (now.getTime() - from) / (365.25 * 86400000);
}
/**
 * 출석 횟수(와 기간 조건이 있는 등급은 다닌 햇수)로 정한 등급. 조건을 모두 채운 가장 높은 등급.
 * floor(원장이 올린 등급, 1부터)가 더 높으면 그 등급이고 manual 이 붙는다.
 */
export function tierIndex(tiers: { min_count: number; min_years?: number | null }[], count: number, floor?: number | null, years = 0) {
  let idx = 0;
  tiers.forEach((t, i) => { if (count >= t.min_count && (!t.min_years || years >= t.min_years)) idx = i; });
  const f = floor ? Math.min(floor, tiers.length) - 1 : -1;
  return f > idx ? { idx: f, manual: true } : { idx, manual: false };
}
export function tierOf(tiers: TierRow[], count: number, floor?: number | null, years = 0) {
  const { idx, manual } = tierIndex(tiers, count, floor, years);
  return { name: tiers[idx]?.name ?? '', level: idx + 1, count, ...(manual ? { manual: true } : {}) };
}
export const toMember = (r: any, tier: { name: string; level: number; count: number; manual?: boolean }) => ({ id: r.id, memberNo: r.member_no, name: r.name, phone: r.phone, memo: opt(r.memo), createdAt: r.created_at, tier, ...(r.since ? { since: r.since } : {}), ...(r.tier_floor ? { tierFloor: r.tier_floor } : {}), ...(r.erased_at ? { erased: true } : {}) });
export const toInstructor = (r: any, role: Role) => ({
  id: r.id, name: r.name, crew: r.genres, settlementType: r.settlement_type, active: !!r.active,
  ...(owner(role) ? { ratioInstructor: r.ratio_instructor, perSessionFee: r.per_session_fee } : {}),
});
export const toCourse = (r: any, role: Role) => ({
  id: r.id, name: r.name, instructorId: r.instructor_id, kind: r.kind, hall: r.hall, level: opt(r.level), note: opt(r.note), weekday: [r.weekday], startTime: r.start_time, durationMin: r.duration_min, active: !!r.active, ...(r.deleted_at ? { deleted: true } : {}),
  // 수업별 정산 조건(없으면 강사 기본). DESK 에게는 주지 않는다
  ...(owner(role) ? { settlementType: opt(r.settlement_type), ratioInstructor: opt(r.ratio_instructor), perSessionFee: opt(r.per_session_fee) } : {}),
});
export const toProduct = (r: any, role: Role) => ({
  id: r.id, name: r.name, courseId: opt(r.course_id), passKind: r.pass_kind, count: r.count, periodDays: r.period_days, active: !!r.active, dropIn: !!r.drop_in,
  ...(owner(role) ? { price: r.price, attendBonus: opt(r.attend_bonus) } : {}),
});
export const toPass = (r: any, role: Role) => ({
  id: r.id, memberId: r.member_id, productId: r.product_id, courseId: opt(r.course_id), kind: r.kind, totalCount: r.total_count, remaining: r.remaining, validFrom: r.valid_from, validTo: r.valid_to, paymentId: opt(r.payment_id), extendedDays: opt(r.extended_days), extendedAt: opt(r.extended_at), adjustedUsed: opt(r.adjusted_used),
  ...(owner(role) ? { price: r.price } : {}),
});
export const toPayment = (r: any, role: Role) => ({
  id: r.id, source: r.source, externalId: opt(r.external_id), paidAt: r.paid_at, payerName: opt(r.payer_name), payerPhone: r.payer_phone, productName: r.product_name, status: r.status, memberId: opt(r.member_id), passId: opt(r.pass_id), review: opt(r.review), refundOf: opt(r.refund_of), refundSuggestedOf: opt(r.refund_suggested_of), importBatchId: opt(r.import_batch_id), dropIn: !!r.drop_in, method: opt(r.method), courseId: opt(r.course_id), discountPct: opt(r.discount_pct),
  ...(owner(role) ? { amount: r.amount } : {}),
});
export const toAttendance = (r: any) => ({ id: r.id, memberId: r.member_id, passId: r.pass_id, courseId: r.course_id, instructorId: r.instructor_id, attendedAt: r.attended_at, attendedOn: r.attended_on, cancelledAt: opt(r.cancelled_at), ...(r.backfilled ? { backfilled: true } : {}) });
