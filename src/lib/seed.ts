import dayjs from 'dayjs';
import type { State, Member, Instructor, Course, Product, Payment, Pass, Attendance } from '../types';
import { uid, qrSig } from './util';

// Deterministic-ish demo data for a dance studio. Dates are relative to today so the demo never looks stale.
export function seed(): State {
  const instructors: Instructor[] = [
    { id: 'ins_yuna', name: '강사A', crew: '힙합', settlementType: 'RATIO', ratioInstructor: 50, perSessionFee: 0 },
    { id: 'ins_jay', name: '강사B', crew: '하우스', settlementType: 'RATIO', ratioInstructor: 40, perSessionFee: 0 },
    { id: 'ins_hodu', name: '강사C', crew: '하우스', settlementType: 'PER_SESSION', ratioInstructor: 0, perSessionFee: 60000 },
  ];
  const courses: Course[] = [
    { id: 'c_choreo', name: '힙합 기초', instructorId: 'ins_yuna', kind: 'GENERAL', weekday: [1, 3], startTime: '19:00', durationMin: 80 },
    { id: 'c_hiphop', name: '하우스 기초', instructorId: 'ins_jay', kind: 'GENERAL', weekday: [2, 4], startTime: '20:30', durationMin: 80 },
    { id: 'c_waack', name: '하우스 오픈', instructorId: 'ins_hodu', kind: 'GENERAL', weekday: [6], startTime: '15:00', durationMin: 90 },
    { id: 'c_kpop', name: '힙합 중급', instructorId: 'ins_yuna', kind: 'GENERAL', weekday: [5], startTime: '19:00', durationMin: 80 },
    { id: 'c_pro', name: '힙합 전문반', instructorId: 'ins_yuna', kind: 'PRO', weekday: [1, 2, 3, 4, 5], startTime: '17:00', durationMin: 120 },
  ];
  const products: Product[] = [
    { id: 'p_choreo8', name: '힙합 기초 8회', courseId: 'c_choreo', passKind: 'COUNT', count: 8, periodDays: 60, price: 160000 },
    { id: 'p_hiphop8', name: '하우스 기초 8회', courseId: 'c_hiphop', passKind: 'COUNT', count: 8, periodDays: 60, price: 160000 },
    { id: 'p_waack4', name: '하우스 오픈 4회', courseId: 'c_waack', passKind: 'COUNT', count: 4, periodDays: 45, price: 100000 },
    { id: 'p_kpop4', name: '힙합 중급 4회', courseId: 'c_kpop', passKind: 'COUNT', count: 4, periodDays: 45, price: 80000 },
    { id: 'p_pro', name: '힙합 전문반 월정액', passKind: 'PERIOD', count: 10, periodDays: 30, price: 350000 },
  ];
  const names = ['김서연', '이도윤', '박지우', '최하은', '정민준', '강지민', '조예린', '윤시우', '장수아', '임건우', '한유진', '오채원'];
  const members: Member[] = names.map((n, i) => ({
    id: 'm_' + (i + 1).toString().padStart(3, '0') + qrSig(n).slice(0, 3),
    memberNo: '2026-' + (i + 1).toString().padStart(4, '0'),
    name: n,
    phone: '010' + (2000 + i * 137).toString().padStart(4, '0') + (3100 + i * 211).toString().padStart(4, '0'),
    createdAt: dayjs().subtract(60 - i * 3, 'day').toISOString(),
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
  const attend = (pass: Pass, daysAgo: number, courseId?: string) => {
    const cid = courseId ?? pass.courseId!;
    const c = courses.find((x) => x.id === cid)!;
    if (pass.remaining <= 0) return;
    pass.remaining--;
    attendances.push({
      id: uid(), memberId: pass.memberId, passId: pass.id, courseId: cid, instructorId: c.instructorId,
      attendedAt: dayjs().subtract(daysAgo, 'day').hour(Number(c.startTime.slice(0, 2))).minute(5).toISOString(),
    });
  };
  // general members
  members.slice(0, 9).forEach((m, i) => {
    const p = [products[0], products[1], products[2], products[3]][i % 4];
    const pass = buy(m, p, 28 + i);
    const n = 2 + (i % 4);
    for (let k = 0; k < n; k++) attend(pass, (i + k * 3) % 10); // 최근 10일 안에 분산, 일부는 오늘
  });
  // pro members: 월정액, 여러 강사 수업을 자유 수강
  members.slice(9, 12).forEach((m, i) => {
    const pass = buy(m, products[4], 12 + i);
    const picks = ['c_choreo', 'c_hiphop', 'c_waack', 'c_kpop', 'c_choreo', 'c_hiphop'];
    for (let k = 0; k < 4 + i; k++) attend(pass, (i + k * 2) % 9, picks[k % picks.length]);
  });
  // 미배정 결제 2건: 휴대폰이 회원과 안 맞음
  payments.push({
    id: uid(), source: 'KIOSK', externalId: '30099123', paidAt: dayjs().subtract(1, 'day').hour(19).toISOString(),
    amount: 160000, payerName: '신예은', payerPhone: '01055550123', productName: '하우스 기초 8회', status: 'APPROVED',
  });
  payments.push({
    id: uid(), source: 'KIOSK', externalId: '30099124', paidAt: dayjs().subtract(2, 'hour').toISOString(),
    amount: 80000, payerName: '최하은', payerPhone: '', productName: '힙합 중급 4회', status: 'APPROVED',
  });
  return { studioName: 'studiopass', members, instructors, courses, products, payments, passes, attendances };
}
