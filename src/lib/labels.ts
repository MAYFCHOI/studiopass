import type { Course, Pass, State } from '../types';

export const lvl = (c: Pick<Course, 'level'>) => (c.level ? `LV.${c.level}` : '');
export const HALL_NAME = { HUB: 'HUB HALL', LAB: 'LAB HALL' } as const;

/** 목록용 한 줄 이름: "HIPHOP · YENI CHO" */
export const courseTitle = (s: Pick<State, 'instructors'>, c: Course) =>
  `${c.name} · ${s.instructors.find((i) => i.id === c.instructorId)?.name ?? '?'}`;

/** 보조 줄: "HUB 19:25 · LV.2" */
export const courseMeta = (c: Course) => [c.hall, c.startTime, lvl(c), c.kind === 'PRO' ? '전문반' : ''].filter(Boolean).join(' · ');

export const passName = (s: Pick<State, 'products' | 'courses' | 'instructors'>, p: Pass) => {
  if (p.courseId) { const c = s.courses.find((x) => x.id === p.courseId); if (c) return courseTitle(s, c) + ' 전용'; }
  return s.products.find((x) => x.id === p.productId)?.name ?? (p.kind === 'PERIOD' ? '전문반 월정액' : '정규 클래스');
};
