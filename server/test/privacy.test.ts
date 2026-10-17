import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { seedIfEmpty } from '../src/domain/seed.js';
import { createStaff, createSession, getSession } from '../src/auth/sessions.js';
import { LoginLimiter, Gate } from '../src/auth/rateLimit.js';
import { createApp } from '../src/app.js';
const ORIGIN = 'https://studio.test';
let db: any, app: any;
const req = (path: string, init: any = {}, cookie?: string) => app.request('/api' + path, { ...init, headers: { 'content-type': 'application/json', origin: ORIGIN, ...(cookie ? { cookie } : {}), ...(init.headers ?? {}) }, body: init.body ? JSON.stringify(init.body) : undefined });
const login = async (id: string, pw = 'pw-12345678', ip?: string) => { const r = await req('/auth/login', { method: 'POST', headers: ip ? { 'x-forwarded-for': ip } : {}, body: { loginId: id, password: pw } }); return (r.headers.get('set-cookie') ?? '').split(';')[0]; };
const audits = (action: string) => db.prepare('select * from audit_log where action=? order by at').all(action) as any[];
beforeEach(async () => {
  db = openDb(':memory:'); seedIfEmpty(db);
  await createStaff(db, { loginId: 'owner', name: '원장', role: 'OWNER', password: 'pw-12345678' });
  await createStaff(db, { loginId: 'desk', name: '인포', role: 'DESK', password: 'pw-12345678' });
  app = createApp({ db, secureCookies: false, allowedOrigin: ORIGIN, now: () => new Date('2026-10-19T10:30:00Z') });
});

describe('M1 login limits', () => {
  it('limiter evicts expired keys and caps the map', () => {
    const l = new LoginLimiter(5, 1000, 3);
    l.hit('a', 0); l.hit('b', 0); l.hit('c', 0);
    l.hit('d', 10); expect(l.size).toBe(3); // cap: oldest ('a') evicted
    l.hit('e', 5000); expect(l.size).toBe(1); // all older keys expired and swept
  });
  it('gate lets at most 2 run and refuses the rest at once', async () => {
    const g = new Gate(2); let release!: () => void; const wait = new Promise<void>((ok) => (release = ok));
    const a = g.tryRun(() => wait), b = g.tryRun(() => wait);
    expect(await g.tryRun(async () => 1)).toBeNull();
    expect(g.inFlight).toBe(2);
    release(); await a; await b;
    expect(await g.tryRun(async () => 1)).toEqual({ value: 1 });
  });
  it('per-ip limit: rotating login ids is stopped after 30 tries', async () => {
    for (let i = 0; i < 30; i++) expect((await req('/auth/login', { method: 'POST', headers: { 'x-forwarded-for': '9.9.9.9' }, body: { loginId: 'user' + i, password: 'x' } })).status).toBe(401);
    const r = await req('/auth/login', { method: 'POST', headers: { 'x-forwarded-for': '9.9.9.9' }, body: { loginId: 'owner', password: 'pw-12345678' } });
    expect(r.status).toBe(429); expect(await r.json()).toEqual({ error: 'LIMIT' });
    expect(await login('owner', undefined, '8.8.8.8')).toMatch(/^sp_session=/); // other ips unaffected
  });
  it('parallel logins beyond 2 in flight get 429 BUSY without running scrypt', async () => {
    const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => req('/auth/login', { method: 'POST', headers: { 'x-forwarded-for': '7.7.7.' + i }, body: { loginId: 'u' + i, password: 'x' } })));
    const codes = await Promise.all(rs.map(async (r: any) => `${r.status}:${(await r.json()).error}`));
    expect(codes.filter((x) => x === '429:BUSY').length).toBeGreaterThanOrEqual(1);
    expect(codes.filter((x) => x === '401:INVALID').length).toBeLessThanOrEqual(2);
    expect(codes.every((x) => x === '429:BUSY' || x === '401:INVALID')).toBe(true);
  });
});

describe('M3 sessions', () => {
  it('slides 30 days idle but never lives past 90 days after login', async () => {
    const id = db.prepare("select id from staff where login_id='owner'").get().id;
    const t0 = new Date('2026-01-01T00:00:00Z').getTime(); const day = 86400000;
    const t = createSession(db, id, new Date(t0));
    for (const d of [20, 40, 60, 80, 89]) expect(getSession(db, t, new Date(t0 + d * day))).not.toBeNull();
    expect(db.prepare('select expires_at from sessions').get().expires_at).toBe(new Date(t0 + 90 * day).toISOString());
    expect(getSession(db, t, new Date(t0 + 90 * day + 1000))).toBeNull();
    const t2 = createSession(db, id, new Date(t0));
    expect(getSession(db, t2, new Date(t0 + 31 * day))).toBeNull(); // idle expiry unchanged
  });
});

describe('M4 erase', () => {
  const setup = async () => {
    const o = await login('owner');
    const m = await (await req('/members', { method: 'POST', body: { name: '홍길동', phone: '01012345678', memo: '메모' } }, o)).json();
    await req('/payments', { method: 'POST', body: { amount: 180000, productName: '정규 클래스 8회권', payerName: '홍길동', payerPhone: '01012345678' } }, o);
    const url = (await (await req(`/members/${m.id}/link`, { method: 'POST' }, o)).json()).url as string;
    const token = url.split('/m/')[1];
    const co = db.prepare("select id from courses where kind='GENERAL' limit 1").get();
    const page = await (await req('/public/m/' + token)).json();
    expect((await (await req('/attendances', { method: 'POST', body: { qr: page.qr, courseId: co.id } }, o)).json()).ok).toBe(true);
    return { o, m, token, qr: page.qr, co };
  };
  it('anonymizes the member, keeps attendance, passes and settlement totals, audits', async () => {
    const { o, m, token, qr, co } = await setup();
    const before = await (await req('/settlement?month=2026-10', {}, o)).json();
    const r = await req(`/members/${m.id}/erase`, { method: 'POST', headers: { 'x-forwarded-for': '1.2.3.4' } }, o);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ id: m.id, name: '삭제된 회원', phone: '', erased: true });
    const row = db.prepare('select * from members where id=?').get(m.id);
    expect(row).toMatchObject({ name: '삭제된 회원', phone: '', memo: null }); expect(row.erased_at).toBeTruthy();
    expect(db.prepare('select count(*) n from member_links where member_id=?').get(m.id).n).toBe(0);
    expect(db.prepare('select payer_name, payer_phone, amount from payments where member_id=?').all(m.id)).toEqual([{ payer_name: null, payer_phone: '', amount: 180000 }]);
    expect(db.prepare('select count(*) n from attendances where member_id=?').get(m.id).n).toBe(1);
    expect(db.prepare('select count(*) n from passes where member_id=?').get(m.id).n).toBe(1);
    expect(await (await req('/settlement?month=2026-10', {}, o)).json()).toEqual(before);
    expect(JSON.stringify(db.prepare('select * from audit_log').all())).not.toMatch(/홍길동|01012345678/);
    expect(audits('member.erase')).toEqual([expect.objectContaining({ entity_id: m.id, ip: '1.2.3.4' })]);
    // erased members cannot be scanned, edited, linked; their old link is gone
    db.prepare('delete from attendances').run();
    expect(await (await req('/attendances', { method: 'POST', body: { qr, courseId: co.id } }, o)).json()).toEqual({ ok: false, reason: 'UNKNOWN_MEMBER' });
    expect(await (await req('/attendances', { method: 'POST', body: { memberId: m.id, courseId: co.id } }, o)).json()).toEqual({ ok: false, reason: 'UNKNOWN_MEMBER' });
    expect((await req('/public/m/' + token)).status).toBe(404);
    expect((await req(`/members/${m.id}/link`, { method: 'POST' }, o)).status).toBe(409);
    expect((await req(`/members/${m.id}`, { method: 'PATCH', body: { name: '복원' } }, o)).status).toBe(409);
    expect((await req(`/members/${m.id}/erase`, { method: 'POST' }, o)).status).toBe(409);
    expect((await req('/payments', { method: 'POST', body: { amount: 1000, productName: 'x', memberId: m.id } }, o)).status).toBe(409);
    // a later payment with the old phone is not matched to the erased member
    await req('/payments', { method: 'POST', body: { amount: 1000, productName: 'y', payerPhone: '01012345678' } }, o);
    expect(db.prepare("select member_id from payments where product_name='y'").get().member_id).toBeNull();
  });
  it('is OWNER only, and 404 for an unknown member', async () => {
    const { m } = await setup();
    expect((await req(`/members/${m.id}/erase`, { method: 'POST' }, await login('desk'))).status).toBe(403);
    expect((await req('/members/nope/erase', { method: 'POST' }, await login('owner'))).status).toBe(404);
  });
  it('erases the payer fields of an unlinked payment only', async () => {
    const o = await login('owner');
    await req('/payments/import', { method: 'POST', body: { rows: [{ source: 'KIOSK', externalId: 'k1', paidAt: '2026-10-19T09:00:00Z', amount: 50000, payerName: '비회원', payerPhone: '01099990000', productName: '정규 클래스 1회권' }] } }, o);
    const p = db.prepare("select id from payments where external_id='k1'").get();
    expect((await req(`/payments/${p.id}/erase-payer`, { method: 'POST' }, await login('desk'))).status).toBe(403);
    const r = await req(`/payments/${p.id}/erase-payer`, { method: 'POST' }, o);
    expect(r.status).toBe(200);
    expect(db.prepare('select payer_name, payer_phone, amount from payments where id=?').get(p.id)).toEqual({ payer_name: null, payer_phone: '', amount: 50000 });
    expect(audits('payment.erase_payer')).toHaveLength(1);
    const m = await (await req('/members', { method: 'POST', body: { name: '연결', phone: '01088887777' } }, o)).json();
    await req('/payments', { method: 'POST', body: { amount: 1000, productName: 'z', memberId: m.id } }, o);
    const linked = db.prepare("select id from payments where product_name='z'").get();
    expect((await req(`/payments/${linked.id}/erase-payer`, { method: 'POST' }, o)).status).toBe(409);
  });
});

describe('M5 access log', () => {
  it('records login success/failure with ip, logout, settlement view and export; never the password', async () => {
    await req('/auth/login', { method: 'POST', headers: { 'x-forwarded-for': '5.5.5.5' }, body: { loginId: 'owner', password: 'wrong-secret' } });
    await req('/auth/login', { method: 'POST', headers: { 'x-forwarded-for': '5.5.5.5' }, body: { loginId: 'ghost', password: 'wrong-secret' } });
    const o = await login('owner', undefined, '5.5.5.6');
    await req('/settlement?month=2026-10', { headers: { 'x-forwarded-for': '5.5.5.6' } }, o);
    await req('/settlement/detail?month=2026-10', {}, o);
    await req('/auth/logout', { method: 'POST', headers: { 'x-forwarded-for': '5.5.5.7' } }, o);
    const ownerId = db.prepare("select id from staff where login_id='owner'").get().id;
    const fails = audits('auth.login_fail');
    expect(fails.map((a) => [a.staff_id, a.entity_id, JSON.parse(a.detail_json).loginId, a.ip])).toEqual([[null, ownerId, 'owner', '5.5.5.5'], [null, null, 'ghost', '5.5.5.5']]);
    expect(audits('auth.login')).toEqual([expect.objectContaining({ staff_id: ownerId, ip: '5.5.5.6' })]);
    expect(audits('settlement.view')).toEqual([expect.objectContaining({ staff_id: ownerId, entity_id: '2026-10', ip: '5.5.5.6' })]);
    expect(audits('settlement.export')).toEqual([expect.objectContaining({ staff_id: ownerId, entity_id: '2026-10' })]);
    expect(audits('auth.logout')).toEqual([expect.objectContaining({ staff_id: ownerId, ip: '5.5.5.7' })]);
    expect(JSON.stringify(db.prepare('select * from audit_log').all())).not.toMatch(/wrong-secret|pw-12345678/);
  });
  it('GET /audit is OWNER only, filters by KST day and pages newest first', async () => {
    const o = await login('owner');
    expect((await req('/audit', {}, await login('desk'))).status).toBe(403);
    const ins = db.prepare("insert into audit_log(id,at,staff_id,action,entity,entity_id,ip) values(?,?,null,'t','x',null,null)");
    // 2026-09-30T15:30Z = 10-01 00:30 KST; 2026-10-01T15:30Z = 10-02 00:30 KST
    ins.run('a1', '2026-09-30T14:59:00.000Z'); ins.run('a2', '2026-09-30T15:30:00.000Z'); ins.run('a3', '2026-10-01T10:00:00.000Z'); ins.run('a4', '2026-10-01T15:30:00.000Z');
    const p1 = await (await req('/audit?from=2026-10-01&to=2026-10-01&limit=1', {}, o)).json();
    expect(p1.items.map((x: any) => x.id)).toEqual(['a3']);
    const p2 = await (await req(`/audit?from=2026-10-01&to=2026-10-01&limit=1&before=${encodeURIComponent(p1.next)}`, {}, o)).json();
    expect(p2.items.map((x: any) => x.id)).toEqual(['a2']); expect(p2.next).toBeNull();
    const all = await (await req('/audit', {}, o)).json();
    expect(all.items.find((x: any) => x.action === 'auth.login' && x.loginId === 'owner')).toMatchObject({ staffName: '원장' });
    expect(all.items[0].action).toBe('auth.login'); // newest first
    expect((await req('/audit?from=2026-1-1', {}, o)).status).toBe(400);
  });
});

describe('L3 and static', () => {
  it('does not store raw kiosk rows', async () => {
    const o = await login('owner');
    await req('/payments/import', { method: 'POST', body: { rows: [{ source: 'KIOSK', externalId: 'r1', paidAt: '2026-10-19T09:00:00Z', amount: 1, productName: 'x', raw: { 카드번호: '1234-56**' } }] } }, o);
    expect(db.prepare("select raw_json from payments where external_id='r1'").get().raw_json).toBeNull();
  });
  it('a missing /assets file is 404, not the cached index fallback', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sp-static-'));
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'index.html'), 'INDEX'); writeFileSync(join(dir, 'member.html'), 'MEMBER'); writeFileSync(join(dir, 'assets', 'a-1.js'), 'JS');
    app = createApp({ db, secureCookies: false, allowedOrigin: ORIGIN, staticDir: dir });
    const miss = await app.request('/assets/gone-123.js');
    expect(miss.status).toBe(404);
    expect(miss.headers.get('cache-control') ?? '').not.toMatch(/immutable/);
    expect(await miss.text()).not.toBe('INDEX');
    const hit = await app.request('/assets/a-1.js');
    expect(hit.status).toBe(200); expect(hit.headers.get('cache-control')).toMatch(/immutable/);
    expect(await (await app.request('/members')).text()).toBe('INDEX');
  });
});
