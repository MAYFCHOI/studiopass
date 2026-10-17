import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db.js';
import { hashPassword, verifyPassword } from '../src/auth/password.js';
import { createSession, getSession, deleteSession, createStaff } from '../src/auth/sessions.js';
import { LoginLimiter } from '../src/auth/rateLimit.js';
describe('auth', () => {
  it('hashes and verifies', async () => {
    const h = await hashPassword('depth-2026!');
    expect(h.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('depth-2026!', h)).toBe(true);
    expect(await verifyPassword('wrong', h)).toBe(false);
  });
  it('session lifecycle with expiry', async () => {
    const db = openDb(':memory:');
    const id = await createStaff(db, { loginId: 'owner', name: '원장', role: 'OWNER', password: 'pw-123456' });
    const t = createSession(db, id, new Date('2026-10-01T00:00:00Z'));
    expect(getSession(db, t, new Date('2026-10-20T00:00:00Z'))).toMatchObject({ staffId: id, role: 'OWNER' });
    expect(getSession(db, t, new Date('2026-12-30T00:00:00Z'))).toBeNull();
    const t2 = createSession(db, id); deleteSession(db, t2); expect(getSession(db, t2)).toBeNull();
    expect((db.prepare('select token_hash from sessions limit 1').get() as any)?.token_hash ?? '').not.toBe(t);
  });
  it('inactive staff cannot use sessions', async () => {
    const db = openDb(':memory:');
    const id = await createStaff(db, { loginId: 'desk', name: '인포', role: 'DESK', password: 'pw-123456' });
    const t = createSession(db, id); db.prepare('update staff set active=0').run();
    expect(getSession(db, t)).toBeNull();
  });
  it('limits 5 tries per 10 minutes', () => {
    const l = new LoginLimiter(5, 600000);
    for (let i = 0; i < 5; i++) expect(l.hit('ip|owner', 1000)).toBe(true);
    expect(l.hit('ip|owner', 2000)).toBe(false);
    expect(l.hit('ip|owner', 1000 + 600001)).toBe(true);
  });
});
