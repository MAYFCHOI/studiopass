import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { getConnInfo } from '@hono/node-server/conninfo';
import { createSession, getSession, deleteSession } from '../auth/sessions.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { LoginLimiter } from '../auth/rateLimit.js';
import { type AppEnv, type Deps, COOKIE, body, str } from './common.js';

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

export function clientIp(c: Context) {
  const xff = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
  if (xff) return xff;
  try { return getConnInfo(c).remote.address ?? 'unknown'; } catch { return 'unknown'; }
}

let dummyHash: Promise<string> | null = null;
export function authRoutes(d: Deps) {
  const r = new Hono<AppEnv>();
  const limiter = new LoginLimiter();
  r.post('/login', async (c) => {
    const b = await body(c);
    if (!b || !str(b.loginId) || typeof b.password !== 'string') return c.json({ error: 'BAD_REQUEST' }, 400);
    const key = `${clientIp(c)}|${b.loginId}`;
    if (!limiter.hit(key)) return c.json({ error: 'LIMIT' }, 429);
    const s = d.db.prepare('select id, name, role, pw_hash from staff where login_id=? and active=1').get(b.loginId) as { id: string; name: string; role: 'OWNER' | 'DESK'; pw_hash: string } | undefined;
    // Unknown login ids still pay one scrypt so response time does not reveal which ids exist.
    const ok = s ? await verifyPassword(b.password, s.pw_hash) : (await verifyPassword(b.password, await (dummyHash ??= hashPassword('dummy-password'))), false);
    if (!s || !ok) return c.json({ error: 'INVALID' }, 401);
    limiter.reset(key);
    const token = createSession(d.db, s.id);
    setCookie(c, COOKIE, token, { httpOnly: true, sameSite: 'Lax', secure: d.secureCookies, path: '/', maxAge: 30 * 86400 });
    return c.json({ me: { staffId: s.id, name: s.name, role: s.role } });
  });
  r.post('/logout', (c) => {
    const t = getCookie(c, COOKIE);
    if (t) deleteSession(d.db, t);
    deleteCookie(c, COOKIE, { path: '/', secure: d.secureCookies });
    return c.json({ ok: true });
  });
  r.get('/me', (c) => { const m = c.get('me'); return c.json({ me: { staffId: m.staffId, name: m.name, role: m.role } }); });
  return r;
}
