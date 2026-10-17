import { it, expect } from 'vitest';
import { openDb } from '../src/db.js';
import { seedIfEmpty } from '../src/domain/seed.js';
it('seeds real schedule once', () => {
  const db = openDb(':memory:');
  expect(seedIfEmpty(db)).toBe(true);
  expect(seedIfEmpty(db)).toBe(false);
  const n = (t: string) => (db.prepare(`select count(*) n from ${t}`).get() as any).n;
  expect(n('courses')).toBe(28); expect(n('instructors')).toBe(18); expect(n('products')).toBe(4); expect(n('tiers')).toBe(4); expect(n('members')).toBe(0);
  expect((db.prepare("select value from settings where key='studio_name'").get() as any).value).toBe('THE DEPTH');
});
