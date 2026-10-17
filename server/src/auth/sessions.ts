import { randomBytes, createHash } from 'node:crypto';
import type { Db } from '../db.js';
import { newId, nowIso } from '../util.js';
import { hashPassword } from './password.js';
const DAY = 86400000, TTL = 30 * DAY;
const h = (t: string) => createHash('sha256').update(t).digest('hex');
export async function createStaff(db: Db, s: { loginId: string; name: string; role: 'OWNER' | 'DESK'; password: string }) {
  if (s.password.length < 8) throw new Error('password must be at least 8 characters');
  const id = newId();
  db.prepare('insert into staff(id,login_id,name,role,pw_hash,created_at) values(?,?,?,?,?,?)').run(id, s.loginId, s.name, s.role, await hashPassword(s.password), nowIso());
  return id;
}
export function createSession(db: Db, staffId: string, now = new Date()) {
  const t = randomBytes(32).toString('base64url');
  db.prepare('insert into sessions(token_hash,staff_id,created_at,expires_at,last_seen_at) values(?,?,?,?,?)').run(h(t), staffId, nowIso(now), new Date(now.getTime() + TTL).toISOString(), nowIso(now));
  return t;
}
export function getSession(db: Db, token: string | undefined, now = new Date()) {
  if (!token) return null;
  const r = db.prepare('select s.staff_id, s.expires_at, st.role, st.name, st.login_id, st.active from sessions s join staff st on st.id=s.staff_id where s.token_hash=?').get(h(token)) as any;
  if (!r || !r.active || r.expires_at <= nowIso(now)) return null;
  db.prepare('update sessions set last_seen_at=?, expires_at=? where token_hash=?').run(nowIso(now), new Date(now.getTime() + TTL).toISOString(), h(token));
  return { staffId: r.staff_id as string, role: r.role as 'OWNER' | 'DESK', name: r.name as string, loginId: r.login_id as string };
}
export const deleteSession = (db: Db, token: string) => { db.prepare('delete from sessions where token_hash=?').run(h(token)); };
