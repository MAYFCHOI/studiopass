// Row (snake_case) -> API (camelCase) mappers. DESK never receives money or settlement-term keys.
export type Role = 'OWNER' | 'DESK';
const opt = <T>(v: T | null | undefined) => (v === null ? undefined : v);
const owner = (role: Role) => role === 'OWNER';
export type TierRow = { name: string; min_count: number };
export function tierOf(tiers: TierRow[], count: number) {
  let idx = 0;
  tiers.forEach((t, i) => { if (count >= t.min_count) idx = i; });
  return { name: tiers[idx]?.name ?? '', level: idx + 1, count };
}
export const toMember = (r: any, tier: { name: string; level: number; count: number }) => ({ id: r.id, memberNo: r.member_no, name: r.name, phone: r.phone, memo: opt(r.memo), createdAt: r.created_at, tier, ...(r.erased_at ? { erased: true } : {}) });
export const toInstructor = (r: any, role: Role) => ({
  id: r.id, name: r.name, crew: r.genres, settlementType: r.settlement_type, active: !!r.active,
  ...(owner(role) ? { ratioInstructor: r.ratio_instructor, perSessionFee: r.per_session_fee } : {}),
});
export const toCourse = (r: any) => ({ id: r.id, name: r.name, instructorId: r.instructor_id, kind: r.kind, hall: r.hall, level: opt(r.level), note: opt(r.note), weekday: [r.weekday], startTime: r.start_time, durationMin: r.duration_min, active: !!r.active });
export const toProduct = (r: any, role: Role) => ({
  id: r.id, name: r.name, courseId: opt(r.course_id), passKind: r.pass_kind, count: r.count, periodDays: r.period_days, active: !!r.active,
  ...(owner(role) ? { price: r.price } : {}),
});
export const toPass = (r: any, role: Role) => ({
  id: r.id, memberId: r.member_id, productId: r.product_id, courseId: opt(r.course_id), kind: r.kind, totalCount: r.total_count, remaining: r.remaining, validFrom: r.valid_from, validTo: r.valid_to, paymentId: opt(r.payment_id),
  ...(owner(role) ? { price: r.price } : {}),
});
export const toPayment = (r: any, role: Role) => ({
  id: r.id, source: r.source, externalId: opt(r.external_id), paidAt: r.paid_at, payerName: opt(r.payer_name), payerPhone: r.payer_phone, productName: r.product_name, status: r.status, memberId: opt(r.member_id), passId: opt(r.pass_id), review: opt(r.review), refundOf: opt(r.refund_of), importBatchId: opt(r.import_batch_id),
  ...(owner(role) ? { amount: r.amount } : {}),
});
export const toAttendance = (r: any) => ({ id: r.id, memberId: r.member_id, passId: r.pass_id, courseId: r.course_id, instructorId: r.instructor_id, attendedAt: r.attended_at, attendedOn: r.attended_on, cancelledAt: opt(r.cancelled_at) });
