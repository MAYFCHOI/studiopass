import type { Db } from '../db.js';
import { kstDate } from '../util.js';
export type Terms = { type: 'RATIO' | 'PER_SESSION'; ratioInstructor: number; perSessionFee: number };
export type Person = { name: string; value: number; kind: 'COUNT' | 'PERIOD' | 'DROP_IN' };
export type DayLine = { date: string; heads: number; revenue: number; people: Person[] };
/** 강사 한 명의 수업 하나. custom: 수업에 따로 정한 조건(아니면 강사 기본) */
export type CourseLine = Terms & { courseId: string; name: string; weekday: number; startTime: string; custom: boolean; sessions: number; heads: number; revenue: number; instructorPay: number; proTickets: number; dropIns: number; days: DayLine[] };
export type SettlementLine = { instructorId: string; name: string; type: 'RATIO' | 'PER_SESSION'; ratioInstructor: number; perSessionFee: number; sessions: number; heads: number; revenue: number; instructorPay: number; academyPay: number; proTickets: number; dropIns: number; courses: CourseLine[] };
type DropIn = { instructor_id: string | null; course_id: string | null; paid_at: string; amount: number; payer_name: string | null };
/**
 * 그 달(KST)의 원데이 결제: 회원 연결 없이 결제만 있는 건. 상품에 묶인 수업의 강사 몫으로 센다(수업이 없는 상품은 어느 강사에게도 가지 않는다).
 * 회원에게 연결돼 수강권이 생긴 원데이 결제는 출석으로 세므로 여기서 빼서 두 번 세지 않는다.
 */
function dropIns(db: Db, month: string): DropIn[] {
  const [y, m] = month.split('-').map(Number);
  const from = new Date(Date.UTC(y, m - 1, 1) - 9 * 3600000).toISOString();
  const to = new Date(Date.UTC(y, m, 1) - 9 * 3600000).toISOString();
  return db.prepare(`select c.instructor_id, pr.course_id, p.paid_at, p.amount, p.payer_name from payments p
    join products pr on pr.name=p.product_name left join courses c on c.id=pr.course_id
    where p.drop_in=1 and p.status='APPROVED' and p.pass_id is null and p.paid_at >= ? and p.paid_at < ?`).all(from, to) as DropIn[];
}
/**
 * 강사별 정산. 수업 단위로 계산한 뒤 더한다: 수업에 정산 조건이 있으면 그것, 없으면 강사 기본 조건.
 * 비율제는 그 수업 매출 × 강사 비율, 타임제는 그 수업 타임 수 × 1타임 금액(매출은 전부 학원).
 */
export function settle(db: Db, month: string): SettlementLine[] {
  const ins = db.prepare('select id, name, settlement_type, ratio_instructor, per_session_fee from instructors').all() as any[];
  const courses = new Map((db.prepare('select id, name, weekday, start_time, settlement_type, ratio_instructor, per_session_fee from courses').all() as any[]).map((c) => [c.id, c]));
  const att = db.prepare(`select a.instructor_id, a.course_id, a.attended_on, a.attended_at, p.kind, p.price, p.total_count, m.name member from attendances a join passes p on p.id=a.pass_id left join members m on m.id=a.member_id
    where a.cancelled_at is null and a.attended_on like ? order by a.attended_at`).all(month + '-%') as any[];
  const drops = dropIns(db, month);
  return ins.map((i) => {
    const base: Terms = { type: i.settlement_type, ratioInstructor: i.ratio_instructor, perSessionFee: i.per_session_fee };
    const byCourse = new Map<string, Map<string, Person[]>>();
    const add = (courseId: string, date: string, p: Person) => {
      const days = byCourse.get(courseId) ?? new Map<string, Person[]>(); byCourse.set(courseId, days);
      days.set(date, [...(days.get(date) ?? []), p]);
    };
    for (const a of att) if (a.instructor_id === i.id) add(a.course_id, a.attended_on, { name: a.member ?? '', kind: a.kind, value: a.kind === 'PERIOD' || !(a.total_count > 0) ? 0 : a.price / a.total_count });
    for (const d of drops) if (d.instructor_id === i.id && d.course_id) add(d.course_id, kstDate(new Date(d.paid_at)), { name: d.payer_name ?? '', kind: 'DROP_IN', value: d.amount });
    const lines: CourseLine[] = [...byCourse].map(([courseId, days]) => {
      const c = courses.get(courseId);
      const terms: Terms = c?.settlement_type ? { type: c.settlement_type, ratioInstructor: c.ratio_instructor ?? 0, perSessionFee: c.per_session_fee ?? 0 } : base;
      const dayLines: DayLine[] = [...days].sort(([x], [y]) => x.localeCompare(y)).map(([date, people]) => ({ date, heads: people.length, revenue: Math.round(people.reduce((n, p) => n + p.value, 0)), people: people.map((p) => ({ ...p, value: Math.round(p.value) })) }));
      const all = [...days.values()].flat();
      const revenue = Math.round(all.reduce((n, p) => n + p.value, 0));
      const sessions = days.size;
      const instructorPay = terms.type === 'RATIO' ? Math.round((revenue * terms.ratioInstructor) / 100) : sessions * terms.perSessionFee;
      return { courseId, name: c?.name ?? '', weekday: c?.weekday ?? 0, startTime: c?.start_time ?? '', custom: !!c?.settlement_type, ...terms, sessions, heads: all.length, revenue, instructorPay,
        proTickets: all.filter((p) => p.kind === 'PERIOD').length, dropIns: all.filter((p) => p.kind === 'DROP_IN').length, days: dayLines };
    }).sort((a, b) => a.weekday - b.weekday || a.startTime.localeCompare(b.startTime));
    const sum = (k: 'sessions' | 'heads' | 'revenue' | 'instructorPay' | 'proTickets' | 'dropIns') => lines.reduce((n, l) => n + l[k], 0);
    const ratioPay = lines.filter((l) => l.type === 'RATIO').reduce((n, l) => n + l.instructorPay, 0);
    return { instructorId: i.id, name: i.name, ...base, sessions: sum('sessions'), heads: sum('heads'), revenue: sum('revenue'), instructorPay: sum('instructorPay'), academyPay: sum('revenue') - ratioPay, proTickets: sum('proTickets'), dropIns: sum('dropIns'), courses: lines };
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
    payments: payments.map((p) => ({ paidAt: p.paid_at, member: p.member ?? null, payerName: p.payer_name ?? null, productName: p.product_name, amount: p.amount, status: p.status, source: p.source, externalId: p.external_id ?? null, dropIn: !!p.drop_in })),
  };
}
