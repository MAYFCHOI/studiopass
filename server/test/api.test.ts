import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/db.js';
import { seedIfEmpty } from '../src/domain/seed.js';
import { createStaff } from '../src/auth/sessions.js';
import { createApp } from '../src/app.js';
const ORIGIN = 'https://studio.test';
let db: any, app: any;
const req = (path: string, init: any = {}, cookie?: string) => app.request('/api' + path, { ...init, headers: { 'content-type': 'application/json', origin: ORIGIN, ...(cookie ? { cookie } : {}), ...(init.headers ?? {}) }, body: init.body ? JSON.stringify(init.body) : undefined });
const login = async (id: string, pw = 'pw-12345678') => { const r = await req('/auth/login', { method: 'POST', body: { loginId: id, password: pw } }); return (r.headers.get('set-cookie') ?? '').split(';')[0]; };
beforeEach(async () => {
  db = openDb(':memory:'); seedIfEmpty(db);
  await createStaff(db, { loginId: 'owner', name: '원장', role: 'OWNER', password: 'pw-12345678' });
  await createStaff(db, { loginId: 'desk', name: '인포', role: 'DESK', password: 'pw-12345678' });
  app = createApp({ db, secureCookies: false, allowedOrigin: ORIGIN, now: () => new Date('2026-10-19T10:30:00Z') });
});
describe('api', () => {
  it('requires login', async () => { expect((await req('/bootstrap')).status).toBe(401); });
  it('rejects wrong password and limits retries', async () => {
    for (let i = 0; i < 5; i++) expect((await req('/auth/login', { method: 'POST', body: { loginId: 'owner', password: 'x' } })).status).toBe(401);
    expect((await req('/auth/login', { method: 'POST', body: { loginId: 'owner', password: 'pw-12345678' } })).status).toBe(429);
  });
  it('blocks cross-origin writes', async () => {
    const c = await login('owner');
    expect((await req('/members', { method: 'POST', body: { name: '가', phone: '01000000000' }, headers: { origin: 'https://evil.test' } }, c)).status).toBe(403);
  });
  it('desk gets no money fields and no settlement', async () => {
    const c = await login('desk');
    const b = await (await req('/bootstrap', {}, c)).json();
    expect(b.me.role).toBe('DESK');
    expect(b.products[0]).not.toHaveProperty('price');
    expect(b.instructors[0]).not.toHaveProperty('ratioInstructor');
    expect((await req('/settlement?month=2026-10', {}, c)).status).toBe(403);
    expect((await req('/products/p_one', { method: 'PUT', body: { name: 'x' } }, c)).status).toBe(403);
    const o = await login('owner');
    expect((await (await req('/bootstrap', {}, o)).json()).products[0]).toHaveProperty('price');
  });
  it('member, kiosk import, QR attendance, member page', async () => {
    const c = await login('desk');
    const m = await (await req('/members', { method: 'POST', body: { name: '김서연', phone: '010-1111-2222' } }, c)).json();
    const imp = await (await req('/payments/import', { method: 'POST', body: { rows: [{ source: 'KIOSK', externalId: '1', paidAt: '2026-10-19T09:00:00Z', amount: 180000, payerName: '김서연', payerPhone: '01011112222', productName: '정규 클래스 8회권' }] } }, c)).json();
    expect(imp).toMatchObject({ added: 1, matched: 1 });
    const { url } = await (await req(`/members/${m.id}/link`, { method: 'POST' }, c)).json();
    const token = url.split('/m/')[1];
    const page = await (await req('/public/m/' + token)).json();
    expect(page).toMatchObject({ name: '김*연', attendCount: 0, tier: { name: 'DEPTH 1' } });
    expect(JSON.stringify(page)).not.toMatch(/180000|01011112222/);
    const course = db.prepare("select id from courses where kind='GENERAL' limit 1").get();
    const r = await (await req('/attendances', { method: 'POST', body: { qr: page.qr, courseId: course.id } }, c)).json();
    expect(r).toMatchObject({ ok: true, remaining: 7, member: { name: '김서연' } });
    expect(await (await req('/attendances', { method: 'POST', body: { qr: page.qr, courseId: course.id } }, c)).json()).toMatchObject({ ok: false, reason: 'ALREADY' });
    expect(await (await req('/attendances', { method: 'POST', body: { qr: 'AM1:x:y', courseId: course.id } }, c)).json()).toMatchObject({ ok: false, reason: 'UNKNOWN_QR' });
    const again = await (await req(`/members/${m.id}/link`, { method: 'POST' }, c)).json();
    expect((await req('/public/m/' + token)).status).toBe(404);
    expect((await req('/public/m/' + again.url.split('/m/')[1])).status).toBe(200);
    expect((await req('/public/m/nonexistenttoken000000')).status).toBe(404);
  });
  it('payment cancel conflict is 409', async () => {
    const c = await login('owner');
    await req('/members', { method: 'POST', body: { name: '가', phone: '01000000001' } }, c);
    await req('/payments/import', { method: 'POST', body: { rows: [{ source: 'KIOSK', externalId: '9', paidAt: '2026-10-19T09:00:00Z', amount: 100000, payerName: '가', payerPhone: '01000000001', productName: '정규 클래스 4회권' }] } }, c);
    const b = await (await req('/bootstrap', {}, c)).json();
    const course = b.courses.find((x: any) => x.kind === 'GENERAL');
    await req('/attendances', { method: 'POST', body: { memberId: b.members[0].id, courseId: course.id } }, c);
    const r = await req(`/payments/${b.payments[0].id}/cancel`, { method: 'POST' }, c);
    expect(r.status).toBe(409); expect(await r.json()).toMatchObject({ error: 'PASS_IN_USE', used: 1 });
  });
});
