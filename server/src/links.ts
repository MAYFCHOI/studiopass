import { randomBytes, createHash } from 'node:crypto';
import type { Db } from './db.js';
import { nowIso } from './util.js';
import { audit } from './audit.js';
const h = (t: string) => createHash('sha256').update(t).digest('hex');
/** Issues a fresh member-page token (22 chars base64url). Only its sha256 is stored; reissuing replaces the old one. */
export function issueLink(db: Db, memberId: string, staffId: string | null) {
  const t = randomBytes(16).toString('base64url');
  db.prepare('insert into member_links(member_id,token_hash,issued_at,issued_by) values(?,?,?,?) on conflict(member_id) do update set token_hash=excluded.token_hash, issued_at=excluded.issued_at, issued_by=excluded.issued_by').run(memberId, h(t), nowIso(), staffId);
  audit(db, staffId, 'member.link', 'member', memberId);
  return t;
}
export const memberIdForToken = (db: Db, token: string) => (/^[A-Za-z0-9_-]{16,64}$/.test(token) ? ((db.prepare('select member_id from member_links where token_hash=?').get(h(token)) as { member_id: string } | undefined)?.member_id ?? null) : null);
