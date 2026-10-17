// server/test/fixtures.ts
import { openDb } from '../src/db.js';
import { seedIfEmpty } from '../src/domain/seed.js';
let seq = 0;
export function makeDb() {
  const db = openDb(':memory:'); seedIfEmpty(db);
  const member = (name = '김서연', phone = '01011112222') => { const id = 'm' + ++seq; db.prepare('insert into members(id,member_no,name,phone,created_at) values(?,?,?,?,?)').run(id, '2026-' + String(seq).padStart(4, '0'), name, phone, '2026-10-01T00:00:00Z'); return id; };
  const course = (kind: 'GENERAL' | 'PRO' = 'GENERAL') => db.prepare('select id, instructor_id from courses where kind=? limit 1').get(kind) as { id: string; instructor_id: string };
  const pass = (memberId: string, o: { kind?: 'COUNT' | 'PERIOD'; remaining?: number; total?: number; from?: string; to?: string; courseId?: string | null; product?: string }) => {
    const id = 's' + ++seq;
    db.prepare('insert into passes(id,member_id,product_id,course_id,kind,total_count,remaining,valid_from,valid_to,price,created_at) values(?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, memberId, o.product ?? (o.kind === 'PERIOD' ? 'p_pro' : 'p_eight'), o.courseId ?? null, o.kind ?? 'COUNT', o.total ?? 8, o.remaining ?? 8, o.from ?? '2026-10-01', o.to ?? '2026-11-30', 180000, 'x');
    return id;
  };
  return { db, member, course, pass };
}
