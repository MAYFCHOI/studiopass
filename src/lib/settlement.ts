import dayjs from 'dayjs';
import type { State, Instructor } from '../types';

export interface SettlementLine {
  instructor: Instructor;
  type: Instructor['settlementType'];
  sessions: number; // 수업 횟수(타임)
  heads: number; // 출석 인원 합
  revenue: number; // 출석 기반 매출(회차 환산)
  instructorPay: number;
  academyPay: number;
  proTickets: number; // 전문반 자유수강 출석(기록만)
}

/**
 * 가정(ASSUMPTIONS.md 참고)
 * - 비율제: 출석 1회의 가치 = 수강권 가격 / 총 회차. 해당 월 출석분만 정산. 강사 비율 r% → 강사 r%, 학원 (100-r)%.
 * - 타임제: 1타임 = 출석이 1명 이상 기록된 수업 1회(같은 날 같은 수업은 1타임). 매출은 전액 학원.
 * - 전문반(PERIOD 패스) 출석은 매출 환산하지 않고 강사별 횟수만 집계.
 */
export function settle(state: State, month: string): SettlementLine[] {
  const start = dayjs(month + '-01');
  const end = start.endOf('month');
  const att = state.attendances.filter(
    (a) => !a.cancelledAt && dayjs(a.attendedAt).isAfter(start.subtract(1, 'ms')) && dayjs(a.attendedAt).isBefore(end.add(1, 'ms')),
  );
  const passById = new Map(state.passes.map((p) => [p.id, p]));
  return state.instructors.map((ins) => {
    const mine = att.filter((a) => a.instructorId === ins.id);
    const sessionKeys = new Set(mine.map((a) => a.courseId + '@' + dayjs(a.attendedAt).format('YYYY-MM-DD')));
    let revenue = 0;
    let proTickets = 0;
    for (const a of mine) {
      const p = passById.get(a.passId);
      if (!p) continue;
      if (p.kind === 'PERIOD') { proTickets++; continue; }
      revenue += p.totalCount > 0 ? p.price / p.totalCount : 0;
    }
    revenue = Math.round(revenue);
    let instructorPay = 0;
    if (ins.settlementType === 'RATIO') instructorPay = Math.round((revenue * ins.ratioInstructor) / 100);
    else instructorPay = sessionKeys.size * ins.perSessionFee;
    return {
      instructor: ins,
      type: ins.settlementType,
      sessions: sessionKeys.size,
      heads: mine.length,
      revenue,
      instructorPay,
      academyPay: revenue - (ins.settlementType === 'RATIO' ? instructorPay : 0),
      proTickets,
    };
  });
}
