import { Hono } from 'hono';
import { addDays, kstDate } from '../util.js';
import { type AppEnv, type Deps, clock } from './common.js';
import { type TierRow, tierOf, toMember, toInstructor, toCourse, toProduct, toPass, toPayment, toAttendance } from '../serialize.js';

const WINDOW_DAYS = 62;
export function bootstrapRoutes(d: Deps) {
  const r = new Hono<AppEnv>();
  r.get('/bootstrap', (c) => {
    const me = c.get('me'); const role = me.role; const db = d.db; const now = clock(d);
    const setting = (k: string) => (db.prepare('select value from settings where key=?').get(k) as { value: string } | undefined)?.value;
    const tiers = db.prepare('select name, min_count from tiers order by sort').all() as TierRow[];
    const counts = new Map((db.prepare('select member_id, count(*) n from attendances where cancelled_at is null group by member_id').all() as { member_id: string; n: number }[]).map((x) => [x.member_id, x.n]));
    const sinceIso = new Date(now.getTime() - WINDOW_DAYS * 86400000).toISOString();
    const sinceDay = addDays(kstDate(now), -WINDOW_DAYS);
    return c.json({
      me: { staffId: me.staffId, name: me.name, role },
      studioName: setting('studio_name') ?? '',
      needsRealPrices: setting('needs_real_prices') === '1',
      members: (db.prepare('select * from members order by member_no').all() as any[]).map((m) => toMember(m, tierOf(tiers, counts.get(m.id) ?? 0))),
      instructors: db.prepare('select * from instructors order by name').all().map((x) => toInstructor(x, role)),
      courses: db.prepare('select * from courses order by weekday, start_time, hall').all().map(toCourse),
      products: db.prepare('select * from products order by rowid').all().map((x) => toProduct(x, role)),
      passes: db.prepare('select * from passes order by created_at').all().map((x) => toPass(x, role)),
      payments: db.prepare('select * from payments where paid_at >= ? or member_id is null order by paid_at desc').all(sinceIso).map((x) => toPayment(x, role)),
      attendances: db.prepare('select * from attendances where attended_on >= ? order by attended_at desc').all(sinceDay).map(toAttendance),
      tiers: tiers.map((t) => ({ name: t.name, minCount: t.min_count })),
    });
  });
  return r;
}
