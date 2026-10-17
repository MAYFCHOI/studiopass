// server/src/audit.ts
import type { Db } from './db.js';
import { newId, nowIso } from './util.js';
/** Appends one audit row. Rows are never deleted (접속기록 보관 1년 이상). ip is the client address when known. */
export function audit(db: Db, staffId: string | null, action: string, entity: string, entityId: string | null, detail?: unknown, ip?: string | null) {
  db.prepare('insert into audit_log(id,at,staff_id,action,entity,entity_id,detail_json,ip) values(?,?,?,?,?,?,?,?)').run(newId(), nowIso(), staffId, action, entity, entityId, detail === undefined ? null : JSON.stringify(detail), ip ?? null);
}
