import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import dayjs from 'dayjs';
import type { State, Member, Payment, Pass, Attendance, Product, Instructor, Course } from './types';
import { seed } from './lib/seed';
import { uid, normalizePhone, today } from './lib/util';

export type ScanResult =
  | { ok: true; member: Member; pass: Pass; course: Course; attendance: Attendance }
  | { ok: false; reason: string; member?: Member };

interface Actions {
  reset: () => void;
  addMember: (m: Omit<Member, 'id' | 'memberNo' | 'createdAt'>) => Member;
  updateMember: (id: string, patch: Partial<Member>) => void;
  upsertInstructor: (i: Instructor) => void;
  upsertCourse: (c: Course) => void;
  upsertProduct: (p: Product) => void;
  /** 결제 적재. externalId 또는 (전화+시각+금액) 으로 중복 제거. 전화 매칭되면 회원 배정 + 수강권 생성. */
  importPayments: (rows: Omit<Payment, 'id'>[]) => { added: number; dup: number; matched: number };
  assignPayment: (paymentId: string, memberId: string) => void;
  cancelPayment: (paymentId: string) => void;
  attend: (memberId: string, courseId: string) => ScanResult;
  cancelAttendance: (id: string) => void;
  activePasses: (memberId: string) => Pass[];
}

export const useStore = create<State & Actions>()(
  persist(
    (set, get) => ({
      ...seed(),
      reset: () => set(seed()),
      addMember: (m) => {
        const s = get();
        const n = s.members.length + 1;
        const member: Member = { ...m, phone: normalizePhone(m.phone), id: 'm_' + uid(), memberNo: `${dayjs().year()}-${String(n).padStart(4, '0')}`, createdAt: new Date().toISOString() };
        set({ members: [...s.members, member] });
        // 등록 시 미배정 결제 중 전화 일치 건 자동 배정
        s.payments.filter((p) => !p.memberId && p.status === 'APPROVED' && p.payerPhone && p.payerPhone === member.phone).forEach((p) => get().assignPayment(p.id, member.id));
        return member;
      },
      updateMember: (id, patch) => set((s) => ({ members: s.members.map((m) => (m.id === id ? { ...m, ...patch, phone: patch.phone !== undefined ? normalizePhone(patch.phone) : m.phone } : m)) })),
      upsertInstructor: (i) => set((s) => ({ instructors: s.instructors.some((x) => x.id === i.id) ? s.instructors.map((x) => (x.id === i.id ? i : x)) : [...s.instructors, i] })),
      upsertCourse: (c) => set((s) => ({ courses: s.courses.some((x) => x.id === c.id) ? s.courses.map((x) => (x.id === c.id ? c : x)) : [...s.courses, c] })),
      upsertProduct: (p) => set((s) => ({ products: s.products.some((x) => x.id === p.id) ? s.products.map((x) => (x.id === p.id ? p : x)) : [...s.products, p] })),
      importPayments: (rows) => {
        const s = get();
        const keyOf = (p: { externalId?: string; payerPhone?: string; paidAt: string; amount: number }) => p.externalId ? 'x:' + p.externalId : `k:${p.payerPhone}|${p.paidAt}|${p.amount}`;
        const seen = new Set(s.payments.map(keyOf));
        let added = 0, dup = 0, matched = 0;
        const fresh: Payment[] = [];
        for (const r of rows) {
          const k = keyOf(r);
          if (seen.has(k)) { dup++; continue; }
          seen.add(k);
          fresh.push({ ...r, id: uid(), payerPhone: normalizePhone(r.payerPhone) });
          added++;
        }
        set({ payments: [...s.payments, ...fresh] });
        for (const p of fresh) {
          if (p.status !== 'APPROVED' || !p.payerPhone) continue;
          const m = get().members.find((x) => x.phone === p.payerPhone);
          if (m) { get().assignPayment(p.id, m.id); matched++; }
        }
        return { added, dup, matched };
      },
      assignPayment: (paymentId, memberId) => {
        const s = get();
        const pay = s.payments.find((p) => p.id === paymentId);
        if (!pay || pay.passId) return;
        const prod = s.products.find((x) => x.name.trim() === pay.productName.trim()) ?? s.products.find((x) => pay.productName.includes(x.name) || x.name.includes(pay.productName));
        let pass: Pass | undefined;
        if (prod) {
          const from = dayjs(pay.paidAt);
          pass = { id: uid(), memberId, productId: prod.id, courseId: prod.courseId, kind: prod.passKind, totalCount: prod.count, remaining: prod.count, validFrom: from.format('YYYY-MM-DD'), validTo: from.add(prod.periodDays, 'day').format('YYYY-MM-DD'), paymentId: pay.id, price: pay.amount };
        }
        set({
          payments: s.payments.map((p) => (p.id === paymentId ? { ...p, memberId, passId: pass?.id } : p)),
          passes: pass ? [...s.passes, pass] : s.passes,
        });
      },
      cancelPayment: (paymentId) => {
        const s = get();
        const pay = s.payments.find((p) => p.id === paymentId);
        if (!pay) return;
        set({
          payments: s.payments.map((p) => (p.id === paymentId ? { ...p, status: 'CANCELLED' } : p)),
          passes: s.passes.filter((x) => x.id !== pay.passId),
        });
      },
      activePasses: (memberId) => {
        const t = today();
        return get().passes
          .filter((p) => p.memberId === memberId && p.remaining > 0 && p.validFrom <= t && p.validTo >= t)
          .sort((a, b) => a.validTo.localeCompare(b.validTo)); // 만료 임박 순
      },
      attend: (memberId, courseId) => {
        const s = get();
        const member = s.members.find((m) => m.id === memberId);
        if (!member) return { ok: false, reason: '등록되지 않은 QR 입니다' };
        const course = s.courses.find((c) => c.id === courseId);
        if (!course) return { ok: false, reason: '수업을 선택해 주세요', member };
        const t = today();
        const dupe = s.attendances.find((a) => !a.cancelledAt && a.memberId === memberId && a.courseId === courseId && dayjs(a.attendedAt).format('YYYY-MM-DD') === t);
        if (dupe) return { ok: false, reason: '오늘 이 수업은 이미 출석했어요', member };
        const candidates = get().activePasses(memberId).filter((p) => (p.kind === 'PERIOD' ? true : p.courseId === courseId));
        // 가정: 수업 전용 회차권 먼저, 그다음 전문반 자유수강권
        candidates.sort((a, b) => (a.kind === b.kind ? a.validTo.localeCompare(b.validTo) : a.kind === 'COUNT' ? -1 : 1));
        const pass = candidates[0];
        if (!pass) {
          const expired = s.passes.find((p) => p.memberId === memberId && (p.courseId === courseId || p.kind === 'PERIOD'));
          return { ok: false, reason: expired ? (expired.remaining <= 0 ? '남은 횟수가 없어요. 결제가 필요해요' : '수강권 기간이 지났어요') : '이 수업의 수강권이 없어요', member };
        }
        const attendance: Attendance = { id: uid(), memberId, passId: pass.id, courseId, instructorId: course.instructorId, attendedAt: new Date().toISOString() };
        set({
          attendances: [...s.attendances, attendance],
          passes: s.passes.map((p) => (p.id === pass.id ? { ...p, remaining: p.remaining - 1 } : p)),
        });
        return { ok: true, member, pass: { ...pass, remaining: pass.remaining - 1 }, course, attendance };
      },
      cancelAttendance: (id) => {
        const s = get();
        const a = s.attendances.find((x) => x.id === id);
        if (!a || a.cancelledAt) return;
        set({
          attendances: s.attendances.map((x) => (x.id === id ? { ...x, cancelledAt: new Date().toISOString() } : x)),
          passes: s.passes.map((p) => (p.id === a.passId ? { ...p, remaining: p.remaining + 1 } : p)),
        });
      },
    }),
    { name: 'studiopass-v1', version: 3 },
  ),
);
