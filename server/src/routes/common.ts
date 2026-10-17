import type { Context, MiddlewareHandler } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { Db } from '../db.js';
import type { Role } from '../serialize.js';
import type { AlimtalkConfig } from '../notify/alimtalk.js';
export type Deps = { db: Db; secureCookies: boolean; allowedOrigin: string | null; staticDir?: string; now?: () => Date; alimtalk?: AlimtalkConfig; fetchImpl?: typeof fetch };
export type Me = { staffId: string; role: Role; name: string; loginId: string };
export type AppEnv = { Variables: { me: Me } };
export const COOKIE = 'sp_session';
export const clock = (d: Deps) => (d.now ? d.now() : new Date());
export const bad = (c: Context) => c.json({ error: 'BAD_REQUEST' }, 400);
export const notFound = (c: Context) => c.json({ error: 'NOT_FOUND' }, 404);
/** Parses a JSON object body; null when the body is missing, malformed or not an object. */
export async function body(c: Context): Promise<Record<string, any> | null> {
  const b = await c.req.json().catch(() => null);
  return b && typeof b === 'object' && !Array.isArray(b) ? b : null;
}
export const str = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
export const optStr = (v: unknown) => v === undefined || v === null || typeof v === 'string';
/** Absent, null, or a string of at most n characters. */
export const maxLen = (v: unknown, n: number) => v === undefined || v === null || (typeof v === 'string' && v.length <= n);
export const LIMITS = { name: 50, memo: 500, productName: 100, payerName: 50, password: 200, loginId: 50 } as const;
export const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
export const int = (v: unknown, min = 0): v is number => Number.isInteger(v) && (v as number) >= min;
export const ownerOnly: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get('me').role !== 'OWNER') return c.json({ error: 'OWNER_ONLY' }, 403);
  await next();
};
/** Client address: first X-Forwarded-For entry (Caddy replaces any client-sent one), else the socket peer. */
export function clientIp(c: Context) {
  const xff = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
  if (xff) return xff;
  try { return getConnInfo(c).remote.address ?? 'unknown'; } catch { return 'unknown'; }
}
