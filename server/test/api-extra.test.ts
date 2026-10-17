import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { seedIfEmpty } from '../src/domain/seed.js';
import { createStaff } from '../src/auth/sessions.js';
import { createApp } from '../src/app.js';
const ORIGIN = 'https://studio.test';
let db: any, app: any;
const req = (path: string, init: any = {}, cookie?: string) => app.request('/api' + path, { ...init, headers: { 'content-type': 'application/json', origin: ORIGIN, ...(cookie ? { cookie } : {}), ...(init.headers ?? {}) }, body: init.body ? JSON.stringify(init.body) : undefined });
const login = async (id: string, pw = 'pw-12345678') => { const r = await req('/auth/login', { method: 'POST', body: { loginId: id, password: pw } }); return (r.headers.get('set-cookie') ?? '').split(';')[0]; };
const kiosk = (externalId: string, phone: string, productName = '정규 클래스 4회권', amount = 100000) => ({ source: 'KIOSK', externalId, paidAt: '2026-10-19T09:00:00Z', amount, payerName: 'x', payerPhone: phone, productName });
beforeEach(async () => {
  db = openDb(':memory:'); seedIfEmpty(db);
  await createStaff(db, { loginId: 'owner', name: '원장', role: 'OWNER', password: 'pw-12345678' });
  await createStaff(db, { loginId: 'desk', name: '인포', role: 'DESK', password: 'pw-12345678' });
  app = createApp({ db, secureCookies: false, allowedOrigin: ORIGIN, now: () => new Date('2026-10-19T10:30:00Z') });
});

describe('auth', () => {
  it('sets an httpOnly Lax cookie, serves me, and logout kills the session', async () => {
    const r = await req('/auth/login', { method: 'POST', body: { loginId: 'owner', password: 'pw-12345678' } });
    expect(await r.json()).toMatchObject({ me: { name: '원장', role: 'OWNER' } });
    const sc = r.headers.get('set-cookie') ?? '';
    expect(sc).toMatch(/^sp_session=/); expect(sc).toMatch(/HttpOnly/); expect(sc).toMatch(/SameSite=Lax/); expect(sc).not.toMatch(/Secure/);
    const c = sc.split(';')[0];
    expect(await (await req('/auth/me', {}, c)).json()).toMatchObject({ me: { role: 'OWNER' } });
    expect((await req('/auth/logout', { method: 'POST' }, c)).status).toBe(200);
    expect((await req('/auth/me', {}, c)).status).toBe(401);
  });
  it('marks the cookie Secure when secureCookies is on', async () => {
    app = createApp({ db, secureCookies: true, allowedOrigin: ORIGIN });
    const r = await req('/auth/login', { method: 'POST', body: { loginId: 'owner', password: 'pw-12345678' } });
    expect(r.headers.get('set-cookie')).toMatch(/Secure/);
  });
  it('limits per ip|loginId and a success resets the counter', async () => {
    for (let i = 0; i < 4; i++) await req('/auth/login', { method: 'POST', body: { loginId: 'owner', password: 'x' } });
    expect(await login('owner')).toMatch(/^sp_session=/);
    for (let i = 0; i < 5; i++) expect((await req('/auth/login', { method: 'POST', body: { loginId: 'owner', password: 'x' } })).status).toBe(401);
    // another ip is not blocked
    expect((await req('/auth/login', { method: 'POST', headers: { 'x-forwarded-for': '10.0.0.9, 1.1.1.1' }, body: { loginId: 'owner', password: 'pw-12345678' } })).status).toBe(200);
    // another login id from the blocked ip is not blocked
    expect((await req('/auth/login', { method: 'POST', body: { loginId: 'desk', password: 'pw-12345678' } })).status).toBe(200);
  });
  it('rejects writes without an Origin header and malformed login bodies', async () => {
    expect((await app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ loginId: 'owner', password: 'pw-12345678' }) })).status).toBe(403);
    expect((await req('/auth/login', { method: 'POST', body: { login_id: 'owner', password: 'pw-12345678' } })).status).toBe(400);
  });
});

describe('roles and validation', () => {
  it('owner gets settlement; bad month is 400', async () => {
    const o = await login('owner');
    const r = await req('/settlement?month=2026-10', {}, o);
    expect(r.status).toBe(200); expect(Array.isArray(await r.json())).toBe(true);
    expect(await (await req('/settlement?month=2026-1', {}, o)).json()).toEqual({ error: 'BAD_MONTH' });
  });
  it('desk bootstrap has no amount on payments and no price on passes', async () => {
    const d = await login('desk');
    await req('/members', { method: 'POST', body: { name: '가', phone: '01024682468' } }, d);
    await req('/payments/import', { method: 'POST', body: { rows: [kiosk('a1', '01024682468')] } }, d);
    const b = await (await req('/bootstrap', {}, d)).json();
    expect(b.payments[0]).not.toHaveProperty('amount'); expect(b.passes[0]).not.toHaveProperty('price');
    expect(b.instructors[0]).not.toHaveProperty('perSessionFee');
    expect(JSON.stringify(b)).not.toMatch(/100000/);
    expect((await req('/staff', {}, d)).status).toBe(403);
    expect((await req('/tiers', { method: 'PUT', body: [{ name: 'A', minCount: 0 }] }, d)).status).toBe(403);
  });
  it('bootstrap shape matches the web types', async () => {
    const o = await login('owner');
    const b = await (await req('/bootstrap', {}, o)).json();
    expect(b).toMatchObject({ studioName: 'THE DEPTH', needsRealPrices: true, me: { role: 'OWNER' } });
    expect(Array.isArray(b.courses[0].weekday)).toBe(true);
    expect(b.products.find((p: any) => p.id === 'p_eight')).toMatchObject({ passKind: 'COUNT', count: 8, periodDays: 60, price: 180000 });
    expect(b.tiers[0]).toEqual({ name: 'DEPTH 1', minCount: 0 });
  });
  it('rejects bad bodies and too many import rows', async () => {
    const d = await login('desk');
    expect((await req('/members', { method: 'POST', body: { phone: '010' } }, d)).status).toBe(400);
    // a bad row is reported, not fatal (H6)
    expect(await (await req('/payments/import', { method: 'POST', body: { rows: [{ source: 'KIOSK', paidAt: 'x', amount: 'a', productName: 'p' }] } }, d)).json()).toMatchObject({ added: 0, rejectedCount: 1, rejected: [{ index: 0, reason: 'BAD_DATE' }] });
    expect((await req('/payments/import', { method: 'POST', body: { rows: 'x' } }, d)).status).toBe(400);
    const rows = Array.from({ length: 2001 }, (_, i) => kiosk(String(i), '01000000003'));
    expect(await (await req('/payments/import', { method: 'POST', body: { rows } }, d)).json()).toEqual({ error: 'TOO_MANY' });
    expect((await req('/attendances', { method: 'POST', body: { courseId: 'x' } }, d)).status).toBe(400);
  });
});

describe('members and payments', () => {
  it('numbers members per KST year and links waiting payments by phone', async () => {
    const d = await login('desk');
    await req('/payments/import', { method: 'POST', body: { rows: [kiosk('w1', '01055556666')] } }, d);
    const a = await (await req('/members', { method: 'POST', body: { name: '나', phone: '010-5555-6666' } }, d)).json();
    const b = await (await req('/members', { method: 'POST', body: { name: '다', phone: '' } }, d)).json();
    expect(a).toMatchObject({ memberNo: '2026-0001', phone: '01055556666', assigned: 1, tier: { name: 'DEPTH 1', level: 1, count: 0 } });
    expect(b.memberNo).toBe('2026-0002');
    expect(db.prepare('select count(*) n from passes where member_id=?').get(a.id).n).toBe(1);
    const p = await (await req(`/members/${a.id}`, { method: 'PATCH', body: { memo: '메모' } }, d)).json();
    expect(p).toMatchObject({ name: '나', memo: '메모' });
    expect((await req('/members/nope', { method: 'PATCH', body: { memo: 'x' } }, d)).status).toBe(404);
    expect(await (await req(`/members/${a.id}/messages`, { method: 'POST' }, d)).json()).toEqual({ ok: true });
    expect(db.prepare('select channel, kind from messages').get()).toEqual({ channel: 'SMS_LINK', kind: 'LINK' });
  });
  it('manual payment links to the given member; assign and attendance cancel work', async () => {
    const o = await login('owner');
    const m = await (await req('/members', { method: 'POST', body: { name: '라', phone: '01077778888' } }, o)).json();
    const pay = await (await req('/payments', { method: 'POST', body: { amount: 30000, productName: '정규 클래스 1회권', memberId: m.id } }, o)).json();
    expect(pay).toMatchObject({ source: 'MANUAL', memberId: m.id, amount: 30000 });
    expect(pay.passId).toBeTruthy();
    await req('/payments/import', { method: 'POST', body: { rows: [kiosk('z1', '01099990000')] } }, o);
    const open = db.prepare("select id from payments where external_id='z1'").get();
    expect((await (await req(`/payments/${open.id}/assign`, { method: 'POST', body: { memberId: m.id } }, o)).json()).passId).toBeTruthy();
    const course = db.prepare("select id from courses where kind='GENERAL' limit 1").get();
    const at = await (await req('/attendances', { method: 'POST', body: { memberId: m.id, courseId: course.id } }, o)).json();
    expect(at).toMatchObject({ ok: true, member: { id: m.id } });
    expect(await (await req(`/attendances/${at.attendanceId}/cancel`, { method: 'POST' }, o)).json()).toEqual({ ok: true });
    expect(await (await req(`/attendances/${at.attendanceId}/cancel`, { method: 'POST' }, o)).json()).toEqual({ ok: false });
    expect(await (await req(`/payments/${open.id}/cancel`, { method: 'POST' }, o)).json()).toEqual({ ok: true });
  });
});

describe('owner upserts and staff', () => {
  it('upserts products, courses, instructors and tiers', async () => {
    const o = await login('owner');
    expect(await (await req('/products/p_one', { method: 'PUT', body: { price: 35000 } }, o)).json()).toMatchObject({ id: 'p_one', name: '정규 클래스 1회권', price: 35000 });
    expect((await req('/products/p_new', { method: 'PUT', body: { name: '새 상품' } }, o)).status).toBe(400);
    expect((await req('/products/p_new', { method: 'PUT', body: { name: '정규 클래스 4회권', passKind: 'COUNT', count: 2, periodDays: 14, price: 50000 } }, o)).status).toBe(409);
    expect((await req('/products/p_new', { method: 'PUT', body: { name: '2회권', passKind: 'COUNT', count: 2, periodDays: 14, price: 50000 } }, o)).status).toBe(200);
    const ins = db.prepare('select id from instructors limit 1').get();
    expect(await (await req(`/instructors/${ins.id}`, { method: 'PUT', body: { settlementType: 'PER_SESSION', perSessionFee: 40000 } }, o)).json()).toMatchObject({ settlementType: 'PER_SESSION', perSessionFee: 40000 });
    const co = db.prepare('select id from courses limit 1').get();
    expect(await (await req(`/courses/${co.id}`, { method: 'PUT', body: { weekday: [3], startTime: '20:00' } }, o)).json()).toMatchObject({ weekday: [3], startTime: '20:00' });
    expect((await req(`/courses/${co.id}`, { method: 'PUT', body: { weekday: [1, 2] } }, o)).status).toBe(400);
    expect(await (await req('/tiers', { method: 'PUT', body: [{ name: 'B', minCount: 5 }, { name: 'A', minCount: 0 }] }, o)).json()).toEqual([{ name: 'A', minCount: 0 }, { name: 'B', minCount: 5 }]);
    expect((await req('/tiers', { method: 'PUT', body: [{ name: 'B', minCount: 5 }] }, o)).status).toBe(400);
    expect(db.prepare("select count(*) n from audit_log where action like 'product.%'").get().n).toBe(2);
  });
  it('owner product save clears needsRealPrices; a desk attempt does not', async () => {
    const o = await login('owner'); const d = await login('desk');
    expect((await (await req('/bootstrap', {}, o)).json()).needsRealPrices).toBe(true);
    expect((await req('/products/p_one', { method: 'PUT', body: { price: 35000 } }, d)).status).toBe(403);
    expect((await (await req('/bootstrap', {}, o)).json()).needsRealPrices).toBe(true);
    expect((await req('/products/p_one', { method: 'PUT', body: { price: 35000 } }, o)).status).toBe(200);
    expect((await (await req('/bootstrap', {}, o)).json()).needsRealPrices).toBe(false);
  });
  it('creates a desk account and deactivation revokes its sessions', async () => {
    const o = await login('owner');
    const s = await (await req('/staff', { method: 'POST', body: { loginId: 'desk2', name: '인포2', password: 'pw-12345678' } }, o)).json();
    expect(s).toMatchObject({ loginId: 'desk2', role: 'DESK', active: true });
    expect((await req('/staff', { method: 'POST', body: { loginId: 'desk2', name: 'x', password: 'pw-12345678' } }, o)).status).toBe(409);
    const d2 = await login('desk2');
    expect((await req('/bootstrap', {}, d2)).status).toBe(200);
    expect(await (await req(`/staff/${s.id}`, { method: 'PATCH', body: { active: false } }, o)).json()).toMatchObject({ active: false });
    expect((await req('/bootstrap', {}, d2)).status).toBe(401);
    expect((await req('/auth/login', { method: 'POST', body: { loginId: 'desk2', password: 'pw-12345678' } })).status).toBe(401);
    const me = db.prepare("select id from staff where login_id='owner'").get();
    expect((await req(`/staff/${me.id}`, { method: 'PATCH', body: { active: false } }, o)).status).toBe(400);
  });
});

describe('public', () => {
  it('healthz, no-store and the same 404 for malformed and unknown tokens', async () => {
    expect(await (await req('/healthz')).json()).toEqual({ ok: true });
    for (const t of ['short', 'nonexistenttoken000000', 'aaaaaaaaaaaaaaaaaaaa.bb']) {
      const r = await req('/public/m/' + t);
      expect(r.status).toBe(404); expect(await r.json()).toEqual({ error: 'NOT_FOUND' });
      expect(r.headers.get('cache-control')).toBe('no-store');
    }
  });
  it('lists only active passes and hides money, phone and memo', async () => {
    const o = await login('owner');
    const m = await (await req('/members', { method: 'POST', body: { name: '남궁민수', phone: '01012121212', memo: '비밀메모' } }, o)).json();
    await req('/payments/import', { method: 'POST', body: { rows: [kiosk('q1', '01012121212', '정규 클래스 8회권', 180000), { ...kiosk('q2', '01012121212', '정규 클래스 1회권', 30000), paidAt: '2026-01-01T00:00:00Z' }] } }, o);
    const { url } = await (await req(`/members/${m.id}/link`, { method: 'POST' }, o)).json();
    expect(url.startsWith(ORIGIN + '/m/')).toBe(true);
    const r = await req('/public/m/' + url.split('/m/')[1]);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const page = await r.json();
    expect(page).toMatchObject({ studioName: 'THE DEPTH', name: '남**수', passes: [{ name: '정규 클래스 8회권', remaining: 8, total: 8, kind: 'COUNT' }] });
    expect(page.passes).toHaveLength(1);
    expect(page.qr).toMatch(/^AM2:/);
    expect(JSON.stringify(page)).not.toMatch(/180000|01012121212|비밀메모|남궁민수/);
  });
});

describe('static', () => {
  it('serves member.html for /m/* and falls back to index.html', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sp-static-'));
    writeFileSync(join(dir, 'index.html'), 'INDEX'); writeFileSync(join(dir, 'member.html'), 'MEMBER'); writeFileSync(join(dir, 'a.js'), 'JS');
    app = createApp({ db, secureCookies: false, allowedOrigin: ORIGIN, staticDir: dir });
    expect(await (await app.request('/m/abc')).text()).toBe('MEMBER');
    expect(await (await app.request('/members')).text()).toBe('INDEX');
    expect(await (await app.request('/a.js')).text()).toBe('JS');
    expect((await app.request('/api/nope')).status).toBe(401);
  });
});

describe('final review fixes', () => {
  it('assign re-run creates the pass for a payment whose member matched but product did not', async () => {
    const o = await login('owner');
    const m = await (await req('/members', { method: 'POST', body: { name: '마', phone: '01055556666' } }, o)).json();
    await req('/payments/import', { method: 'POST', body: { rows: [kiosk('u1', '01055556666', '키오스크 4회 이용권')] } }, o);
    const p = (await (await req('/bootstrap', {}, o)).json()).payments.find((x: any) => x.externalId === 'u1');
    expect(p).toMatchObject({ memberId: m.id, status: 'APPROVED' });
    expect(p.passId).toBeUndefined();
    expect((await (await req(`/payments/${p.id}/assign`, { method: 'POST', body: { memberId: m.id } }, o)).json()).passId).toBeNull();
    expect((await req('/products/p_four', { method: 'PUT', body: { name: '키오스크 4회 이용권' } }, o)).status).toBe(200);
    expect((await (await req(`/payments/${p.id}/assign`, { method: 'POST', body: { memberId: m.id } }, o)).json()).passId).toBeTruthy();
    expect(db.prepare('select count(*) n from passes where member_id=?').get(m.id).n).toBe(1);
  });
  it('bootstrap keeps an old payment that has a member but no pass', async () => {
    const o = await login('owner');
    db.prepare("insert into payments(id,source,paid_at,amount,payer_phone,product_name,status,member_id,created_at) values('old1','KIOSK','2026-05-01T00:00:00Z',1000,'0101','x','APPROVED',null,'x')").run();
    const m = db.prepare('select id from members limit 1').get() ?? (await (await req('/members', { method: 'POST', body: { name: '바', phone: '01011110000' } }, o)).json());
    db.prepare("update payments set member_id=? where id='old1'").run(m.id);
    expect((await (await req('/bootstrap', {}, o)).json()).payments.some((x: any) => x.id === 'old1')).toBe(true);
  });
  it('PUT with null clears optional fields (product courseId, course level)', async () => {
    const o = await login('owner');
    const co = db.prepare("select id from courses where kind='GENERAL' and level is not null limit 1").get();
    expect(await (await req('/products/p_one', { method: 'PUT', body: { courseId: co.id } }, o)).json()).toMatchObject({ courseId: co.id });
    const cleared = await (await req('/products/p_one', { method: 'PUT', body: { courseId: null } }, o)).json();
    expect(cleared.courseId).toBeUndefined();
    expect(db.prepare("select course_id from products where id='p_one'").get().course_id).toBeNull();
    expect((await (await req(`/courses/${co.id}`, { method: 'PUT', body: { level: null } }, o)).json()).level).toBeUndefined();
    expect(db.prepare('select level from courses where id=?').get(co.id).level).toBeNull();
  });
  it('settlement detail returns rows of a month older than the 62-day bootstrap window', async () => {
    const o = await login('owner');
    const m = await (await req('/members', { method: 'POST', body: { name: '사공', phone: '01033334444' } }, o)).json();
    const co = db.prepare("select id, instructor_id from courses where kind='GENERAL' limit 1").get();
    db.prepare("insert into payments(id,source,paid_at,amount,payer_name,payer_phone,product_name,status,member_id,created_at) values('pj','KIOSK','2026-06-30T16:00:00Z',180000,'사공','01033334444','정규 클래스 8회권','APPROVED',?,'x')").run(m.id);
    db.prepare("insert into passes(id,member_id,product_id,kind,total_count,remaining,valid_from,valid_to,payment_id,price,created_at) values('sj',?,'p_eight','COUNT',8,7,'2026-07-01','2026-08-30','pj',180000,'x')").run(m.id);
    db.prepare("insert into attendances(id,member_id,pass_id,course_id,instructor_id,attended_at,attended_on) values('aj',?,'sj',?,?,'2026-07-02T11:00:00Z','2026-07-02')").run(m.id, co.id, co.instructor_id);
    const boot = await (await req('/bootstrap', {}, o)).json();
    expect(boot.attendances.some((a: any) => a.id === 'aj')).toBe(false);
    const d = await (await req('/settlement/detail?month=2026-07', {}, o)).json();
    expect(d.attendances).toHaveLength(1);
    expect(d.attendances[0]).toMatchObject({ member: '사공', passKind: 'COUNT', value: 22500 });
    expect(d.attendances[0].course).toBeTruthy(); expect(d.attendances[0].instructor).toBeTruthy();
    // 2026-06-30T16:00Z is 2026-07-01 01:00 KST, so it belongs to July
    expect(d.payments).toEqual([expect.objectContaining({ member: '사공', amount: 180000, status: 'APPROVED', productName: '정규 클래스 8회권' })]);
    expect((await (await req('/settlement/detail?month=2026-06', {}, o)).json()).payments).toHaveLength(0);
    expect((await req('/settlement/detail?month=2026-13', {}, o)).status).toBe(400);
    expect((await req('/settlement/detail?month=2026-07', {}, await login('desk'))).status).toBe(403);
  });
  it('rejects bodies over 2MB with 413 TOO_LARGE', async () => {
    const o = await login('owner');
    const big = 'x'.repeat(2 * 1024 * 1024 + 10);
    const r = await app.request('/api/members', { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: o }, body: JSON.stringify({ name: big }) });
    expect(r.status).toBe(413);
    expect(await r.json()).toEqual({ error: 'TOO_LARGE' });
  });
  it('caps password and free-text lengths', async () => {
    const long = 'p'.repeat(201);
    expect((await req('/auth/login', { method: 'POST', body: { loginId: 'owner', password: long } })).status).toBe(400);
    const o = await login('owner');
    expect((await req('/staff', { method: 'POST', body: { loginId: 'd2', name: '둘', password: long } }, o)).status).toBe(400);
    expect((await req('/staff', { method: 'POST', body: { loginId: 'd2', name: '둘', password: 'p'.repeat(200) } }, o)).status).toBe(200);
    expect((await req('/members', { method: 'POST', body: { name: '가'.repeat(51) } }, o)).status).toBe(400);
    expect((await req('/members', { method: 'POST', body: { name: '가', memo: 'm'.repeat(501) } }, o)).status).toBe(400);
    expect((await req('/payments', { method: 'POST', body: { amount: 1000, productName: 'p'.repeat(101) } }, o)).status).toBe(400);
    expect(await (await req('/payments/import', { method: 'POST', body: { rows: [{ ...kiosk('L1', '010'), payerName: 'n'.repeat(51) }] } }, o)).json()).toMatchObject({ added: 0, rejected: [{ index: 0, reason: 'NAME_TOO_LONG' }] });
  });
  it('static cache headers and member page referrer policy', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sp-static-'));
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'index.html'), 'INDEX'); writeFileSync(join(dir, 'member.html'), 'MEMBER'); writeFileSync(join(dir, 'assets', 'a-123.js'), 'JS');
    app = createApp({ db, secureCookies: false, allowedOrigin: ORIGIN, staticDir: dir });
    const mpage = await app.request('/m/abc');
    expect(mpage.headers.get('cache-control')).toBe('no-cache');
    expect(mpage.headers.get('referrer-policy')).toBe('no-referrer');
    expect((await app.request('/members')).headers.get('cache-control')).toBe('no-cache');
    expect((await app.request('/')).headers.get('cache-control')).toBe('no-cache');
    expect((await app.request('/assets/a-123.js')).headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect((await app.request('/members')).headers.get('referrer-policy')).toBeNull();
  });
});
