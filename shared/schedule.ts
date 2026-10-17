export type Hall = 'HUB' | 'LAB';
export interface ScheduleInstructor { id: string; name: string; crew: string; settlementType: 'RATIO' | 'PER_SESSION'; ratioInstructor: number; perSessionFee: number }
export interface ScheduleCourse { id: string; name: string; instructorId: string; kind: 'GENERAL' | 'PRO'; hall: Hall; level?: string; note?: string; weekday: number[]; startTime: string; durationMin: number }

/**
 * THE DEPTH DANCE STUDIO 정규 시간표 (2026-10 포스터 기준, docs/brand/schedule-*.png).
 * 한 칸 = 수업 하나. [홀, 요일(0=일), 시작, 분, 장르, 강사, 레벨, 띠 문구, 전문반]
 * 가정: 각 홀 첫 줄은 띠 문구(HUB "WarmUp Training LV.0", LAB "PRO Class")가 가리키는 수업이다.
 */
export type Row = [Hall, number, string, number, string, string, string | undefined, string?, boolean?];
const W = 'WarmUp Training';
export const SCHEDULE: Row[] = [
  // HUB HALL
  ['HUB', 1, '18:20', 60, 'SOUL & LOCK', 'YUZ', '0', W],
  ['HUB', 2, '18:20', 60, 'HIPHOP', 'TAEKO', '0', W],
  ['HUB', 3, '18:20', 60, 'SOUL', 'HAECHI WANG', '0', W],
  ['HUB', 4, '18:20', 60, 'HOUSE', 'JIBAK', '0', W],
  ['HUB', 5, '18:20', 60, 'HIPHOP', 'HILLY', '0', W],
  ['HUB', 1, '19:25', 80, 'HIPHOP', 'HAECHI WANG', 'ALL'],
  ['HUB', 2, '19:25', 80, 'HIPHOP', 'CHOCOL', 'ALL'],
  ['HUB', 3, '19:25', 80, 'CHOREO', 'REDY', '3'],
  ['HUB', 4, '19:25', 80, 'HIPHOP', 'BURBY', '2'],
  ['HUB', 5, '19:25', 80, 'POPPING', 'RYU', '2'],
  ['HUB', 1, '20:50', 80, 'BREAKING', 'SHINOBI', '1'],
  ['HUB', 2, '21:30', 60, 'BODY TRAINING', 'JALT', 'ALL'],
  ['HUB', 3, '20:50', 80, 'HIPHOP', 'YENI CHO', '0'],
  ['HUB', 4, '20:50', 80, 'HIPHOP', 'YENI CHO', '3'],
  ['HUB', 5, '20:50', 80, 'HOUSE', 'NEOH', '2'],
  ['HUB', 0, '14:00', 80, 'HIPHOP', 'HILLY', 'ALL'],
  // LAB HALL
  ['LAB', 1, '18:30', 60, 'HIPHOP', 'CHOROK', undefined, 'PRO Class', true],
  ['LAB', 3, '18:30', 60, 'HIPHOP', 'WOOJIN', undefined, 'PRO Class', true],
  ['LAB', 5, '18:30', 60, 'HIPHOP', 'YENI CHO', undefined, 'PRO Class', true],
  ['LAB', 1, '19:35', 80, 'SOUL & LOCK', 'YUZ', '2'],
  ['LAB', 2, '19:35', 80, 'HIPHOP', 'MIJIN', 'ALL'],
  ['LAB', 3, '19:35', 80, 'PROJECT', 'HAECHI WANG', undefined],
  ['LAB', 4, '19:35', 80, 'HIPHOP', 'YENI CHO', '4'],
  ['LAB', 5, '19:35', 80, 'CHOREO', 'MOREH', 'ALL'],
  ['LAB', 1, '21:00', 80, 'HIPHOP', 'TAEKO', '2'],
  ['LAB', 2, '21:00', 80, 'HIPHOP', 'CHOCOL', '4'],
  ['LAB', 3, '21:00', 80, 'AFRO', 'YODA', 'ALL'],
  ['LAB', 4, '21:00', 80, 'HOUSE', 'JIBAK', '1'],
];

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

export function buildSchedule(): { instructors: ScheduleInstructor[]; courses: ScheduleCourse[] } {
  const instructors: ScheduleInstructor[] = [];
  const courses: ScheduleCourse[] = [];
  for (const [hall, wd, start, dur, genre, who, level, note, pro] of SCHEDULE) {
    const insId = 'ins_' + slug(who);
    let ins = instructors.find((i) => i.id === insId);
    // 정산 조건은 아직 받지 못해 전원 비율제 50:50 예시값
    if (!ins) { ins = { id: insId, name: who, crew: '', settlementType: 'RATIO', ratioInstructor: 50, perSessionFee: 0 }; instructors.push(ins); }
    const genres = new Set((ins.crew ? ins.crew.split(' · ') : []).concat(genre));
    ins.crew = [...genres].join(' · ');
    courses.push({
      id: `c_${hall.toLowerCase()}_${wd}_${start.replace(':', '')}`,
      name: genre, instructorId: insId, kind: pro ? 'PRO' : 'GENERAL', hall, level, note,
      weekday: [wd], startTime: start, durationMin: dur,
    });
  }
  return { instructors, courses };
}

