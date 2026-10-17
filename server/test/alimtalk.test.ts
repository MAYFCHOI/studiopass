import { describe, it, expect, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { openDb } from '../src/db.js';
import { seedIfEmpty } from '../src/domain/seed.js';
import { createStaff } from '../src/auth/sessions.js';
import { createApp } from '../src/app.js';
import { loadAlimtalkConfig, sendAlimtalk, notifyMember, type AlimtalkConfig } from '../src/notify/alimtalk.js';
import { TEMPLATES } from '../src/notify/templates.js';
import { makeDb } from './fixtures.js';

const ENV = {
  SP_ALIMTALK_API_KEY: 'NCSKEY123', SP_ALIMTALK_API_SECRET: 'sekret', SP_ALIMTALK_PF_ID: 'KA01PF', SP_ALIMTALK_SENDER: '0212345678',
  SP_ALIMTALK_TPL_LINK: 'TPL_LINK', SP_ALIMTALK_TPL_REMAINING: 'TPL_REM', SP_ALIMTALK_TPL_EXPIRING: 'TPL_EXP', SP_ALIMTALK_TPL_PRO_RENEW: 'TPL_PRO',
};
const ON: AlimtalkConfig = loadAlimtalkConfig(ENV);
const OFF: AlimtalkConfig = loadAlimtalkConfig({ ...ENV, SP_ALIMTALK_TPL_PRO_RENEW: '' });
type Call = { url: string; init: RequestInit };
const fakeFetch = (status = 200, json: unknown = { groupInfo: { groupId: 'G4V1' }, failedMessageList: [] }) => {
  const calls: Call[] = [];
  const f = (async (url: any, init: any) => { calls.push({ url: String(url), init }); return new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } }); }) as typeof fetch;
  return { f, calls };
};
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('config', () => {
  it('is enabled only when every SP_ALIMTALK_* value is non-empty', () => {
    expect(ON.enabled).toBe(true);
    expect(ON.templates).toEqual({ LINK: 'TPL_LINK', REMAINING: 'TPL_REM', EXPIRING: 'TPL_EXP', PRO_RENEW: 'TPL_PRO' });
    expect(OFF.enabled).toBe(false);
    expect(loadAlimtalkConfig({}).enabled).toBe(false);
    expect(loadAlimtalkConfig({ ...ENV, SP_ALIMTALK_API_KEY: '  ' }).enabled).toBe(false);
  });
  it('defines all four templates with their variables', () => {
    expect(Object.keys(TEMPLATES).sort()).toEqual(['EXPIRING', 'LINK', 'PRO_RENEW', 'REMAINING']);
    for (const t of Object.values(TEMPLATES)) for (const v of t.vars) expect(t.text).toContain(`#{${v}}`);
  });
  it('docs/ALIMTALK.md carries every template text verbatim', () => {
    const doc = readFileSync(new URL('../../docs/ALIMTALK.md', import.meta.url), 'utf8');
    for (const t of Object.values(TEMPLATES)) expect(doc).toContain('```text\n' + t.text + '\n```');
  });
});

describe('sendAlimtalk', () => {
  it('signs with HMAC-SHA256 and posts the alimtalk body', async () => {
    const { f, calls } = fakeFetch();
    const r = await sendAlimtalk(ON, '010-1111-2222', 'LINK', { 이름: '김서연', 링크: 'https://s.test/m/abc' }, f);
    expect(r).toEqual({ ok: true, id: 'G4V1' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.solapi.com/messages/v4/send-many/detail');
    expect(calls[0].init.method).toBe('POST');
    const auth = (calls[0].init.headers as Record<string, string>).Authorization;
    expect(auth).toMatch(/^HMAC-SHA256 apiKey=\S+, date=\S+, salt=[0-9a-f]+, signature=[0-9a-f]{64}$/);
    const [, date, salt, sig] = auth.match(/date=(\S+), salt=(\S+), signature=(\S+)$/)!;
    expect(sig).toBe(createHmac('sha256', 'sekret').update(date + salt).digest('hex'));
    expect(auth).toContain('apiKey=NCSKEY123,');
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.messages).toHaveLength(1);
    const m = body.messages[0];
    expect(m.to).toBe('01011112222');
    expect(m.from).toBe('0212345678');
    expect(m.kakaoOptions).toEqual({ pfId: 'KA01PF', templateId: 'TPL_LINK', variables: { '#{이름}': '김서연', '#{링크}': 'https://s.test/m/abc' }, disableSms: false });
  });
  it('returns ok:false on HTTP 400 and on failedMessageList entries', async () => {
    expect(await sendAlimtalk(ON, '01011112222', 'LINK', {}, fakeFetch(400, { errorCode: 'ValidationError', errorMessage: 'x' }).f)).toEqual({ ok: false, error: 'ValidationError' });
    expect(await sendAlimtalk(ON, '01011112222', 'LINK', {}, fakeFetch(200, { groupInfo: { groupId: 'G' }, failedMessageList: [{ statusCode: '3008' }] }).f)).toEqual({ ok: false, error: '3008' });
    const boom = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
    expect(await sendAlimtalk(ON, '01011112222', 'LINK', {}, boom)).toEqual({ ok: false, error: 'NETWORK' });
  });
  it('never calls fetch when switched off', async () => {
    const { f, calls } = fakeFetch();
    expect((await sendAlimtalk(OFF, '01011112222', 'LINK', {}, f)).ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe('notifyMember', () => {
  it('skips when off: no fetch, no message row', async () => {
    const { db, member } = makeDb(); const id = member();
    const { f, calls } = fakeFetch();
    expect(await notifyMember(db, OFF, id, 'LINK', { 이름: 'a', 링크: 'b' }, null, f)).toEqual({ skipped: true });
    expect(calls).toHaveLength(0);
    expect(db.prepare('select count(*) n from messages').get()).toEqual({ n: 0 });
  });
  it('records a sent row and a failed row (no response body)', async () => {
    const { db, member } = makeDb(); const id = member();
    expect(await notifyMember(db, ON, id, 'LINK', { 이름: 'a', 링크: 'b' }, 'st', fakeFetch().f)).toEqual({ ok: true, id: 'G4V1' });
    expect(await notifyMember(db, ON, id, 'LINK', { 이름: 'a', 링크: 'b' }, 'st', fakeFetch(400, { errorCode: 'Bad', errorMessage: '김서연 01011112222' }).f)).toEqual({ ok: false, error: 'Bad' });
    const rows = db.prepare('select member_id, channel, kind, status, error, provider_id, created_by from messages order by rowid').all();
    expect(rows).toEqual([
      { member_id: id, channel: 'ALIMTALK', kind: 'LINK', status: 'SENT', error: null, provider_id: 'G4V1', created_by: 'st' },
      { member_id: id, channel: 'ALIMTALK', kind: 'LINK', status: 'FAILED', error: 'Bad', provider_id: null, created_by: 'st' },
    ]);
  });
  it('skips a member without a phone', async () => {
    const { db, member } = makeDb(); const id = member('a', '');
    const { f, calls } = fakeFetch();
    expect(await notifyMember(db, ON, id, 'LINK', {}, null, f)).toEqual({ skipped: true });
    expect(calls).toHaveLength(0);
  });
});

describe('api wiring', () => {
  const ORIGIN = 'https://studio.test';
  let db: any;
  const mk = (o: { alimtalk?: AlimtalkConfig; fetchImpl?: typeof fetch; origin?: string | null }) => {
    const app = createApp({ db, secureCookies: false, allowedOrigin: o.origin === undefined ? ORIGIN : o.origin, alimtalk: o.alimtalk, fetchImpl: o.fetchImpl, now: () => new Date('2026-10-19T10:30:00Z') });
    const req = (path: string, init: any = {}, cookie?: string) => app.request('/api' + path, { ...init, headers: { 'content-type': 'application/json', origin: ORIGIN, ...(cookie ? { cookie } : {}) }, body: init.body ? JSON.stringify(init.body) : undefined });
    const login = async () => ((await req('/auth/login', { method: 'POST', body: { loginId: 'desk', password: 'pw-12345678' } })).headers.get('set-cookie') ?? '').split(';')[0];
    return { req, login };
  };
  const kiosk = (externalId: string, phone: string) => ({ source: 'KIOSK', externalId, paidAt: '2026-10-19T09:00:00Z', amount: 100000, payerName: 'x', payerPhone: phone, productName: '정규 클래스 4회권' });
  beforeEach(async () => {
    db = openDb(':memory:'); seedIfEmpty(db);
    await createStaff(db, { loginId: 'desk', name: '인포', role: 'DESK', password: 'pw-12345678' });
  });

  it('bootstrap reports alimtalkEnabled', async () => {
    for (const [cfg, want] of [[ON, true], [OFF, false], [undefined, false]] as const) {
      const { req, login } = mk({ alimtalk: cfg }); const c = await login();
      expect((await (await req('/bootstrap', {}, c)).json()).alimtalkEnabled).toBe(want);
    }
  });

  it('sends the LINK alimtalk after a pass is created by import', async () => {
    const { f, calls } = fakeFetch();
    const { req, login } = mk({ alimtalk: ON, fetchImpl: f }); const c = await login();
    const m = await (await req('/members', { method: 'POST', body: { name: '김서연', phone: '01011112222' } }, c)).json();
    expect(calls).toHaveLength(0);
    expect(await (await req('/payments/import', { method: 'POST', body: { rows: [kiosk('k1', '01011112222')] } }, c)).json()).toMatchObject({ added: 1, dup: 0, matched: 1, cancelled: 0, cancelFailed: 0 });
    await flush(); await flush();
    expect(calls).toHaveLength(1);
    const msg = JSON.parse(String(calls[0].init.body)).messages[0];
    expect(msg.kakaoOptions.templateId).toBe('TPL_LINK');
    expect(msg.kakaoOptions.variables['#{이름}']).toBe('김서연');
    expect(msg.kakaoOptions.variables['#{링크}']).toMatch(/^https:\/\/studio\.test\/m\/[A-Za-z0-9_-]{22}$/);
    const token = msg.kakaoOptions.variables['#{링크}'].split('/m/')[1];
    expect((await req('/public/m/' + token)).status).not.toBe(404);
    expect(db.prepare('select member_id, channel, kind, status from messages').all()).toEqual([{ member_id: m.id, channel: 'ALIMTALK', kind: 'LINK', status: 'SENT' }]);
  });

  it('automatic send on a new pass is skipped when the member already has a link (no rotation)', async () => {
    const { f, calls } = fakeFetch();
    const { req, login } = mk({ alimtalk: ON, fetchImpl: f }); const c = await login();
    const m = await (await req('/members', { method: 'POST', body: { name: '김서연', phone: '01011112222' } }, c)).json();
    const { url } = await (await req(`/members/${m.id}/link`, { method: 'POST' }, c)).json();
    const token = url.split('/m/')[1];
    expect(await (await req('/payments/import', { method: 'POST', body: { rows: [kiosk('k1', '01011112222')] } }, c)).json()).toMatchObject({ added: 1, matched: 1 });
    await flush(); await flush();
    expect(calls).toHaveLength(0);
    expect(db.prepare('select count(*) n from messages').get()).toEqual({ n: 0 });
    expect((await req('/public/m/' + token)).status).toBe(200);
  });

  it('first automatic send issues the first link; a second pass later sends nothing', async () => {
    const { f, calls } = fakeFetch();
    const { req, login } = mk({ alimtalk: ON, fetchImpl: f }); const c = await login();
    const m = await (await req('/members', { method: 'POST', body: { name: '김서연', phone: '01011112222' } }, c)).json();
    expect(db.prepare('select count(*) n from member_links where member_id=?').get(m.id)).toEqual({ n: 0 });
    await req('/payments/import', { method: 'POST', body: { rows: [kiosk('k1', '01011112222')] } }, c);
    await flush(); await flush();
    expect(calls).toHaveLength(1);
    const token = JSON.parse(String(calls[0].init.body)).messages[0].kakaoOptions.variables['#{링크}'].split('/m/')[1];
    await req('/payments/import', { method: 'POST', body: { rows: [kiosk('k2', '01011112222')] } }, c);
    await flush(); await flush();
    expect(calls).toHaveLength(1);
    expect((await req('/public/m/' + token)).status).toBe(200);
  });

  it('a failing send does not affect the import and is recorded as FAILED', async () => {
    const boom = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
    const { req, login } = mk({ alimtalk: ON, fetchImpl: boom }); const c = await login();
    await req('/members', { method: 'POST', body: { name: '김서연', phone: '01011112222' } }, c);
    expect(await (await req('/payments/import', { method: 'POST', body: { rows: [kiosk('k1', '01011112222')] } }, c)).json()).toMatchObject({ added: 1, dup: 0, matched: 1, cancelled: 0, cancelFailed: 0 });
    await flush(); await flush();
    expect(db.prepare('select count(*) n from passes').get()).toEqual({ n: 1 });
    expect(db.prepare('select status, error from messages').all()).toEqual([{ status: 'FAILED', error: 'NETWORK' }]);
  });

  it('sends nothing when off or when no origin is configured', async () => {
    for (const o of [{ alimtalk: OFF }, { alimtalk: ON, origin: null }]) {
      db.prepare('delete from messages').run();
      const { f, calls } = fakeFetch();
      const { req, login } = mk({ ...o, fetchImpl: f }); const c = await login();
      const phone = '0109999' + String(Math.floor(Math.random() * 9000) + 1000);
      await req('/members', { method: 'POST', body: { name: '가', phone } }, c);
      await req('/payments', { method: 'POST', body: { amount: 1000, productName: '정규 클래스 4회권', payerPhone: phone } }, c);
      await flush(); await flush();
      expect(calls).toHaveLength(0);
      expect(db.prepare('select count(*) n from messages').get()).toEqual({ n: 0 });
    }
  });

  it('member button: channel ALIMTALK sends now; default stays SMS_LINK; off is refused', async () => {
    const { f, calls } = fakeFetch();
    const { req, login } = mk({ alimtalk: ON, fetchImpl: f }); const c = await login();
    const m = await (await req('/members', { method: 'POST', body: { name: '김서연', phone: '01011112222' } }, c)).json();
    expect(await (await req(`/members/${m.id}/messages`, { method: 'POST', body: { channel: 'ALIMTALK' } }, c)).json()).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(await (await req(`/members/${m.id}/messages`, { method: 'POST' }, c)).json()).toEqual({ ok: true });
    expect(db.prepare('select channel, kind from messages order by rowid').all()).toEqual([{ channel: 'ALIMTALK', kind: 'LINK' }, { channel: 'SMS_LINK', kind: 'LINK' }]);
    expect((await req(`/members/${m.id}/messages`, { method: 'POST', body: { channel: 'FAX' } }, c)).status).toBe(400);
    const off = mk({ alimtalk: OFF, fetchImpl: f }); const c2 = await off.login();
    expect((await off.req(`/members/${m.id}/messages`, { method: 'POST', body: { channel: 'ALIMTALK' } }, c2)).status).toBe(409);
  });
});
