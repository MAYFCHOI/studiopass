import { Hono, type MiddlewareHandler } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { createSession, getSession, deleteSession } from '../auth/sessions.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { LoginLimiter, Gate } from '../auth/rateLimit.js';
import { audit } from '../audit.js';
import { type AppEnv, type Deps, COOKIE, LIMITS, body, str, clientIp } from './common.js';

const PUBLIC = [/^\/api\/auth\/login$/, /^\/api\/healthz$/, /^\/api\/public\//];
export const sessionMiddleware = (d: Deps): MiddlewareHandler<AppEnv> => async (c, next) => {
  if (PUBLIC.some((re) => re.test(c.req.path))) return next();
  const me = getSession(d.db, getCookie(c, COOKIE));
  if (!me) return c.json({ error: 'UNAUTHORIZED' }, 401);
  c.set('me', me);
  await next();
};

/** Rejects state-changing requests whose Origin differs from the configured one (CSRF guard on top of SameSite=Lax). */
export const originGuard = (d: Deps): MiddlewareHandler => async (c, next) => {
  if (d.allowedOrigin && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(c.req.method) && c.req.header('origin') !== d.allowedOrigin) return c.json({ error: 'BAD_ORIGIN' }, 403);
  await next();
};

export { clientIp };

let dummyHash: Promise<string> | null = null;
export function authRoutes(d: Deps) {
  const r = new Hono<AppEnv>();
  const limiter = new LoginLimiter(); // per ip|loginId: 5 tries / 10 min, reset on success
  const ipLimiter = new LoginLimiter(30); // per ip across all ids: 30 tries / 10 min, so rotating ids does not help
  const gate = new Gate(2); // scrypt costs ~32 MB and tens of ms; at most 2 in flight, the rest get 429 BUSY
  r.post('/login', async (c) => {
    const b = await body(c);
    if (!b || !str(b.loginId) || b.loginId.length > LIMITS.loginId || typeof b.password !== 'string' || b.password.length > LIMITS.password) return c.json({ error: 'BAD_REQUEST' }, 400);
    const ip = clientIp(c); const key = `${ip}|${b.loginId}`;
    if (!ipLimiter.hit(ip) || !limiter.hit(key)) return c.json({ error: 'LIMIT' }, 429);
    const s = d.db.prepare('select id, name, role, pw_hash from staff where login_id=? and active=1').get(b.loginId) as { id: string; name: string; role: 'OWNER' | 'DESK'; pw_hash: string } | undefined;
    // Unknown login ids still pay one scrypt so response time does not reveal which ids exist.
    const res = await gate.tryRun(async () => (s ? verifyPassword(b.password, s.pw_hash) : (await verifyPassword(b.password, await (dummyHash ??= hashPassword('dummy-password'))), false)));
    if (!res) return c.json({ error: 'BUSY' }, 429);
    if (!s || !res.value) {
      audit(d.db, null, 'auth.login_fail', 'staff', s?.id ?? null, { loginId: b.loginId }, ip);
      return c.json({ error: 'INVALID' }, 401);
    }
    limiter.reset(key);
    const token = createSession(d.db, s.id);
    audit(d.db, s.id, 'auth.login', 'staff', s.id, undefined, ip);
    setCookie(c, COOKIE, token, { httpOnly: true, sameSite: 'Lax', secure: d.secureCookies, path: '/', maxAge: 30 * 86400 });
    return c.json({ me: { staffId: s.id, name: s.name, role: s.role } });
  });
  r.post('/logout', (c) => {
    const t = getCookie(c, COOKIE);
    if (t) deleteSession(d.db, t);
    audit(d.db, c.get('me').staffId, 'auth.logout', 'staff', c.get('me').staffId, undefined, clientIp(c));
    deleteCookie(c, COOKIE, { path: '/', secure: d.secureCookies });
    return c.json({ ok: true });
  });
  r.get('/me', (c) => { const m = c.get('me'); return c.json({ me: { staffId: m.staffId, name: m.name, role: m.role } }); });
  return r;
}
