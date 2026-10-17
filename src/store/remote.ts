import { create, type StoreApi, type UseBoundStore } from 'zustand';
import type { State, Store, Me, Member, Instructor, Pass, Attendance, SettlementLine, SettlementDetail, ScanFail, ImportResult, AssignResult, MemberHistory } from '../types';
import { api, ApiError, isOffline } from '../api/client';
import { activePassesOf } from '../lib/passes';
import { newRequestKey } from '../lib/useBusy';
import { toast } from '../components/Toast';

type Bootstrap = Omit<State, 'needsRealPrices'> & { me: Me; needsRealPrices: boolean };
type ServerLine = Omit<SettlementLine, 'instructor'> & { instructorId: string; name: string; ratioInstructor: number; perSessionFee: number };
type AttendRes =
  | { ok: true; attendanceId: string; memberId: string; passId: string; remaining: number; total: number; validTo: string; attendance?: Attendance; member?: { id: string; name: string } }
  | { ok: false; reason: ScanFail; memberId?: string; remaining?: number; total?: number; validTo?: string; member?: { id: string; name: string } };
type Init = { method?: string; body?: unknown; headers?: Record<string, string>; timeoutMs?: number };

const EMPTY: State = { studioName: '', members: [], instructors: [], courses: [], products: [], payments: [], passes: [], attendances: [], needsRealPrices: false, alimtalkEnabled: false, tiers: [] };
const IMPORT_CHUNK = 2000; // 서버 한도
const REFRESH_EVERY_MS = 30000; // 출석 뒤 목록 다시 받기는 30초에 한 번까지
/** 서버 오류 코드 → 화면 문구. 다시 시도해도 안 되는 오류에 "다시 시도해 주세요" 를 보이지 않는다. */
const ERRORS: Record<string, string> = {
  BAD_REQUEST: '입력값을 확인해 주세요',
  DUPLICATE_NAME: '같은 이름이 이미 있어요',
  LOGIN_TAKEN: '이미 쓰는 아이디예요',
  TOO_MANY: '한 번에 올릴 수 있는 행 수를 넘었어요',
  TOO_LARGE: '파일이 너무 커요. 나눠서 올려 주세요',
  ERASED: '정보를 삭제한 회원이에요',
  OWNER_ONLY: '원장만 할 수 있어요',
  PAYMENT_CANCELLED: '이미 취소된 결제예요',
  NOT_FOUND: '이미 지워졌거나 없는 항목이에요. 화면을 새로 고쳐 주세요',
};
const errorText = (e: unknown) => (isOffline(e) ? '인터넷 연결이 끊겼어요' : e instanceof ApiError ? ERRORS[e.body?.error] ?? '저장하지 못했어요. 다시 시도해 주세요' : '저장하지 못했어요. 다시 시도해 주세요');

/** 서버 모드: 쿠키 세션 + /api. 변경 후에는 /bootstrap 을 다시 받아 화면을 맞춘다(학원 규모라 단순하게). */
export function createRemoteStore(): UseBoundStore<StoreApi<Store>> {
  return create<Store>()((set, get) => {
    /** 요청 하나. 서버에 닿지 못하면 online=false, 세션이 끝났으면 로그인 화면으로. */
    async function call<T>(path: string, init?: Init): Promise<T> {
      try {
        const r = await api<T>(path, init);
        if (!get().online) set({ online: true });
        return r;
      } catch (e) {
        if (isOffline(e)) set({ online: false });
        else if (e instanceof ApiError) {
          if (!get().online) set({ online: true }); // the server answered
          if (e.status === 401) set({ ...EMPTY, me: null });
        }
        throw e;
      }
    }
    let lastRefresh = 0;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    async function refresh() {
      const b = await call<Bootstrap>('/bootstrap', { timeoutMs: 15000 });
      lastRefresh = Date.now();
      set({
        me: { name: b.me.name, role: b.me.role, staffId: b.me.staffId },
        studioName: b.studioName, needsRealPrices: !!b.needsRealPrices, alimtalkEnabled: b.alimtalkEnabled ?? false, tiers: b.tiers ?? [],
        members: b.members, instructors: b.instructors, courses: b.courses, products: b.products, passes: b.passes, payments: b.payments, attendances: b.attendances,
      });
    }
    /** 뒤에서 한 번 다시 받는다. 직전에 받았으면 30초가 지날 때까지 미룬다(출석이 몰릴 때 매번 받지 않게). */
    function refreshSoon() {
      if (refreshTimer) return;
      const wait = Math.max(0, lastRefresh + REFRESH_EVERY_MS - Date.now());
      refreshTimer = setTimeout(() => { refreshTimer = null; void refresh().catch(() => {}); }, wait);
    }
    const failToast = (e: unknown) => { if (!(e instanceof ApiError && e.status === 401)) toast(errorText(e)); };
    /** 변경 요청: 실패는 토스트로 알리고 다시 던진다(화면은 성공 토스트를 건너뛴다). 성공하면 다시 받는다. */
    async function mutate<T>(path: string, init: Init): Promise<T> {
      let r: T;
      try { r = await call<T>(path, init); } catch (e) { failToast(e); throw e; }
      await refresh().catch(() => {});
      return r;
    }
    /** mutate 와 같지만 409 는 화면이 문구를 고르도록 돌려준다. */
    async function mutate409<T>(path: string, init: Init): Promise<{ ok: true; r: T } | { ok: false; error: string; used: number }> {
      let r: T;
      try { r = await call<T>(path, init); } catch (e) {
        if (e instanceof ApiError && e.status === 409) { await refresh().catch(() => {}); return { ok: false, error: String(e.body?.error ?? ''), used: Number(e.body?.used ?? e.body?.count) || 0 }; }
        failToast(e); throw e;
      }
      await refresh().catch(() => {});
      return { ok: true, r };
    }
    const post = <T = unknown>(path: string, body?: unknown, headers?: Record<string, string>) => mutate<T>(path, { method: 'POST', body, headers });
    const put = (path: string, body: unknown) => mutate(path, { method: 'PUT', body }).then(() => {});
    const idem = (k?: string) => (k ? { 'Idempotency-Key': k } : undefined);

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
          // 배포·재시작 중(502)이나 끊김, 서버 오류는 비밀번호가 틀린 게 아니다
          if (isOffline(e)) { set({ online: false }); return { ok: false, error: 'OFFLINE' }; }
          if (e instanceof ApiError && e.status >= 500) return { ok: false, error: 'OFFLINE' };
          if (e instanceof ApiError) return { ok: false, error: e.status === 429 ? (e.body?.error === 'BUSY' ? 'BUSY' : 'LIMIT') : 'INVALID' };
          return { ok: false, error: 'OFFLINE' };
        }
        set({ online: true });
        await get().load();
        return { ok: true };
      },
      logout: async () => {
        await api('/auth/logout', { method: 'POST' }).catch(() => {});
        set({ ...EMPTY, me: null });
      },
      addMember: (m, opts) => post<Member & { assigned: number }>('/members', m, idem(opts?.idempotencyKey)),
      updateMember: (id, patch) => mutate(`/members/${id}`, { method: 'PATCH', body: { name: patch.name, phone: patch.phone, memo: patch.memo } }).then(() => {}),
      eraseMember: (id) => post(`/members/${id}/erase`).then(() => {}),
      erasePayer: (paymentId) => post(`/payments/${paymentId}/erase-payer`).then(() => {}),
      issueLink: async (memberId) => (await call<{ url: string }>(`/members/${memberId}/link`, { method: 'POST' })).url,
      recordMessage: async (memberId) => { await call(`/members/${memberId}/messages`, { method: 'POST' }); },
      sendAlimtalkLink: (memberId) => call<{ ok: boolean; error?: string }>(`/members/${memberId}/messages`, { method: 'POST', body: { channel: 'ALIMTALK' } }),
      attend: async (input) => {
        let r: AttendRes;
        try { r = await call<AttendRes>('/attendances', { method: 'POST', body: input }); } catch (e) {
          return { ok: false, reason: isOffline(e) ? 'OFFLINE' : 'ERROR' };
        }
        if (!r.ok) { refreshSoon(); return { ok: false, reason: r.reason, member: r.member, remaining: r.remaining, total: r.total, validTo: r.validTo }; }
        // 화면은 응답으로 바로 맞추고, 전체 목록은 뒤에서(30초에 한 번까지) 맞춘다.
        const att = r.attendance;
        set((s) => ({
          passes: s.passes.map((p) => (p.id === r.passId ? { ...p, remaining: r.remaining } : p)),
          attendances: att && !s.attendances.some((a) => a.id === att.id) ? [att, ...s.attendances] : s.attendances,
        }));
        refreshSoon();
        const s = get();
        const course = s.courses.find((c) => c.id === input.courseId);
        if (!course) return { ok: false, reason: 'UNKNOWN_COURSE', member: r.member };
        const base: Pass = s.passes.find((p) => p.id === r.passId) ?? { id: r.passId, memberId: r.memberId, productId: '', kind: 'COUNT', totalCount: r.total, remaining: r.remaining, validFrom: '', validTo: r.validTo };
        return { ok: true, member: r.member ?? { id: r.memberId, name: '' }, pass: { ...base, remaining: r.remaining, totalCount: r.total, validTo: r.validTo }, course, attendedAt: att?.attendedAt ?? new Date().toISOString() };
      },
      cancelAttendance: (id) => post(`/attendances/${id}/cancel`).then(() => {}),
      importPayments: async (rows, opts) => {
        const batchId = opts?.batchId ?? newRequestKey(); // 여러 요청으로 나눠도 한 묶음
        const total: ImportResult = { added: 0, dup: 0, matched: 0, cancelled: 0, cancelFailed: 0, refundUnmatched: 0, refundSuggested: 0, rejected: [], rejectedCount: 0, batchId, dupBatches: [] };
        const dupBatches = new Map<string, number>();
        for (let i = 0; i < rows.length; i += IMPORT_CHUNK) {
          const part = rows.slice(i, i + IMPORT_CHUNK);
          const clean = part.map(({ raw: _raw, line: _line, ...r }) => r); // 원본 행·행 번호는 보내지 않는다
          const r = await mutate<ImportResult & { rejected: { index: number; reason: string }[] }>('/payments/import', { method: 'POST', body: { rows: clean, batchId }, timeoutMs: 60000 });
          for (const k of ['added', 'dup', 'matched', 'cancelled', 'cancelFailed', 'refundUnmatched', 'refundSuggested', 'rejectedCount'] as const) total[k] += r[k] ?? 0;
          for (const x of r.rejected ?? []) total.rejected.push({ line: part[x.index]?.line, reason: x.reason });
          for (const b of r.dupBatches ?? []) dupBatches.set(b.batchId, (dupBatches.get(b.batchId) ?? 0) + b.count);
        }
        total.dupBatches = [...dupBatches].map(([batchId, count]) => ({ batchId, count })).sort((a, b) => b.count - a.count);
        return total;
      },
      revertImport: async (batchId) => {
        const r = await mutate409<{ removed: number; kept: number }>(`/payments/import-batches/${encodeURIComponent(batchId)}/revert`, { method: 'POST' });
        return r.ok ? { ok: true, ...r.r } : { ok: false, error: r.error === 'HAS_CANCELLED' ? 'HAS_CANCELLED' : 'REFUND_LINKED', count: r.used };
      },
      addPayment: (p, opts) => post('/payments', p, idem(opts?.idempotencyKey)).then(() => {}),
      assignPayment: async (paymentId, memberId): Promise<AssignResult> => {
        const r = await mutate409<{ passId: string | null; moved?: boolean }>(`/payments/${paymentId}/assign`, { method: 'POST', body: { memberId } });
        if (r.ok) return { ok: true, passId: r.r.passId ?? undefined, moved: r.r.moved };
        return { ok: false, error: (r.error === 'PASS_IN_USE' || r.error === 'PAYMENT_CANCELLED' || r.error === 'ERASED' ? r.error : 'PAYMENT_CANCELLED'), used: r.used };
      },
      cancelPayment: async (paymentId) => {
        const r = await mutate409(`/payments/${paymentId}/cancel`, { method: 'POST' });
        return r.ok ? { ok: true } : { ok: false, used: r.used };
      },
      linkRefund: async (refundId, originalId) => {
        const r = await mutate409(`/payments/${refundId}/refund-of`, { method: 'POST', body: { originalId } });
        return r.ok ? { ok: true } : { ok: false, error: r.error, used: r.used };
      },
      clearReview: (paymentId) => post(`/payments/${paymentId}/review-clear`).then(() => {}),
      memberHistory: (memberId) => call<MemberHistory>(`/members/${memberId}/history`, { timeoutMs: 15000 }),
      upsertInstructor: (i) => put(`/instructors/${i.id}`, i),
      // 서버 PUT 은 빠진 키를 예전 값으로 채우므로, 비운 선택 항목은 undefined(JSON 에서 빠짐) 대신 null 로 보낸다.
      upsertCourse: (c) => put(`/courses/${c.id}`, { ...c, level: c.level ?? null, note: c.note ?? null }),
      upsertProduct: (p) => put(`/products/${p.id}`, { ...p, courseId: p.courseId ?? null }),
      settlement: async (month) => {
        const lines = await call<ServerLine[]>(`/settlement?month=${encodeURIComponent(month)}`, { timeoutMs: 20000 });
        const ins = get().instructors;
        return lines.map(({ instructorId, name, ratioInstructor, perSessionFee, ...l }): SettlementLine => {
          const known: Partial<Instructor> = ins.find((i) => i.id === instructorId) ?? {};
          return { ...l, instructor: { ...known, id: instructorId, name, settlementType: l.type, ratioInstructor, perSessionFee } };
        });
      },
      settlementDetail: (month) => call<SettlementDetail>(`/settlement/detail?month=${encodeURIComponent(month)}`, { timeoutMs: 30000 }),
      reset: async () => {},
      activePasses: (memberId) => activePassesOf(get().passes, memberId),
    };
  });
}
