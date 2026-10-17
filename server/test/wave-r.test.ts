// Wave R: failure-path fixes (failure-review H2-H6, M1, M4, M6, M8, M10, L2, L3, L7, L10).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openDb } from '../src/db.js';
import { seedIfEmpty } from '../src/domain/seed.js';
import { createStaff } from '../src/auth/sessions.js';
import { createApp } from '../src/app.js';
import { makeDb } from './fixtures.js';
import { ingestPayments, assignPayment, revertBatch, PassInUseError, AssignError, findProduct } from '../src/domain/payments.js';
import { attend } from '../src/domain/attendance.js';
import { LoginLimiter } from '../src/auth/rateLimit.js';

const ORIGIN = 'https://studio.test';
let db: any, app: any;
const req = (path: string, init: any = {}, cookie?: string) => app.request('/api' + path, { ...init, headers: { 'content-type': 'application/json', origin: ORIGIN, ...(cookie ? { cookie } : {}), ...(init.headers ?? {}) }, body: init.body ? JSON.stringify(init.body) : undefined });
const login = async (id: string, pw = 'pw-12345678') => { const r = await req('/auth/login', { method: 'POST', body: { loginId: id, password: pw } }); return (r.headers.get('set-cookie') ?? '').split(';')[0]; };
const kiosk = (o: any = {}) => ({ source: 'KIOSK', externalId: 'A1', paidAt: '2026-10-19T09:00:00Z', amount: 180000, payerName: '김서연', payerPhone: '01011112222', productName: '정규 클래스 8회권', ...o });
const NOW = new Date('2026-10-19T10:30:00Z');
beforeEach(async () => {
  db = openDb(':memory:'); seedIfEmpty(db);
  await createStaff(db, { loginId: 'owner', name: '원장', role: 'OWNER', password: 'pw-12345678' });
  await createStaff(db, { loginId: 'desk', name: '인포', role: 'DESK', password: 'pw-12345678' });
  app = createApp({ db, secureCookies: false, allowedOrigin: ORIGIN, now: () => NOW });
});
const count = (sql: string, ...a: unknown[]) => (db.prepare(sql).get(...a) as { n: number }).n;

describe('H2 idempotency', () => {
  it('two POST /payments with the same Idempotency-Key create one payment and one pass', async () => {
    const o = await login('owner');
    const m = await (await req('/members', { method: 'POST', body: { name: '김서연', phone: '010-1111-2222' } }, o)).json();
    const body = { memberId: m.id, productName: '정규 클래스 8회권', amount: 180000 };
    const headers = { 'idempotency-key': 'form-abcdef-0001' };
    const [a, b] = await Promise.all([req('/payments', { method: 'POST', body, headers }, o), req('/payments', { method: 'POST', body, headers }, o)]);
    const ja = await a.json(), jb = await b.json();
    expect(a.status).toBe(200); expect(b.status).toBe(200); expect(ja.id).toBe(jb.id);
    expect(count('select count(*) n from payments')).toBe(1);
    expect(count('select count(*) n from passes')).toBe(1);
    // a new key is a new payment
    await req('/payments', { method: 'POST', body, headers: { 'idempotency-key': 'form-abcdef-0002' } }, o);
    expect(count('select count(*) n from payments')).toBe(2);
  });
  it('POST /members with the same key creates one member; key is per staff', async () => {
    const o = await login('owner'); const d = await login('desk');
    const headers = { 'idempotency-key': 'member-form-0001' };
    const a = await (await req('/members', { method: 'POST', body: { name: '이도윤', phone: '01033334444' }, headers }, o)).json();
    const b = await (await req('/members', { method: 'POST', body: { name: '이도윤', phone: '01033334444' }, headers }, o)).json();
    expect(b.id).toBe(a.id);
    expect(count('select count(*) n from members')).toBe(1);
    const c = await (await req('/members', { method: 'POST', body: { name: '이도윤', phone: '01033334444' }, headers }, d)).json();
    expect(c.id).not.toBe(a.id);
    expect(c.samePhone).toBe(1); // M1 hint: another member already has this number
  });
  it('keys older than 24 h are ignored', async () => {
    const o = await login('owner');
    const headers = { 'idempotency-key': 'member-form-0002' };
    await req('/members', { method: 'POST', body: { name: '가' }, headers }, o);
    db.prepare("update idempotency set created_at='2026-01-01T00:00:00Z'").run();
    await req('/members', { method: 'POST', body: { name: '가' }, headers }, o);
    expect(count('select count(*) n from members')).toBe(2);
  });
});

describe('H3 reassign, refunds with another approval number', () => {
  it('reassigning a linked unused payment moves the pass; a used pass refuses with PASS_IN_USE', () => {
    const { db, member, course } = makeDb(); const a = member('김민수', '01011112222'); const b = member('김민수', '01099998888');
    ingestPayments(db, [kiosk()], null);
    const pay = db.prepare('select id, pass_id from payments').get() as any;
    expect(db.prepare('select member_id from passes').get()).toEqual({ member_id: a });
    expect(assignPayment(db, pay.id, b, 'st')).toEqual({ passId: pay.pass_id, moved: true });
    expect(db.prepare('select member_id from passes').get()).toEqual({ member_id: b });
    expect(db.prepare('select member_id from payments').get()).toEqual({ member_id: b });
    attend(db, { memberId: b, courseId: course().id, staffId: null, now: NOW });
    expect(() => assignPayment(db, pay.id, a, 'st')).toThrow(PassInUseError);
  });
  it('assign on a cancelled payment is 409 PAYMENT_CANCELLED (M12)', async () => {
    const o = await login('owner');
    const m = await (await req('/members', { method: 'POST', body: { name: '가', phone: '01000000009' } }, o)).json();
    await req('/payments/import', { method: 'POST', body: { rows: [kiosk({ payerPhone: '' })] } }, o);
    const p = db.prepare('select id from payments').get();
    await req(`/payments/${p.id}/cancel`, { method: 'POST' }, o);
    const r = await req(`/payments/${p.id}/assign`, { method: 'POST', body: { memberId: m.id } }, o);
    expect(r.status).toBe(409); expect(await r.json()).toEqual({ error: 'PAYMENT_CANCELLED' });
    expect(() => assignPayment(db, p.id, m.id, null)).toThrow(AssignError);
  });
  it('a refund row with its own approval number cancels the matching unused approval (same phone, amount, product, 30 days)', () => {
    const { db, member } = makeDb(); member();
    ingestPayments(db, [kiosk({ externalId: 'B2001' })], null);
    const r = ingestPayments(db, [kiosk({ externalId: 'B2001-C', status: 'CANCELLED', paidAt: '2026-10-25T09:00:00Z' })], null);
    expect(r).toMatchObject({ added: 1, cancelled: 1, refundUnmatched: 0 });
    const orig = db.prepare("select status, pass_id from payments where external_id='B2001'").get();
    expect(orig).toEqual({ status: 'CANCELLED', pass_id: null });
    expect(db.prepare("select refund_of from payments where external_id='B2001-C'").get()).toMatchObject({ refund_of: expect.any(String) });
    expect((db.prepare('select count(*) n from passes').get() as any).n).toBe(0);
  });
  it('approval and differently numbered refund in one file, refund row first', () => {
    const { db, member } = makeDb(); member();
    const r = ingestPayments(db, [kiosk({ externalId: 'C-1', status: 'CANCELLED', paidAt: '2026-10-19T09:05:00Z' }), kiosk({ externalId: 'A-1' })], null);
    expect(r).toMatchObject({ added: 2, matched: 1, cancelled: 1 });
    expect(db.prepare("select status from payments where external_id='A-1'").get()).toEqual({ status: 'CANCELLED' });
  });
  it('a refund whose only match has attendance stays APPROVED and is flagged REFUND_IN_USE', () => {
    const { db, member, course } = makeDb(); const m = member();
    ingestPayments(db, [kiosk({ externalId: 'B1' })], null);
    attend(db, { memberId: m, courseId: course().id, staffId: null, now: NOW });
    expect(ingestPayments(db, [kiosk({ externalId: 'B1-C', status: 'CANCELLED', paidAt: '2026-10-20T09:00:00Z' })], null)).toMatchObject({ cancelFailed: 1 });
    expect(db.prepare("select status, review from payments where external_id='B1'").get()).toEqual({ status: 'APPROVED', review: 'REFUND_IN_USE' });
  });
  it('same-number refund on a used pass is flagged REFUND_IN_USE as well', () => {
    const { db, member, course } = makeDb(); const m = member();
    ingestPayments(db, [kiosk()], null);
    attend(db, { memberId: m, courseId: course().id, staffId: null, now: NOW });
    ingestPayments(db, [kiosk({ status: 'CANCELLED' })], null);
    expect(db.prepare('select review from payments').get()).toEqual({ review: 'REFUND_IN_USE' });
  });
  it('no match (other amount, or older than 30 days) -> REFUND_UNMATCHED; picking the original cancels it', async () => {
    const o = await login('owner');
    await req('/members', { method: 'POST', body: { name: '김서연', phone: '01011112222' } }, o);
    await req('/payments/import', { method: 'POST', body: { rows: [kiosk({ externalId: 'OLD', paidAt: '2026-08-01T09:00:00Z' }), kiosk({ externalId: 'X1', amount: 100000, productName: '정규 클래스 4회권' })] } }, o);
    const r = await (await req('/payments/import', { method: 'POST', body: { rows: [kiosk({ externalId: 'R1', status: 'CANCELLED' })] } }, o)).json();
    expect(r).toMatchObject({ refundUnmatched: 1, cancelled: 0 });
    const refund = db.prepare("select id, review from payments where external_id='R1'").get();
    expect(refund.review).toBe('REFUND_UNMATCHED');
    const boot = await (await req('/bootstrap', {}, o)).json();
    expect(boot.payments.find((p: any) => p.id === refund.id)).toMatchObject({ review: 'REFUND_UNMATCHED', status: 'CANCELLED' });
    const old = db.prepare("select id from payments where external_id='OLD'").get();
    expect((await req(`/payments/${refund.id}/refund-of`, { method: 'POST', body: { originalId: old.id } }, o)).status).toBe(200);
    expect(db.prepare("select status from payments where external_id='OLD'").get()).toEqual({ status: 'CANCELLED' });
    expect(db.prepare('select review, refund_of from payments where id=?').get(refund.id)).toEqual({ review: null, refund_of: old.id });
    // review-clear on the other flag type
    expect((await req(`/payments/${refund.id}/review-clear`, { method: 'POST' }, o)).status).toBe(200);
  });
});

describe('H5 import batch revert', () => {
  it('reverting a batch removes its unused payments and passes so a corrected re-upload imports; used ones stay', async () => {
    const o = await login('owner'); const d = await login('desk');
    const m = await (await req('/members', { method: 'POST', body: { name: '김서연', phone: '01011112222' } }, o)).json();
    const first = await (await req('/payments/import', { method: 'POST', body: { batchId: 'batch-wrong-1', rows: [kiosk({ externalId: 'E1', amount: 0.5 }), kiosk({ externalId: 'E2', amount: 0.5 })] } }, o)).json();
    expect(first).toMatchObject({ added: 2, batchId: 'batch-wrong-1' });
    // the member attends on one of the wrong passes
    attend(db, { memberId: m.id, courseId: (db.prepare("select id from courses where kind='GENERAL' limit 1").get() as any).id, staffId: null, now: NOW });
    const again = await (await req('/payments/import', { method: 'POST', body: { rows: [kiosk({ externalId: 'E1' }), kiosk({ externalId: 'E2' })] } }, o)).json();
    expect(again).toMatchObject({ added: 0, dup: 2, dupBatches: [{ batchId: 'batch-wrong-1', count: 2 }] });
    expect((await req('/payments/import-batches/batch-wrong-1/revert', { method: 'POST' }, d)).status).toBe(403);
    expect(await (await req('/payments/import-batches/batch-wrong-1/revert', { method: 'POST' }, o)).json()).toEqual({ removed: 1, kept: 1 });
    expect(await (await req('/payments/import', { method: 'POST', body: { rows: [kiosk({ externalId: 'E1' }), kiosk({ externalId: 'E2' })] } }, o)).json()).toMatchObject({ added: 1, dup: 1 });
  });
  it('revertBatch on an unknown batch is a no-op', () => {
    const { db } = makeDb();
    expect(revertBatch(db, 'nope-nope', null)).toEqual({ removed: 0, kept: 0 });
  });
});

describe('H6 per-row validation', () => {
  it('imports good rows and reports bad ones with their index and reason', async () => {
    const o = await login('owner');
    const rows = [kiosk({ externalId: 'G1' }), kiosk({ externalId: 'x'.repeat(101) }), kiosk({ externalId: 'G3', paidAt: 'nope' }), kiosk({ externalId: 'G4', status: 1 }), kiosk({ externalId: 'G5' })];
    const r = await (await req('/payments/import', { method: 'POST', body: { rows } }, o)).json();
    expect(r).toMatchObject({ added: 2, rejectedCount: 3, rejected: [{ index: 1, reason: 'ID_TOO_LONG' }, { index: 2, reason: 'BAD_DATE' }, { index: 3, reason: 'BAD_STATUS' }] });
  });
  it('caps the rejected list at 50 but counts all', async () => {
    const o = await login('owner');
    const rows = Array.from({ length: 80 }, (_, i) => kiosk({ externalId: 'Z' + i, amount: 'x' }));
    const r = await (await req('/payments/import', { method: 'POST', body: { rows } }, o)).json();
    expect(r.rejected).toHaveLength(50); expect(r.rejectedCount).toBe(80);
  });
});

describe('H4 login limiter counts only credential failures', () => {
  it('blocked() does not record an attempt', () => {
    const l = new LoginLimiter(2, 1000);
    for (let i = 0; i < 10; i++) expect(l.blocked('k', 0)).toBe(false);
    l.hit('k', 0); l.hit('k', 0);
    expect(l.blocked('k', 1)).toBe(true);
  });
  it('a server error during login is not counted', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const realPrepare = db.prepare.bind(db); let broken = true;
    db.prepare = (sql: string) => { if (broken && sql.includes('from staff where login_id')) throw new Error('disk I/O error'); return realPrepare(sql); };
    for (let i = 0; i < 6; i++) expect((await req('/auth/login', { method: 'POST', body: { loginId: 'owner', password: 'pw-12345678' } })).status).toBe(500);
    broken = false;
    expect(await login('owner')).toMatch(/^sp_session=/);
  });
});

describe('M6 inactive course, L7 ALREADY with remaining, M4 attendance in response', () => {
  it('attendance on an inactive course is refused with INACTIVE_COURSE', () => {
    const { db, member, course, pass } = makeDb(); const m = member(); pass(m, {});
    const c = course(); db.prepare('update courses set active=0 where id=?').run(c.id);
    expect(attend(db, { memberId: m, courseId: c.id, staffId: null, now: NOW })).toEqual({ ok: false, reason: 'INACTIVE_COURSE', memberId: m });
  });
  it('a second scan returns ALREADY with the remaining count; the first returns the attendance row', async () => {
    const o = await login('owner');
    const m = await (await req('/members', { method: 'POST', body: { name: '김서연', phone: '01011112222' } }, o)).json();
    await req('/payments', { method: 'POST', body: { memberId: m.id, productName: '정규 클래스 8회권', amount: 180000 } }, o);
    const c = db.prepare("select id from courses where kind='GENERAL' limit 1").get();
    const a = await (await req('/attendances', { method: 'POST', body: { memberId: m.id, courseId: c.id } }, o)).json();
    expect(a).toMatchObject({ ok: true, remaining: 7, attendance: { memberId: m.id, courseId: c.id, attendedOn: '2026-10-19' } });
    const b = await (await req('/attendances', { method: 'POST', body: { memberId: m.id, courseId: c.id } }, o)).json();
    expect(b).toMatchObject({ ok: false, reason: 'ALREADY', remaining: 7, total: 8 });
  });
});

describe('M8 healthz write, M10 history, L2 phone fix, L3 spacing, L10 cookie refresh', () => {
  it('healthz writes a heartbeat and fails when the write fails', async () => {
    expect(await (await req('/healthz')).json()).toMatchObject({ ok: true });
    expect(db.prepare("select value from settings where key='healthz_at'").get()).toBeTruthy();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    db.pragma('query_only = ON');
    expect((await req('/healthz')).status).toBe(500);
    db.pragma('query_only = OFF');
  });
  it('history returns attendances and payments beyond the 62-day bootstrap window; DESK gets no amounts', async () => {
    const o = await login('owner'); const d = await login('desk');
    const m = await (await req('/members', { method: 'POST', body: { name: '김서연', phone: '01011112222' } }, o)).json();
    await req('/payments/import', { method: 'POST', body: { rows: [kiosk({ paidAt: '2026-05-01T09:00:00Z' })] } }, o);
    const passId = db.prepare('select id from passes').get().id;
    const c = db.prepare("select id, instructor_id from courses limit 1").get();
    db.prepare("insert into attendances(id,member_id,pass_id,course_id,instructor_id,attended_on,attended_at) values('old1',?,?,?,?,'2026-05-02','2026-05-02T10:00:00Z')").run(m.id, passId, c.id, c.instructor_id);
    const boot = await (await req('/bootstrap', {}, o)).json();
    expect(boot.attendances.find((a: any) => a.id === 'old1')).toBeUndefined();
    const h = await (await req(`/members/${m.id}/history`, {}, o)).json();
    expect(h.attendances.map((a: any) => a.id)).toContain('old1');
    expect(h.payments[0]).toMatchObject({ amount: 180000 });
    const hd = await (await req(`/members/${m.id}/history`, {}, d)).json();
    expect(hd.payments[0].amount).toBeUndefined(); expect(hd.passes[0].price).toBeUndefined();
    expect((await req('/members/nope/history', {}, o)).status).toBe(404);
  });
  it('fixing a member phone picks up payments waiting for that number', async () => {
    const o = await login('owner');
    const m = await (await req('/members', { method: 'POST', body: { name: '김서연', phone: '01000000000' } }, o)).json();
    await req('/payments/import', { method: 'POST', body: { rows: [kiosk()] } }, o);
    expect(db.prepare('select member_id from payments').get()).toEqual({ member_id: null });
    const r = await (await req(`/members/${m.id}`, { method: 'PATCH', body: { phone: '010-1111-2222' } }, o)).json();
    expect(r.assigned).toBe(1);
    expect(db.prepare('select member_id from payments').get()).toEqual({ member_id: m.id });
  });
  it('product names that differ only in spacing match', () => {
    const { db } = makeDb();
    expect(findProduct(db, '정규클래스  8회권')?.id).toBe('p_eight');
  });
  it('bootstrap re-sets the session cookie', async () => {
    const o = await login('owner');
    const r = await req('/bootstrap', {}, o);
    expect(r.headers.get('set-cookie') ?? '').toMatch(/^sp_session=.*Max-Age=2592000/);
  });
});
