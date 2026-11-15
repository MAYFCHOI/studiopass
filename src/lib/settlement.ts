import dayjs from 'dayjs';
import type { State, SettlementLine, SettlementCourse, SettlementType } from '../types';

export type { SettlementLine };

type Person = SettlementCourse['days'][number]['people'][number];

/**
 * 데모용 계산. 서버(server/src/domain/settlement.ts)와 같은 규칙, 원데이 결제는 빼고 출석만.
 * - 수업 단위로 계산한 뒤 강사별로 더한다. 수업에 정산 조건이 있으면 그것, 없으면 강사 기본.
 * - 비율제: 출석 1회의 가치 = 수강권 가격 / 총 회차. 그 수업 매출 × 강사 비율.
 * - 타임제: 1타임 = 출석이 1명 이상 기록된 수업 1회(같은 날 같은 수업은 1타임). 매출은 전액 학원.
 * - 전문반(PERIOD 패스) 출석은 매출 환산하지 않고 횟수만 센다.
 */
export function settle(state: State, month: string): SettlementLine[] {
  const start = dayjs(month + '-01');
  const end = start.endOf('month');
  const att = state.attendances
    .filter((a) => !a.cancelledAt && dayjs(a.attendedAt).isAfter(start.subtract(1, 'ms')) && dayjs(a.attendedAt).isBefore(end.add(1, 'ms')))
    .sort((a, b) => a.attendedAt.localeCompare(b.attendedAt));
  const passById = new Map(state.passes.map((p) => [p.id, p]));
  return state.instructors.map((ins) => {
    const byCourse = new Map<string, Map<string, Person[]>>();
    for (const a of att) {
      if (a.instructorId !== ins.id) continue;
      const p = passById.get(a.passId);
      if (!p) continue;
      const days = byCourse.get(a.courseId) ?? new Map<string, Person[]>(); byCourse.set(a.courseId, days);
      const date = dayjs(a.attendedAt).format('YYYY-MM-DD');
      const value = p.kind === 'PERIOD' || !(p.totalCount > 0) ? 0 : (p.price ?? 0) / p.totalCount;
      days.set(date, [...(days.get(date) ?? []), { name: state.members.find((m) => m.id === a.memberId)?.name ?? '', value, kind: p.kind }]);
    }
    const courses: SettlementCourse[] = [...byCourse].map(([courseId, days]) => {
      const c = state.courses.find((x) => x.id === courseId);
      const type: SettlementType = c?.settlementType ?? ins.settlementType;
      const ratioInstructor = (c?.settlementType ? c.ratioInstructor : ins.ratioInstructor) ?? 0;
      const perSessionFee = (c?.settlementType ? c.perSessionFee : ins.perSessionFee) ?? 0;
      const all = [...days.values()].flat();
      const revenue = Math.round(all.reduce((n, p) => n + p.value, 0));
      const sessions = days.size;
      return {
        courseId, name: c?.name ?? '', weekday: c?.weekday[0] ?? 0, startTime: c?.startTime ?? '', type, ratioInstructor, perSessionFee, custom: !!c?.settlementType,
        sessions, heads: all.length, revenue, instructorPay: type === 'RATIO' ? Math.round((revenue * ratioInstructor) / 100) : sessions * perSessionFee,
        proTickets: all.filter((p) => p.kind === 'PERIOD').length, dropIns: 0,
        days: [...days].sort(([x], [y]) => x.localeCompare(y)).map(([date, people]) => ({ date, heads: people.length, revenue: Math.round(people.reduce((n, p) => n + p.value, 0)), people: people.map((p) => ({ ...p, value: Math.round(p.value) })) })),
      };
    }).sort((a, b) => a.weekday - b.weekday || a.startTime.localeCompare(b.startTime));
    const sum = (k: 'sessions' | 'heads' | 'revenue' | 'instructorPay' | 'proTickets') => courses.reduce((n, l) => n + l[k], 0);
    const ratioPay = courses.filter((l) => l.type === 'RATIO').reduce((n, l) => n + l.instructorPay, 0);
    return { instructor: ins, type: ins.settlementType, sessions: sum('sessions'), heads: sum('heads'), revenue: sum('revenue'), instructorPay: sum('instructorPay'), academyPay: sum('revenue') - ratioPay, proTickets: sum('proTickets'), courses };
  });
}
