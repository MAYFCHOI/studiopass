import { create, type StoreApi, type UseBoundStore } from 'zustand';
import { persist } from 'zustand/middleware';
import dayjs from 'dayjs';
import type { State, Store, Member, Payment, Pass, Attendance, ScanResult } from '../types';
import { seed } from '../lib/seed';
import { settle } from '../lib/settlement';
import { passFits, activePassesOf } from '../lib/passes';
import { uid, normalizePhone, today, parseQr } from '../lib/util';

const DATA_KEYS: (keyof State)[] = ['studioName', 'members', 'instructors', 'courses', 'products', 'payments', 'passes', 'attendances', 'needsRealPrices'];

/** 데모: 브라우저 저장소 + 가짜 데이터. 로그인 없음, QR 은 AM1. */
export function createDemoStore(): UseBoundStore<StoreApi<Store>> {
  return create<Store>()(
    persist(
      (set, get) => {
        const assign = (paymentId: string, memberId: string) => {
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
        };
        const attendSync = (memberId: string, courseId: string): ScanResult => {
          const s = get();
          const member = s.members.find((m) => m.id === memberId);
          if (!member) return { ok: false, reason: 'UNKNOWN_MEMBER' };
          const who = { id: member.id, name: member.name };
          const course = s.courses.find((c) => c.id === courseId);
          if (!course) return { ok: false, reason: 'UNKNOWN_COURSE', member: who };
          const t = today();
          const dupe = s.attendances.find((a) => !a.cancelledAt && a.memberId === memberId && a.courseId === courseId && dayjs(a.attendedAt).format('YYYY-MM-DD') === t);
          if (dupe) return { ok: false, reason: 'ALREADY', member: who };
          const candidates = activePassesOf(s.passes, memberId).filter((p) => passFits(p, course));
          // 가정: 이 수업 전용 회차권 → 정규 공통 회차권 → 전문반 자유수강권, 같은 순위는 만료 임박 순
          const rank = (p: Pass) => (p.kind === 'PERIOD' ? 2 : p.courseId ? 0 : 1);
          candidates.sort((a, b) => rank(a) - rank(b) || a.validTo.localeCompare(b.validTo));
          const pass = candidates[0];
          if (!pass) {
            const expired = s.passes.filter((p) => p.memberId === memberId && passFits(p, course)).sort((a, b) => b.validTo.localeCompare(a.validTo))[0];
            return { ok: false, reason: expired ? (expired.remaining <= 0 ? 'EMPTY' : 'EXPIRED') : course.kind === 'PRO' ? 'PRO_ONLY' : 'NO_PASS', member: who };
          }
          const attendance: Attendance = { id: uid(), memberId, passId: pass.id, courseId, instructorId: course.instructorId, attendedAt: new Date().toISOString() };
          set({
            attendances: [...s.attendances, attendance],
            passes: s.passes.map((p) => (p.id === pass.id ? { ...p, remaining: p.remaining - 1 } : p)),
          });
          return { ok: true, member: who, pass: { ...pass, remaining: pass.remaining - 1 }, course, attendedAt: attendance.attendedAt };
        };
        const importSync = (rows: Omit<Payment, 'id'>[]) => {
          const s = get();
          const keyOf = (p: { externalId?: string; payerPhone?: string; paidAt: string; amount?: number }) => p.externalId ? 'x:' + p.externalId : `k:${p.payerPhone}|${p.paidAt}|${p.amount}`;
          const seen = new Set(s.payments.map(keyOf));
          let added = 0, dup = 0, matched = 0, cancelled = 0, cancelFailed = 0;
          const fresh: Payment[] = [];
          const refunds: string[] = [];
          for (const r of rows) {
            const k = keyOf(r);
            if (seen.has(k)) { if (r.status === 'CANCELLED' && r.externalId) refunds.push(r.externalId); else dup++; continue; }
            seen.add(k);
            fresh.push({ ...r, id: uid(), payerPhone: normalizePhone(r.payerPhone) });
            added++;
          }
          set({ payments: [...s.payments, ...fresh] });
          for (const p of fresh) {
            if (p.status !== 'APPROVED' || !p.payerPhone) continue;
            const m = get().members.find((x) => x.phone === p.payerPhone);
            if (m) { assign(p.id, m.id); matched++; }
          }
          // 서버와 같은 규칙: 같은 승인번호의 취소 행은 승인 결제를 취소, 출석에 쓰인 수강권이면 그대로 둔다
          for (const x of refunds) {
            const s2 = get();
            const pay = s2.payments.find((p) => p.externalId === x && p.status === 'APPROVED');
            if (!pay) { dup++; continue; }
            const used = pay.passId ? s2.attendances.filter((a) => a.passId === pay.passId && !a.cancelledAt).length : 0;
            if (used > 0) { cancelFailed++; continue; }
            set({ payments: s2.payments.map((p) => (p.id === pay.id ? { ...p, status: 'CANCELLED', passId: undefined } : p)), passes: s2.passes.filter((y) => y.id !== pay.passId) });
            cancelled++;
          }
          return { added, dup, matched, cancelled, cancelFailed };
        };

        return {
          ...seed(),
          me: { name: '데모', role: 'OWNER' },
          ready: true,
          online: true,
          load: async () => {},
          login: async () => ({ ok: true }),
          logout: async () => {},
          reset: async () => { set(seed()); },
          addMember: async (m) => {
            const s = get();
            const n = s.members.length + 1;
            const member: Member = { ...m, phone: normalizePhone(m.phone), id: 'm_' + uid(), memberNo: `${dayjs().year()}-${String(n).padStart(4, '0')}`, createdAt: new Date().toISOString() };
            set({ members: [...s.members, member] });
            // 등록 시 미배정 결제 중 전화 일치 건 자동 배정
            s.payments.filter((p) => !p.memberId && p.status === 'APPROVED' && p.payerPhone && p.payerPhone === member.phone).forEach((p) => assign(p.id, member.id));
            return member;
          },
          updateMember: async (id, patch) => { set((s) => ({ members: s.members.map((m) => (m.id === id ? { ...m, ...patch, phone: patch.phone !== undefined ? normalizePhone(patch.phone) : m.phone } : m)) })); },
          issueLink: async (memberId) => location.href.split('#')[0] + '#/members/' + memberId,
          recordMessage: async () => {},
          sendAlimtalkLink: async () => ({ ok: false, error: 'DEMO' }),
          upsertInstructor: async (i) => { set((s) => ({ instructors: s.instructors.some((x) => x.id === i.id) ? s.instructors.map((x) => (x.id === i.id ? i : x)) : [...s.instructors, i] })); },
          upsertCourse: async (c) => { set((s) => ({ courses: s.courses.some((x) => x.id === c.id) ? s.courses.map((x) => (x.id === c.id ? c : x)) : [...s.courses, c] })); },
          upsertProduct: async (p) => { set((s) => ({ products: s.products.some((x) => x.id === p.id) ? s.products.map((x) => (x.id === p.id ? p : x)) : [...s.products, p] })); },
          importPayments: async (rows) => importSync(rows),
          addPayment: async (p) => {
            const pay: Payment = { id: uid(), source: 'MANUAL', paidAt: p.paidAt ?? new Date().toISOString(), amount: p.amount, payerName: p.payerName, payerPhone: normalizePhone(p.payerPhone), productName: p.productName, status: 'APPROVED' };
            set((s) => ({ payments: [...s.payments, pay] }));
            assign(pay.id, p.memberId);
          },
          assignPayment: async (paymentId, memberId) => assign(paymentId, memberId),
          cancelPayment: async (paymentId) => {
            const s = get();
            const pay = s.payments.find((p) => p.id === paymentId);
            if (!pay) return { ok: true };
            // 서버와 같은 규칙: 출석에 쓰인 수강권의 결제는 취소하지 않는다
            const used = pay.passId ? s.attendances.filter((a) => a.passId === pay.passId && !a.cancelledAt).length : 0;
            if (used > 0) return { ok: false, used };
            set({
              payments: s.payments.map((p) => (p.id === paymentId ? { ...p, status: 'CANCELLED' } : p)),
              passes: s.passes.filter((x) => x.id !== pay.passId),
            });
            return { ok: true };
          },
          activePasses: (memberId) => activePassesOf(get().passes, memberId),
          attend: async ({ qr, memberId, courseId }) => {
            const id = qr !== undefined ? parseQr(qr) : memberId;
            if (!id) return { ok: false, reason: 'UNKNOWN_QR' };
            return attendSync(id, courseId);
          },
          cancelAttendance: async (id) => {
            const s = get();
            const a = s.attendances.find((x) => x.id === id);
            if (!a || a.cancelledAt) return;
            set({
              attendances: s.attendances.map((x) => (x.id === id ? { ...x, cancelledAt: new Date().toISOString() } : x)),
              passes: s.passes.map((p) => (p.id === a.passId ? { ...p, remaining: p.remaining + 1 } : p)),
            });
          },
          settlement: async (month) => settle(get(), month),
          settlementDetail: async () => null,
        };
      },
      {
        name: 'studiopass-v1',
        version: 4,
        // 데이터만 저장. me/ready/online 은 매번 새로.
        partialize: (s) => Object.fromEntries(DATA_KEYS.map((k) => [k, s[k]])) as Partial<Store>,
      },
    ),
  );
}
