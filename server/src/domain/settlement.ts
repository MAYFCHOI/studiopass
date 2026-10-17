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
