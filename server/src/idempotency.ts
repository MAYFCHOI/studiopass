import type { Context } from 'hono';
import type { Db } from './db.js';
import { nowIso } from './util.js';

const TTL_MS = 24 * 3600 * 1000;
const KEY = /^[A-Za-z0-9_-]{8,64}$/;

/** Idempotency-Key header when present and well formed; undefined otherwise (the request then runs normally). */
export const idemKey = (c: Context) => { const k = c.req.header('idempotency-key'); return k && KEY.test(k) ? k : undefined; };

/** Stored response for (key, staff, route) within 24 h. Synchronous, so a caller that also stores synchronously cannot race. */
export function idemGet(db: Db, key: string | undefined, staffId: string, route: string, now = new Date()): { status: number; body: unknown } | null {
  if (!key) return null;
  const r = db.prepare('select status, response_json, created_at from idempotency where key=? and staff_id=? and route=?').get(key, staffId, route) as { status: number; response_json: string; created_at: string } | undefined;
  if (!r || now.getTime() - Date.parse(r.created_at) > TTL_MS) return null;
  return { status: r.status, body: JSON.parse(r.response_json) };
}

export function idemPut(db: Db, key: string | undefined, staffId: string, route: string, status: number, body: unknown, now = new Date()) {
  if (!key) return;
  db.prepare('delete from idempotency where created_at < ?').run(new Date(now.getTime() - TTL_MS).toISOString());
  db.prepare('insert or replace into idempotency(key,staff_id,route,status,response_json,created_at) values(?,?,?,?,?,?)').run(key, staffId, route, status, JSON.stringify(body), nowIso(now));
}
