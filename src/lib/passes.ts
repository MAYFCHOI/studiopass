import type { Course, Pass } from '../types';
import { today } from './util';

/** 수강권이 이 수업에 쓰일 수 있는지. 전문반 수업은 월정액만, 정규 수업은 공통 회차권·그 수업 전용권·월정액. */
export const passFits = (p: Pass, c: Course) =>
  p.kind === 'PERIOD' ? true : c.kind === 'PRO' ? false : p.courseId ? p.courseId === c.id : true;

/** 지금 쓸 수 있는 수강권, 만료 임박 순 */
export const activePassesOf = (passes: Pass[], memberId: string) => {
  const t = today();
  return passes
    .filter((p) => p.memberId === memberId && p.remaining > 0 && p.validFrom <= t && p.validTo >= t)
    .sort((a, b) => a.validTo.localeCompare(b.validTo));
};
