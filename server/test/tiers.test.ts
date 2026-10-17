import { it, expect } from 'vitest';
import { openDb } from '../src/db.js';
import { seedIfEmpty } from '../src/domain/seed.js';
import { tierFor } from '../src/domain/tiers.js';
it('tier follows active attendance count', () => {
  const db = openDb(':memory:'); seedIfEmpty(db);
  db.exec(`insert into members(id,member_no,name,phone,created_at) values('m','2026-0001','김서연','010','2026-01-01T00:00:00Z');
    insert into passes(id,member_id,product_id,kind,total_count,remaining,valid_from,valid_to,price,created_at) select 's','m',id,'COUNT',99,99,'2026-01-01','2026-12-31',0,'x' from products limit 1;`);
  const course = (db.prepare('select id, instructor_id from courses limit 1').get() as any);
  const add = (i: number, cancelled = false) => db.prepare('insert into attendances(id,member_id,pass_id,course_id,instructor_id,attended_on,attended_at,cancelled_at) values(?,?,?,?,?,?,?,?)').run('a' + i, 'm', 's', course.id, course.instructor_id, `2026-0${1 + Math.floor(i / 28)}-${String(1 + (i % 28)).padStart(2, '0')}`, 'x', cancelled ? 'x' : null);
  expect(tierFor(db, 'm')).toMatchObject({ name: 'DEPTH 1', level: 1, count: 0, nextAt: 10 });
  for (let i = 0; i < 10; i++) add(i);
  expect(tierFor(db, 'm')).toMatchObject({ name: 'DEPTH 2', level: 2, count: 10, nextAt: 30 });
  add(10, true);
  expect(tierFor(db, 'm').count).toBe(10);
  for (let i = 11; i < 71; i++) add(i);
  expect(tierFor(db, 'm')).toMatchObject({ level: 4, nextName: null, nextAt: null });
});
