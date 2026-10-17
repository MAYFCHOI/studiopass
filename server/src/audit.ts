// server/src/audit.ts
import type { Db } from './db.js';
import { newId, nowIso } from './util.js';
export function audit(db: Db, staffId: string | null, action: string, entity: string, entityId: string | null, detail?: unknown) {
  db.prepare('insert into audit_log(id,at,staff_id,action,entity,entity_id,detail_json) values(?,?,?,?,?,?,?)').run(newId(), nowIso(), staffId, action, entity, entityId, detail === undefined ? null : JSON.stringify(detail));
}
