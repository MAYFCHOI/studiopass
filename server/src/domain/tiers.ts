import type { Db } from '../db.js';
import { tierIndex } from '../serialize.js';
export function tierFor(db: Db, memberId: string) {
  const count = (db.prepare('select count(*) n from attendances where member_id=? and cancelled_at is null').get(memberId) as { n: number }).n;
  const floor = (db.prepare('select tier_floor from members where id=?').get(memberId) as { tier_floor: number | null } | undefined)?.tier_floor;
  const tiers = db.prepare('select name, min_count from tiers order by sort').all() as { name: string; min_count: number }[];
  const { idx, manual } = tierIndex(tiers, count, floor);
  const next = tiers[idx + 1];
  return { name: tiers[idx]?.name ?? '', level: idx + 1, count, manual, nextName: next?.name ?? null, nextAt: next?.min_count ?? null };
}
