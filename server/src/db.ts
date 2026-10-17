import Database from 'better-sqlite3';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const MIG_DIR = process.env.SP_MIGRATIONS ?? join(dirname(fileURLToPath(import.meta.url)), '../migrations');
export function openDb(file: string) {
  const db = new Database(file);
  db.pragma('foreign_keys = ON');
  if (file !== ':memory:') db.pragma('journal_mode = WAL');
  db.exec('create table if not exists schema_migrations (name text primary key, applied_at text not null)');
  const done = new Set(db.prepare('select name from schema_migrations').all().map((r: any) => r.name));
  for (const f of readdirSync(MIG_DIR).filter((x) => x.endsWith('.sql')).sort()) {
    if (done.has(f)) continue;
    db.transaction(() => { db.exec(readFileSync(join(MIG_DIR, f), 'utf8')); db.prepare('insert into schema_migrations values (?,?)').run(f, new Date().toISOString()); })();
  }
  return db;
}
export type Db = Database.Database;
