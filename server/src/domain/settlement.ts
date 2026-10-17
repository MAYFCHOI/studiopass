import type { Db } from '../db.js';
export type SettlementLine = { instructorId: string; name: string; type: 'RATIO' | 'PER_SESSION'; ratioInstructor: number; perSessionFee: number; sessions: number; heads: number; revenue: number; instructorPay: number; academyPay: number; proTickets: number };
export function settle(db: Db, month: string): SettlementLine[] {
  const ins = db.prepare('select id, name, settlement_type, ratio_instructor, per_session_fee from instructors').all() as any[];
  const att = db.prepare(`select a.instructor_id, a.course_id, a.attended_on, p.kind, p.price, p.total_count from attendances a join passes p on p.id=a.pass_id where a.cancelled_at is null and a.attended_on like ?`).all(month + '-%') as any[];
  return ins.map((i) => {
    const mine = att.filter((a) => a.instructor_id === i.id);
    const sessions = new Set(mine.map((a) => a.course_id + '@' + a.attended_on)).size;
    let revenue = 0, pro = 0;
    for (const a of mine) { if (a.kind === 'PERIOD') { pro++; continue; } revenue += a.total_count > 0 ? a.price / a.total_count : 0; }
    revenue = Math.round(revenue);
    const pay = i.settlement_type === 'RATIO' ? Math.round((revenue * i.ratio_instructor) / 100) : sessions * i.per_session_fee;
    return { instructorId: i.id, name: i.name, type: i.settlement_type, ratioInstructor: i.ratio_instructor, perSessionFee: i.per_session_fee, sessions, heads: mine.length, revenue, instructorPay: pay, academyPay: revenue - (i.settlement_type === 'RATIO' ? pay : 0), proTickets: pro };
  });
}

/** 한 달치 정산 엑셀 상세: 그 달 출석(취소 제외)과 그 달 결제(KST 기준). 화면 bootstrap 의 62일 창과 무관하다. */
export function settlementDetail(db: Db, month: string) {
  const attendances = db.prepare(`select a.attended_at, a.attended_on, m.name member, c.name course, i.name instructor, p.kind, p.price, p.total_count
    from attendances a join passes p on p.id=a.pass_id left join members m on m.id=a.member_id left join courses c on c.id=a.course_id left join instructors i on i.id=a.instructor_id
    where a.cancelled_at is null and a.attended_on like ? order by a.attended_at`).all(month + '-%') as any[];
  const [y, mo] = month.split('-').map(Number);
  const from = new Date(Date.UTC(y, mo - 1, 1) - 9 * 3600000).toISOString();
  const to = new Date(Date.UTC(y, mo, 1) - 9 * 3600000).toISOString();
  const payments = db.prepare(`select p.*, m.name member from payments p left join members m on m.id=p.member_id where p.paid_at >= ? and p.paid_at < ? order by p.paid_at`).all(from, to) as any[];
  return {
    attendances: attendances.map((a) => ({ attendedAt: a.attended_at, member: a.member ?? null, course: a.course ?? null, instructor: a.instructor ?? null, passKind: a.kind, value: a.kind === 'COUNT' && a.total_count > 0 ? Math.round(a.price / a.total_count) : 0 })),
    payments: payments.map((p) => ({ paidAt: p.paid_at, member: p.member ?? null, payerName: p.payer_name ?? null, productName: p.product_name, amount: p.amount, status: p.status, source: p.source, externalId: p.external_id ?? null })),
  };
}
