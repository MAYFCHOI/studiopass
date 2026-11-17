import type { Db } from '../db.js';
import { tierIndex, yearsSince } from '../serialize.js';
export function tierFor(db: Db, memberId: string, now = new Date()) {
  const count = (db.prepare('select count(*) n from attendances where member_id=? and cancelled_at is null').get(memberId) as { n: number }).n;
  const m = db.prepare('select tier_floor, since, created_at from members where id=?').get(memberId) as { tier_floor: number | null; since: string | null; created_at: string } | undefined;
  const tiers = db.prepare('select name, min_count, min_years from tiers order by sort').all() as { name: string; min_count: number; min_years: number | null }[];
  const { idx, manual } = tierIndex(tiers, count, m?.tier_floor, m ? yearsSince(m.since, m.created_at, now) : 0);
  const next = tiers[idx + 1];
  return { name: tiers[idx]?.name ?? '', level: idx + 1, count, manual, nextName: next?.name ?? null, nextAt: next?.min_count ?? null, nextYears: next?.min_years ?? null };
}
