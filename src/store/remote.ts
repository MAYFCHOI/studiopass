import { create, type StoreApi, type UseBoundStore } from 'zustand';
import type { State, Store, Me, Member, Instructor, Pass, SettlementLine, SettlementDetail, ScanFail, ImportResult } from '../types';
import { api, ApiError } from '../api/client';
import { activePassesOf } from '../lib/passes';
import { toast } from '../components/Toast';

type Bootstrap = Omit<State, 'needsRealPrices'> & { me: Me; needsRealPrices: boolean };
type ServerLine = Omit<SettlementLine, 'instructor'> & { instructorId: string; name: string; ratioInstructor: number; perSessionFee: number };
type AttendRes =
  | { ok: true; attendanceId: string; memberId: string; passId: string; remaining: number; total: number; validTo: string; member?: { id: string; name: string } }
  | { ok: false; reason: ScanFail; memberId?: string; member?: { id: string; name: string } };

const EMPTY: State = { studioName: '', members: [], instructors: [], courses: [], products: [], payments: [], passes: [], attendances: [], needsRealPrices: false, alimtalkEnabled: false, tiers: [] };
const IMPORT_CHUNK = 2000; // 서버 한도

/** 서버 모드: 쿠키 세션 + /api. 변경 후에는 /bootstrap 을 다시 받아 화면을 맞춘다(학원 규모라 단순하게). */
export function createRemoteStore(): UseBoundStore<StoreApi<Store>> {
  return create<Store>()((set, get) => {
    /** 요청 하나. 끊기면 online=false, 세션이 끝났으면 로그인 화면으로. */
    async function call<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
      try {
        const r = await api<T>(path, init);
        if (!get().online) set({ online: true });
        return r;
      } catch (e) {
        if (e instanceof TypeError) set({ online: false });
        else if (e instanceof ApiError && e.status === 401) set({ ...EMPTY, me: null });
        throw e;
      }
    }
    async function refresh() {
      const b = await call<Bootstrap>('/bootstrap');
      set({
        me: { name: b.me.name, role: b.me.role, staffId: b.me.staffId },
        studioName: b.studioName, needsRealPrices: !!b.needsRealPrices, alimtalkEnabled: b.alimtalkEnabled ?? false, tiers: b.tiers ?? [],
        members: b.members, instructors: b.instructors, courses: b.courses, products: b.products, passes: b.passes, payments: b.payments, attendances: b.attendances,
      });
    }
    /** 변경 요청: 실패는 토스트로 알리고 다시 던진다(화면은 성공 토스트를 건너뛴다). 성공하면 다시 받는다. */
    async function mutate<T>(path: string, init: { method?: string; body?: unknown }): Promise<T> {
      let r: T;
      try { r = await call<T>(path, init); } catch (e) {
        if (e instanceof TypeError) toast('인터넷 연결이 끊겼어요');
        else if (!(e instanceof ApiError && e.status === 401)) toast('저장하지 못했어요. 다시 시도해 주세요');
        throw e;
      }
      await refresh().catch(() => {});
      return r;
    }
    const post = <T = unknown>(path: string, body?: unknown) => mutate<T>(path, { method: 'POST', body });
    const put = (path: string, body: unknown) => mutate(path, { method: 'PUT', body }).then(() => {});

    return {
      ...EMPTY,
      me: null,
      ready: false,
      online: true,
      load: async () => {
        try { await refresh(); } catch (e) {
          if (e instanceof ApiError && e.status === 401) set({ me: null });
        } finally { set({ ready: true }); }
      },
      login: async (loginId, password) => {
        try { await api('/auth/login', { method: 'POST', body: { loginId, password } }); } catch (e) {
          if (e instanceof ApiError) return { ok: false, error: e.status === 429 ? 'LIMIT' : 'INVALID' };
          set({ online: false });
          return { ok: false };
        }
        set({ online: true });
        await get().load();
        return { ok: true };
      },
      logout: async () => {
        await api('/auth/logout', { method: 'POST' }).catch(() => {});
        set({ ...EMPTY, me: null });
      },
      addMember: (m) => post<Member & { assigned: number }>('/members', m),
      updateMember: (id, patch) => mutate(`/members/${id}`, { method: 'PATCH', body: { name: patch.name, phone: patch.phone, memo: patch.memo } }).then(() => {}),
      issueLink: async (memberId) => (await call<{ url: string }>(`/members/${memberId}/link`, { method: 'POST' })).url,
      recordMessage: async (memberId) => { await call(`/members/${memberId}/messages`, { method: 'POST' }); },
      sendAlimtalkLink: (memberId) => call<{ ok: boolean; error?: string }>(`/members/${memberId}/messages`, { method: 'POST', body: { channel: 'ALIMTALK' } }),
      attend: async (input) => {
        let r: AttendRes;
        try { r = await call<AttendRes>('/attendances', { method: 'POST', body: input }); } catch (e) {
          return { ok: false, reason: e instanceof TypeError ? 'OFFLINE' : 'ERROR' };
        }
        void refresh().catch(() => {}); // 화면은 응답으로 바로 그리고, 목록은 뒤에서 맞춘다
        if (!r.ok) return { ok: false, reason: r.reason, member: r.member };
        const s = get();
        const course = s.courses.find((c) => c.id === input.courseId);
        if (!course) return { ok: false, reason: 'UNKNOWN_COURSE', member: r.member };
        const base: Pass = s.passes.find((p) => p.id === r.passId) ?? { id: r.passId, memberId: r.memberId, productId: '', kind: 'COUNT', totalCount: r.total, remaining: r.remaining, validFrom: '', validTo: r.validTo };
        return { ok: true, member: r.member ?? { id: r.memberId, name: '' }, pass: { ...base, remaining: r.remaining, totalCount: r.total, validTo: r.validTo }, course, attendedAt: new Date().toISOString() };
      },
      cancelAttendance: (id) => post(`/attendances/${id}/cancel`).then(() => {}),
      importPayments: async (rows) => {
        const clean = rows.map(({ raw: _raw, ...r }) => r); // 원본 행은 보내지 않는다
        const total: ImportResult = { added: 0, dup: 0, matched: 0, cancelled: 0, cancelFailed: 0 };
        for (let i = 0; i < clean.length; i += IMPORT_CHUNK) {
          const r = await post<ImportResult>('/payments/import', { rows: clean.slice(i, i + IMPORT_CHUNK) });
          for (const k of Object.keys(total) as (keyof ImportResult)[]) total[k] += r[k] ?? 0;
        }
        return total;
      },
      addPayment: (p) => post('/payments', p).then(() => {}),
      assignPayment: (paymentId, memberId) => post(`/payments/${paymentId}/assign`, { memberId }).then(() => {}),
      cancelPayment: async (paymentId) => {
        try { await call(`/payments/${paymentId}/cancel`, { method: 'POST' }); } catch (e) {
          if (e instanceof ApiError && e.body?.error === 'PASS_IN_USE') return { ok: false, used: Number(e.body.used) || 0 };
          if (e instanceof TypeError) toast('인터넷 연결이 끊겼어요');
          else if (!(e instanceof ApiError && e.status === 401)) toast('저장하지 못했어요. 다시 시도해 주세요');
          throw e;
        }
        await refresh().catch(() => {});
        return { ok: true };
      },
      upsertInstructor: (i) => put(`/instructors/${i.id}`, i),
      // 서버 PUT 은 빠진 키를 예전 값으로 채우므로, 비운 선택 항목은 undefined(JSON 에서 빠짐) 대신 null 로 보낸다.
      upsertCourse: (c) => put(`/courses/${c.id}`, { ...c, level: c.level ?? null, note: c.note ?? null }),
      upsertProduct: (p) => put(`/products/${p.id}`, { ...p, courseId: p.courseId ?? null }),
      settlement: async (month) => {
        const lines = await call<ServerLine[]>(`/settlement?month=${encodeURIComponent(month)}`);
        const ins = get().instructors;
        return lines.map(({ instructorId, name, ratioInstructor, perSessionFee, ...l }): SettlementLine => {
          const known: Partial<Instructor> = ins.find((i) => i.id === instructorId) ?? {};
          return { ...l, instructor: { ...known, id: instructorId, name, settlementType: l.type, ratioInstructor, perSessionFee } };
        });
      },
      settlementDetail: (month) => call<SettlementDetail>(`/settlement/detail?month=${encodeURIComponent(month)}`),
      reset: async () => {},
      activePasses: (memberId) => activePassesOf(get().passes, memberId),
    };
  });
}

