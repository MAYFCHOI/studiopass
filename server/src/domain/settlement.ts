import type { Db } from '../db.js';
import { kstDate } from '../util.js';
import { findProduct, comboParts, comboAmounts } from './payments.js';
export type Terms = { type: 'RATIO' | 'PER_SESSION'; ratioInstructor: number; perSessionFee: number };
export type Person = { name: string; value: number; kind: 'COUNT' | 'PERIOD' | 'DROP_IN'; bonus?: number; paidOn?: string };
export type DayLine = { date: string; heads: number; revenue: number; people: Person[]; fee?: number };
/** 강사 한 명의 수업 하나. custom: 수업에 따로 정한 조건(아니면 강사 기본) */
export type CourseLine = Terms & { courseId: string; name: string; weekday: number; startTime: string; custom: boolean; sub?: boolean; extra?: boolean; sessions: number; heads: number; revenue: number; instructorPay: number; bonus: number; proTickets: number; dropIns: number; days: DayLine[] };
export type SettlementLine = { instructorId: string; name: string; type: 'RATIO' | 'PER_SESSION'; ratioInstructor: number; perSessionFee: number; sessions: number; heads: number; revenue: number; instructorPay: number; bonus: number; academyPay: number; proTickets: number; dropIns: number; courses: CourseLine[] };
type DropIn = { instructor_id: string | null; course_id: string | null; paid_at: string; amount: number; payer_name: string | null };
/**
 * 그 달(KST)의 원데이 결제: 회원 연결 없이 결제만 있는 건. 결제에 고른 수업, 없으면 상품에 묶인 수업의 강사 몫으로 센다(둘 다 없으면 어느 강사에게도 가지 않는다).
 * 회원에게 연결돼 수강권이 생긴 원데이 결제는 출석으로 세므로 여기서 빼서 두 번 세지 않는다.
 */
function dropIns(db: Db, month: string): DropIn[] {
  const [y, m] = month.split('-').map(Number);
  const from = new Date(Date.UTC(y, m - 1, 1) - 9 * 3600000).toISOString();
  const to = new Date(Date.UTC(y, m, 1) - 9 * 3600000).toISOString();
  const rows = db.prepare(`select p.product_name, p.course_id, p.paid_at, p.amount, p.payer_name from payments p
    where p.drop_in=1 and p.status='APPROVED' and p.pass_id is null and p.paid_at >= ? and p.paid_at < ?`).all(from, to) as any[];
  const insOf = db.prepare('select instructor_id from courses where id=?');
  const byName = db.prepare('select course_id from products where name=?'); // 쉬는 상품도(지난 달 정산)
  return rows.flatMap((r) => {
    const insFor = (id: string | null) => (id ? (insOf.get(id) as { instructor_id: string } | undefined)?.instructor_id ?? null : null);
    // 묶음 결제("A + B")는 조각마다 나눈다: 상품에 묶인 수업이 먼저, 없으면(웜업, 못 찾은 상품) 결제에 고른 수업.
    const parts = comboParts(db, r.product_name);
    if (parts) {
      const amounts = comboAmounts(r.amount, parts);
      return parts.map((x, i) => { const courseId = x?.course_id ?? r.course_id ?? null; return { instructor_id: insFor(courseId), course_id: courseId, paid_at: r.paid_at, amount: amounts[i], payer_name: r.payer_name }; });
    }
    const courseId = r.course_id ?? (byName.get(r.product_name) as { course_id: string | null } | undefined)?.course_id ?? findProduct(db, r.product_name)?.course_id ?? null;
    const c = courseId ? (insOf.get(courseId) as { instructor_id: string } | undefined) : undefined;
    return { instructor_id: c?.instructor_id ?? null, course_id: courseId, paid_at: r.paid_at, amount: r.amount, payer_name: r.payer_name };
  });
}
/**
 * 강사별 정산. 수업 단위로 계산한 뒤 더한다: 수업에 정산 조건이 있으면 그것, 없으면 강사 기본 조건.
 * 비율제는 그 수업 매출 × 강사 비율, 타임제는 그 수업 타임 수 × 1타임 금액(매출은 전부 학원).
 * 상품에 출석 1회당 추가 페이(attend_bonus)가 있으면 그 수강권 출석마다 강사 몫에 더한다(학원이 낸다, 학원 몫에서 빼지 않는 타임 금액과 같다).
 */
/** 원데이 결제가 센 수업 날: 결제한 날부터 그 수업 요일이 처음 오는 날(미리 결제해도 수업 날 1타임으로 묶인다). 달은 넘기지 않는다 */
function classDay(paid: string, weekday?: number) {
  if (weekday === undefined) return paid;
  const d = new Date(paid + 'T00:00:00Z');
  const add = (weekday - d.getUTCDay() + 7) % 7;
  const t = new Date(d.getTime() + add * 86400000);
  return t.getUTCMonth() === d.getUTCMonth() ? t.toISOString().slice(0, 10) : paid;
}
export function settle(db: Db, month: string): SettlementLine[] {
  const ins = db.prepare('select id, name, settlement_type, ratio_instructor, per_session_fee from instructors').all() as any[];
  const courses = new Map((db.prepare('select id, name, weekday, start_time, settlement_type, ratio_instructor, per_session_fee from courses').all() as any[]).map((c) => [c.id, c]));
  const att = db.prepare(`select a.instructor_id, a.course_id, a.attended_on, a.attended_at, p.kind, p.price, p.total_count, pr.attend_bonus bonus, m.name member from attendances a join passes p on p.id=a.pass_id left join products pr on pr.id=p.product_id left join members m on m.id=a.member_id
    where a.cancelled_at is null and a.attended_on like ? order by a.attended_at`).all(month + '-%') as any[];
  const drops = dropIns(db, month);
  // 대강: 그 날 그 수업의 출석·원데이는 대강 강사 몫, 출석이 없어도 1타임. 대강한 날은 수업과 따로 한 줄(fee 가 있으면 그 날 1타임 금액)
  const subs = new Map((db.prepare('select course_id, date, instructor_id, fee from substitutions where date like ?').all(month + '-%') as any[]).map((x) => [`${x.course_id}|${x.date}`, x as { course_id: string; date: string; instructor_id: string; fee: number | null }]));
  const subOf = (courseId: string, date: string) => subs.get(`${courseId}|${date}`);
  const extras = db.prepare('select date, instructor_id, fee, memo from extra_pays where date like ?').all(month + '-%') as { date: string; instructor_id: string; fee: number; memo: string | null }[];
  return ins.map((i) => {
    const base: Terms = { type: i.settlement_type, ratioInstructor: i.ratio_instructor, perSessionFee: i.per_session_fee };
    const byCourse = new Map<string, Map<string, Person[]>>();
    const add = (courseId: string, date: string, p?: Person) => {
      const key = subOf(courseId, date) ? `${courseId}#sub` : courseId;
      const days = byCourse.get(key) ?? new Map<string, Person[]>(); byCourse.set(key, days);
      days.set(date, [...(days.get(date) ?? []), ...(p ? [p] : [])]);
    };
    const mine = (courseId: string, date: string, owner: string | null) => (subOf(courseId, date)?.instructor_id ?? owner) === i.id;
    for (const a of att) if (mine(a.course_id, a.attended_on, a.instructor_id)) add(a.course_id, a.attended_on, { name: a.member ?? '', kind: a.kind, value: a.kind === 'PERIOD' || !(a.total_count > 0) ? 0 : a.price / a.total_count, ...(a.bonus ? { bonus: a.bonus } : {}) });
    for (const d of drops) {
      if (!d.course_id) continue;
      const paid = kstDate(new Date(d.paid_at)); const date = classDay(paid, courses.get(d.course_id)?.weekday);
      if (mine(d.course_id, date, d.instructor_id)) add(d.course_id, date, { name: d.payer_name ?? '', kind: 'DROP_IN', value: d.amount, ...(paid !== date ? { paidOn: paid } : {}) });
    }
    for (const x of subs.values()) if (x.instructor_id === i.id) add(x.course_id, x.date);
    const lines: CourseLine[] = [...byCourse].map(([key, days]) => {
      const isSub = key.endsWith('#sub'); const courseId = isSub ? key.slice(0, -4) : key;
      const c = courses.get(courseId);
      const fee = isSub ? [...days.keys()].map((dt) => subOf(courseId, dt)?.fee).find((f) => f != null) : undefined;
      const terms: Terms = fee != null ? { type: 'PER_SESSION', ratioInstructor: 0, perSessionFee: fee }
        : c?.settlement_type ? { type: c.settlement_type, ratioInstructor: c.ratio_instructor ?? 0, perSessionFee: c.per_session_fee ?? 0 } : base;
      const dayLines: DayLine[] = [...days].sort(([x], [y]) => x.localeCompare(y)).map(([date, people]) => ({ date, heads: people.length, revenue: Math.round(people.reduce((n, p) => n + p.value, 0)), people: people.map((p) => ({ ...p, value: Math.round(p.value) })) }));
      const all = [...days.values()].flat();
      const revenue = Math.round(all.reduce((n, p) => n + p.value, 0));
      const sessions = days.size;
      const bonus = all.reduce((n, p) => n + (p.bonus ?? 0), 0);
      const instructorPay = (terms.type === 'RATIO' ? Math.round((revenue * terms.ratioInstructor) / 100) : sessions * terms.perSessionFee) + bonus;
      return { courseId, name: c?.name ?? '', weekday: c?.weekday ?? 0, startTime: c?.start_time ?? '', custom: fee != null || !!c?.settlement_type, ...(isSub ? { sub: true } : {}), ...terms, sessions, heads: all.length, revenue, instructorPay, bonus,
        proTickets: all.filter((p) => p.kind === 'PERIOD').length, dropIns: all.filter((p) => p.kind === 'DROP_IN').length, days: dayLines };
    }).sort((a, b) => a.weekday - b.weekday || a.startTime.localeCompare(b.startTime) || Number(!!a.sub) - Number(!!b.sub));
    // 추가 페이(웜업 등): 메모별 한 줄, 날짜마다 1타임, 금액은 적은 그대로 더한다(매출 0, 학원 몫에서 빼지 않는다)
    const byMemo = new Map<string, { date: string; fee: number }[]>();
    for (const x of extras) if (x.instructor_id === i.id) { const k = x.memo || '추가 페이'; byMemo.set(k, [...(byMemo.get(k) ?? []), { date: x.date, fee: x.fee }]); }
    for (const [memo, xs] of byMemo) {
      const fees = new Set(xs.map((x) => x.fee)); const pay = xs.reduce((n, x) => n + x.fee, 0);
      const days = [...xs].sort((a, b) => a.date.localeCompare(b.date)).map((x) => ({ date: x.date, heads: 0, revenue: 0, people: [] as Person[], fee: x.fee }));
      lines.push({ courseId: `extra:${memo}`, name: memo, weekday: 7, startTime: '', custom: true, extra: true, type: 'PER_SESSION', ratioInstructor: 0, perSessionFee: fees.size === 1 ? xs[0].fee : 0, sessions: xs.length, heads: 0, revenue: 0, instructorPay: pay, bonus: 0, proTickets: 0, dropIns: 0, days });
    }
    const sum = (k: 'sessions' | 'heads' | 'revenue' | 'instructorPay' | 'bonus' | 'proTickets' | 'dropIns') => lines.reduce((n, l) => n + l[k], 0);
    const ratioPay = lines.filter((l) => l.type === 'RATIO').reduce((n, l) => n + l.instructorPay - l.bonus, 0);
    return { instructorId: i.id, name: i.name, ...base, sessions: sum('sessions'), heads: sum('heads'), revenue: sum('revenue'), instructorPay: sum('instructorPay'), bonus: sum('bonus'), academyPay: sum('revenue') - ratioPay, proTickets: sum('proTickets'), dropIns: sum('dropIns'), courses: lines };
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
