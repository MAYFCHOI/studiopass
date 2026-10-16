import dayjs from 'dayjs';
import type { State, Member, Instructor, Course, Product, Payment, Pass, Attendance, Hall } from '../types';
import { uid, qrSig } from './util';

/**
 * THE DEPTH DANCE STUDIO 정규 시간표 (2026-10 포스터 기준, docs/brand/schedule-*.png).
 * 한 칸 = 수업 하나. [홀, 요일(0=일), 시작, 분, 장르, 강사, 레벨, 띠 문구, 전문반]
 * 가정: 각 홀 첫 줄은 띠 문구(HUB "WarmUp Training LV.0", LAB "PRO Class")가 가리키는 수업이다.
 */
type Row = [Hall, number, string, number, string, string, string | undefined, string?, boolean?];
const W = 'WarmUp Training';
const SCHEDULE: Row[] = [
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

export function buildSchedule(): { instructors: Instructor[]; courses: Course[] } {
  const instructors: Instructor[] = [];
  const courses: Course[] = [];
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

// 데모 회원·결제·출석. 회원은 가명, 시간표·강사는 실제. 날짜는 오늘 기준이라 데모가 낡지 않는다.
export function seed(): State {
  const { instructors, courses } = buildSchedule();
  // 가격·회차·기간은 아직 받지 못한 예시값
  const products: Product[] = [
    { id: 'p_one', name: '정규 클래스 1회권', passKind: 'COUNT', count: 1, periodDays: 7, price: 30000 },
    { id: 'p_four', name: '정규 클래스 4회권', passKind: 'COUNT', count: 4, periodDays: 30, price: 100000 },
    { id: 'p_eight', name: '정규 클래스 8회권', passKind: 'COUNT', count: 8, periodDays: 60, price: 180000 },
    { id: 'p_pro', name: '전문반 월정액', passKind: 'PERIOD', count: 12, periodDays: 30, price: 350000 },
  ];
  const names = ['김서연', '이도윤', '박지우', '최하은', '정민준', '강지민', '조예린', '윤시우', '장수아', '임건우', '한유진', '오채원'];
  const members: Member[] = names.map((n, i) => ({
    id: 'm_' + (i + 1).toString().padStart(3, '0') + qrSig(n).slice(0, 3),
    memberNo: '2026-' + (i + 1).toString().padStart(4, '0'),
    name: n,
    phone: '010' + (2000 + i * 137).toString().padStart(4, '0') + (3100 + i * 211).toString().padStart(4, '0'),
    createdAt: dayjs().subtract(120 - i * 9, 'day').toISOString(),
  }));

  const payments: Payment[] = [];
  const passes: Pass[] = [];
  const attendances: Attendance[] = [];
  const buy = (m: Member, p: Product, daysAgo: number) => {
    const paidAt = dayjs().subtract(daysAgo, 'day').hour(18).minute(12);
    const pay: Payment = {
      id: uid(), source: 'KIOSK', externalId: String(30000000 + Math.floor(Math.random() * 9999999)),
      paidAt: paidAt.toISOString(), amount: p.price, payerName: m.name, payerPhone: m.phone,
      productName: p.name, status: 'APPROVED', memberId: m.id,
    };
    const pass: Pass = {
      id: uid(), memberId: m.id, productId: p.id, courseId: p.courseId, kind: p.passKind,
      totalCount: p.count, remaining: p.count, validFrom: paidAt.format('YYYY-MM-DD'),
      validTo: paidAt.add(p.periodDays, 'day').format('YYYY-MM-DD'), paymentId: pay.id, price: p.price,
    };
    pay.passId = pass.id;
    payments.push(pay); passes.push(pass);
    return pass;
  };
  // daysAgo 날짜의 요일에 실제로 있는 수업 중 하나를 고른다(그날 수업이 없으면 건너뜀)
  const attend = (pass: Pass, daysAgo: number, pick: number, proOk = false) => {
    if (pass.remaining <= 0) return;
    const day = dayjs().subtract(daysAgo, 'day');
    const opts = courses.filter((c) => c.weekday.includes(day.day()) && (proOk || c.kind === 'GENERAL'));
    if (!opts.length) return;
    const c = opts[pick % opts.length];
    if (attendances.some((a) => a.memberId === pass.memberId && a.courseId === c.id && dayjs(a.attendedAt).isSame(day, 'day'))) return;
    pass.remaining--;
    attendances.push({
      id: uid(), memberId: pass.memberId, passId: pass.id, courseId: c.id, instructorId: c.instructorId,
      attendedAt: day.hour(Number(c.startTime.slice(0, 2))).minute(Number(c.startTime.slice(3)) + 3).toISOString(),
    });
  };
  // 과거 이력: 등급(누적 출석) 차이가 보이도록 회원마다 지난 수강권 몇 장을 다 쓴 상태로 만든다
  members.slice(0, 9).forEach((m, i) => {
    const old = (i * 7) % 5; // 0~4장
    for (let k = 0; k < old; k++) {
      const pass = buy(m, products[2], 110 - k * 20 - i);
      for (let j = 0; j < 8; j++) attend(pass, 109 - k * 20 - i - j * 2, i + j);
    }
    const p = [products[2], products[1], products[2], products[0]][i % 4];
    const pass = buy(m, p, 20 + i);
    const n = 1 + (i % 4);
    for (let k = 0; k < n; k++) attend(pass, (i + k * 3) % 10, i + k);
  });
  // 전문반: 월정액, 여러 강사 수업과 전문반 수업을 자유 수강
  members.slice(9, 12).forEach((m, i) => {
    const pass = buy(m, products[3], 12 + i);
    for (let k = 0; k < 6 + i; k++) attend(pass, (i + k * 2) % 12, k * 2 + i, true);
  });
  // 확인 필요 결제 2건: 휴대폰이 회원과 안 맞음
  payments.push({
    id: uid(), source: 'KIOSK', externalId: '30099123', paidAt: dayjs().subtract(1, 'day').hour(19).toISOString(),
    amount: 180000, payerName: '신예은', payerPhone: '01055550123', productName: '정규 클래스 8회권', status: 'APPROVED',
  });
  payments.push({
    id: uid(), source: 'KIOSK', externalId: '30099124', paidAt: dayjs().subtract(2, 'hour').toISOString(),
    amount: 100000, payerName: '최하은', payerPhone: '', productName: '정규 클래스 4회권', status: 'APPROVED',
  });
  return { studioName: 'THE DEPTH', members, instructors, courses, products, payments, passes, attendances };
}
