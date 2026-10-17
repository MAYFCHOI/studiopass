import { Hono } from 'hono';
import { kstDate, maskName } from '../util.js';
import { tierFor } from '../domain/tiers.js';
import { qrPayload } from '../qr.js';
import { memberIdForToken } from '../links.js';
import { type AppEnv, type Deps, clock } from './common.js';

/** Unauthenticated routes. The member page response never carries money, phone or memo. */
export function publicRoutes(d: Deps) {
  const r = new Hono<AppEnv>(); const db = d.db;
  r.get('/healthz', (c) => { db.prepare('select 1').get(); return c.json({ ok: true }); });
  r.get('/public/m/:token', (c) => {
    c.header('Cache-Control', 'no-store');
    const memberId = memberIdForToken(db, c.req.param('token'));
    const m = memberId ? (db.prepare('select id, name, created_at from members where id=?').get(memberId) as { id: string; name: string; created_at: string } | undefined) : undefined;
    if (!m) return c.json({ error: 'NOT_FOUND' }, 404);
    const today = kstDate(clock(d));
    const tier = tierFor(db, m.id);
    const passes = db.prepare('select p.remaining, p.total_count, p.valid_to, p.kind, pr.name from passes p join products pr on pr.id=p.product_id where p.member_id=? and p.remaining > 0 and p.valid_from <= ? and p.valid_to >= ? order by p.valid_to').all(m.id, today, today) as any[];
    return c.json({
      studioName: (db.prepare("select value from settings where key='studio_name'").get() as { value: string } | undefined)?.value ?? '',
      name: maskName(m.name),
      since: kstDate(new Date(m.created_at)),
      attendCount: tier.count,
      tier,
      tiers: (db.prepare('select name, min_count from tiers order by sort').all() as any[]).map((t) => ({ name: t.name, minCount: t.min_count })),
      passes: passes.map((p) => ({ name: p.name, remaining: p.remaining, total: p.total_count, validTo: p.valid_to, kind: p.kind })),
      qr: qrPayload(db, m.id),
    });
  });
  return r;
}
