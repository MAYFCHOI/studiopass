import { create, type StoreApi, type UseBoundStore } from 'zustand';
import { persist } from 'zustand/middleware';
import dayjs from 'dayjs';
import type { State, Store, Member, Payment, Pass, Attendance, ScanResult, AssignResult, ImportResult, ImportRow } from '../types';
import { seed } from '../lib/seed';
import { settle } from '../lib/settlement';
import { passFits, activePassesOf } from '../lib/passes';
import { uid, normalizePhone, today, parseQr } from '../lib/util';
import { newRequestKey } from '../lib/useBusy';

const DATA_KEYS: (keyof State)[] = ['studioName', 'members', 'instructors', 'courses', 'products', 'payments', 'passes', 'attendances', 'needsRealPrices'];

/** 데모: 브라우저 저장소 + 가짜 데이터. 로그인 없음, QR 은 AM1. */
export function createDemoStore(): UseBoundStore<StoreApi<Store>> {
  return create<Store>()(
    persist(
      (set, get) => {
        const squash = (x: string) => (x ?? '').replace(/\s+/g, '');
        /** 서버 findProduct 와 같은 규칙: 띄어쓰기 무시, 정확히 같은 이름 → 가장 긴 포함 이름. 쉬는 상품은 제외. */
        const findProduct = (name: string) => {
          const n = squash(name); if (!n) return undefined;
          const live = get().products.filter((x) => x.active !== false);
          return live.find((x) => squash(x.name) === n) ?? live.filter((x) => squash(x.name) && n.includes(squash(x.name))).sort((a, b) => squash(b.name).length - squash(a.name).length)[0];
        };
        const usedOf = (passId?: string) => (passId ? get().attendances.filter((a) => a.passId === passId && !a.cancelledAt).length : 0);
        /** 서버 assignPayment 와 같은 규칙(같은 회원이면 그대로, 다른 회원이면 안 쓴 수강권을 옮김). */
        const assign = (paymentId: string, memberId: string): AssignResult => {
          const s = get();
          const pay = s.payments.find((p) => p.id === paymentId);
          if (!pay) return { ok: true };
          if (pay.status !== 'APPROVED') return { ok: false, error: 'PAYMENT_CANCELLED' };
          if (pay.passId) {
            if (pay.memberId === memberId) return { ok: true, passId: pay.passId };
            const used = usedOf(pay.passId);
            if (used > 0) return { ok: false, error: 'PASS_IN_USE', used };
            set({ payments: s.payments.map((p) => (p.id === paymentId ? { ...p, memberId } : p)), passes: s.passes.map((x) => (x.id === pay.passId ? { ...x, memberId } : x)) });
            return { ok: true, passId: pay.passId, moved: true };
          }
          const prod = findProduct(pay.productName);
          let pass: Pass | undefined;
          if (prod) {
            const from = dayjs(pay.paidAt);
            pass = { id: uid(), memberId, productId: prod.id, courseId: prod.courseId, kind: prod.passKind, totalCount: prod.count, remaining: prod.count, validFrom: from.format('YYYY-MM-DD'), validTo: from.add(prod.periodDays, 'day').format('YYYY-MM-DD'), paymentId: pay.id, price: pay.amount };
          }
          set({
            payments: s.payments.map((p) => (p.id === paymentId ? { ...p, memberId, passId: pass?.id } : p)),
            passes: pass ? [...s.passes, pass] : s.passes,
          });
          return { ok: true, passId: pass?.id };
        };
        const cancelSync = (paymentId: string): { ok: true } | { ok: false; used: number } => {
          const s = get();
          const pay = s.payments.find((p) => p.id === paymentId);
          if (!pay || pay.status === 'CANCELLED') return { ok: true };
          // 서버와 같은 규칙: 출석에 쓰인 수강권의 결제는 취소하지 않는다
          const used = usedOf(pay.passId);
          if (used > 0) return { ok: false, used };
          set({
            payments: s.payments.map((p) => (p.id === paymentId ? { ...p, status: 'CANCELLED', passId: undefined, review: undefined } : p)),
            passes: s.passes.filter((x) => x.id !== pay.passId),
            attendances: s.attendances.filter((a) => !pay.passId || a.passId !== pay.passId),
          });
          return { ok: true };
        };
        const patchPayment = (id: string, patch: Partial<Payment>) => set((s) => ({ payments: s.payments.map((p) => (p.id === id ? { ...p, ...patch } : p)) }));
        /** 그 번호를 쓰는 회원이 한 명일 때만 자동 연결(서버와 같은 규칙). */
        const onlyMember = (phone?: string) => { const m = get().members.filter((x) => !x.erased && phone && x.phone === phone); return m.length === 1 ? m[0] : undefined; };
        const attendSync = (memberId: string, courseId: string): ScanResult => {
          const s = get();
          const member = s.members.find((m) => m.id === memberId && !m.erased);
          if (!member) return { ok: false, reason: 'UNKNOWN_MEMBER' };
          const who = { id: member.id, name: member.name };
          const course = s.courses.find((c) => c.id === courseId);
          if (!course) return { ok: false, reason: 'UNKNOWN_COURSE', member: who };
          if (course.active === false) return { ok: false, reason: 'INACTIVE_COURSE', member: who };
          const t = today();
          const dupe = s.attendances.find((a) => !a.cancelledAt && a.memberId === memberId && a.courseId === courseId && dayjs(a.attendedAt).format('YYYY-MM-DD') === t);
          if (dupe) { const p = s.passes.find((x) => x.id === dupe.passId); return { ok: false, reason: 'ALREADY', member: who, remaining: p?.remaining, total: p?.totalCount, validTo: p?.validTo }; }
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
        const importSync = (rows: ImportRow[], batchId: string): ImportResult => {
          const s = get();
          const keyOf = (p: { externalId?: string; payerPhone?: string; paidAt: string; amount?: number }) => p.externalId ? 'x:' + p.externalId : `k:${p.payerPhone}|${p.paidAt}|${p.amount}`;
          const stored = new Map(s.payments.map((p) => [keyOf(p), p]));
          const seen = new Set<string>();
          const ext = new Map<string, number>();
          for (const r of rows) if (r.externalId) ext.set(r.externalId, (ext.get(r.externalId) ?? 0) + 1);
          let added = 0, dup = 0, matched = 0, cancelled = 0, cancelFailed = 0, refundUnmatched = 0;
          const dupBatches = new Map<string, number>();
          const fresh: Payment[] = [];
          const refundsSame: string[] = [];
          const refundsNew: Payment[] = [];
          for (const { raw: _raw, line: _line, ...r0 } of rows) {
            const r = { ...r0, payerPhone: normalizePhone(r0.payerPhone) };
            const k = keyOf(r);
            if (seen.has(k) || stored.has(k)) {
              if (r.status === 'CANCELLED' && r.externalId) { refundsSame.push(r.externalId); continue; }
              dup++;
              const b = stored.get(k)?.importBatchId;
              if (b && b !== batchId) dupBatches.set(b, (dupBatches.get(b) ?? 0) + 1);
              continue;
            }
            seen.add(k);
            const p: Payment = { ...r, id: uid(), importBatchId: batchId };
            fresh.push(p);
            added++;
            if (p.status === 'CANCELLED' && (!p.externalId || ext.get(p.externalId) === 1)) refundsNew.push(p);
          }
          set({ payments: [...s.payments, ...fresh] });
          for (const p of fresh) {
            if (p.status !== 'APPROVED' || !p.payerPhone) continue;
            const m = onlyMember(p.payerPhone);
            if (m) { assign(p.id, m.id); matched++; }
          }
          // 서버와 같은 규칙: 같은 승인번호의 취소 행은 승인 결제를 취소, 출석에 쓰인 수강권이면 그대로 두고 확인 필요
          for (const x of refundsSame) {
            const pay = get().payments.find((p) => p.externalId === x && p.status === 'APPROVED');
            if (!pay) { dup++; continue; }
            if (cancelSync(pay.id).ok) cancelled++; else { patchPayment(pay.id, { review: 'REFUND_IN_USE' }); cancelFailed++; }
          }
          // 승인번호가 다른 환불: 같은 전화·금액·상품, 30일 안, 출석 없는 가장 최근 승인 결제
          for (const f of refundsNew) {
            const s2 = get();
            const taken = new Set(s2.payments.map((p) => p.refundOf).filter(Boolean));
            const t = dayjs(f.paidAt);
            const cands = f.payerPhone ? s2.payments.filter((p) => p.status === 'APPROVED' && p.id !== f.id && !taken.has(p.id) && p.payerPhone === f.payerPhone && p.amount === f.amount && p.productName === f.productName && !dayjs(p.paidAt).isAfter(t) && !dayjs(p.paidAt).isBefore(t.subtract(30, 'day'))).sort((a, b) => b.paidAt.localeCompare(a.paidAt)) : [];
            const free = cands.find((p) => usedOf(p.passId) === 0);
            if (free) { cancelSync(free.id); patchPayment(f.id, { refundOf: free.id }); cancelled++; }
            else if (cands.length) { patchPayment(cands[0].id, { review: 'REFUND_IN_USE' }); patchPayment(f.id, { refundOf: cands[0].id }); cancelFailed++; }
            else { patchPayment(f.id, { review: 'REFUND_UNMATCHED' }); refundUnmatched++; }
          }
          return { added, dup, matched, cancelled, cancelFailed, refundUnmatched, rejected: [], rejectedCount: 0, batchId, dupBatches: [...dupBatches].map(([b, n]) => ({ batchId: b, count: n })).sort((a, b) => b.count - a.count) };
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
            // 등록 시 미배정 결제 중 전화 일치 건 자동 배정(그 번호 회원이 한 명일 때만)
            if (onlyMember(member.phone)) s.payments.filter((p) => !p.memberId && p.status === 'APPROVED' && p.payerPhone && p.payerPhone === member.phone).forEach((p) => assign(p.id, member.id));
            return member;
          },
          updateMember: async (id, patch) => {
            const before = get().members.find((m) => m.id === id)?.phone;
            set((s) => ({ members: s.members.map((m) => (m.id === id ? { ...m, ...patch, phone: patch.phone !== undefined ? normalizePhone(patch.phone) : m.phone } : m)) }));
            const phone = get().members.find((m) => m.id === id)?.phone;
            // 번호를 고치면 그 번호로 기다리던 결제를 연결(서버와 같은 규칙)
            if (phone && phone !== before && onlyMember(phone)?.id === id) get().payments.filter((p) => !p.memberId && !p.passId && p.status === 'APPROVED' && p.payerPhone === phone).forEach((p) => assign(p.id, id));
          },
          eraseMember: async (id) => {
            set((s) => ({
              members: s.members.map((m) => (m.id === id ? { ...m, name: '삭제된 회원', phone: '', memo: undefined, erased: true } : m)),
              payments: s.payments.map((p) => (p.memberId === id ? { ...p, payerName: undefined, payerPhone: '' } : p)),
            }));
          },
          erasePayer: async (paymentId) => { set((s) => ({ payments: s.payments.map((p) => (p.id === paymentId && !p.memberId ? { ...p, payerName: undefined, payerPhone: '' } : p)) })); },
          issueLink: async (memberId) => location.href.split('#')[0] + '#/members/' + memberId,
          recordMessage: async () => {},
          sendAlimtalkLink: async () => ({ ok: false, error: 'DEMO' }),
          upsertInstructor: async (i) => { set((s) => ({ instructors: s.instructors.some((x) => x.id === i.id) ? s.instructors.map((x) => (x.id === i.id ? i : x)) : [...s.instructors, i] })); },
          upsertCourse: async (c) => { set((s) => ({ courses: s.courses.some((x) => x.id === c.id) ? s.courses.map((x) => (x.id === c.id ? c : x)) : [...s.courses, c] })); },
          upsertProduct: async (p) => { set((s) => ({ products: s.products.some((x) => x.id === p.id) ? s.products.map((x) => (x.id === p.id ? p : x)) : [...s.products, p] })); },
          importPayments: async (rows, opts) => importSync(rows, opts?.batchId ?? newRequestKey()),
          revertImport: async (batchId) => {
            const s = get();
            let removed = 0, kept = 0;
            const drop = new Set<string>(); const dropPasses = new Set<string>();
            for (const p of s.payments.filter((x) => x.importBatchId === batchId)) {
              if (usedOf(p.passId) > 0) { kept++; continue; }
              drop.add(p.id); if (p.passId) dropPasses.add(p.passId); removed++;
            }
            set({
              payments: s.payments.filter((p) => !drop.has(p.id)).map((p) => (p.refundOf && drop.has(p.refundOf) ? { ...p, refundOf: undefined } : p)),
              passes: s.passes.filter((x) => !dropPasses.has(x.id)),
              attendances: s.attendances.filter((a) => !dropPasses.has(a.passId)),
            });
            return { removed, kept };
          },
          linkRefund: async (refundId, originalId) => {
            const f = get().payments.find((p) => p.id === refundId);
            const o = get().payments.find((p) => p.id === originalId);
            if (!f || f.status !== 'CANCELLED' || !o || o.status !== 'APPROVED') return { ok: true };
            const r = cancelSync(originalId);
            if (!r.ok) return r;
            patchPayment(refundId, { review: undefined, refundOf: originalId });
            return { ok: true };
          },
          clearReview: async (paymentId) => { patchPayment(paymentId, { review: undefined }); },
          memberHistory: async (memberId) => {
            const s = get();
            return { attendances: s.attendances.filter((a) => a.memberId === memberId), payments: s.payments.filter((p) => p.memberId === memberId), passes: s.passes.filter((p) => p.memberId === memberId) };
          },
          addPayment: async (p) => {
            const pay: Payment = { id: uid(), source: 'MANUAL', paidAt: p.paidAt ?? new Date().toISOString(), amount: p.amount, payerName: p.payerName, payerPhone: normalizePhone(p.payerPhone), productName: p.productName, status: 'APPROVED' };
            set((s) => ({ payments: [...s.payments, pay] }));
            assign(pay.id, p.memberId);
          },
          assignPayment: async (paymentId, memberId) => assign(paymentId, memberId),
          cancelPayment: async (paymentId) => cancelSync(paymentId),
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
