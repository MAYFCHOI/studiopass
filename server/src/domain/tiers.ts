import type { Db } from '../db.js';
export function tierFor(db: Db, memberId: string) {
  const count = (db.prepare('select count(*) n from attendances where member_id=? and cancelled_at is null').get(memberId) as { n: number }).n;
  const tiers = db.prepare('select name, min_count from tiers order by sort').all() as { name: string; min_count: number }[];
  let idx = 0;
  tiers.forEach((t, i) => { if (count >= t.min_count) idx = i; });
  const next = tiers[idx + 1];
  return { name: tiers[idx]?.name ?? '', level: idx + 1, count, nextName: next?.name ?? null, nextAt: next?.min_count ?? null };
}
