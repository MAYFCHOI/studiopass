import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import { openDb } from './db.js';
import { seedIfEmpty } from './domain/seed.js';
import { createStaff } from './auth/sessions.js';
import { hashPassword } from './auth/password.js';

const USAGE = 'usage: npm run cli -- create-owner <loginId> <name> | create-desk <loginId> <name> | reset-password <loginId>\npassword: env SP_PASSWORD or one line on stdin';
const fail = (msg: string): never => { console.error(msg); process.exit(1); };

async function readPassword() {
  if (process.env.SP_PASSWORD) return process.env.SP_PASSWORD;
  const rl = createInterface({ input: process.stdin });
  const line = await new Promise<string | undefined>((ok) => { rl.once('line', ok); rl.once('close', () => ok(undefined)); });
  rl.close();
  return line ?? '';
}

async function main() {
  const [cmd, a, b] = process.argv.slice(2);
  const known = ['create-owner', 'create-desk', 'reset-password'];
  if (!cmd || !known.includes(cmd)) fail(`unknown command: ${cmd ?? '(none)'}\n${USAGE}`);
  const needed = cmd === 'reset-password' ? 1 : 2;
  if (!a || (needed === 2 && !b)) fail(`missing arguments for ${cmd}\n${USAGE}`);
  const file = process.env.SP_DB ?? 'data/studiopass.db';
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = openDb(file);
  seedIfEmpty(db);
  const password = await readPassword();
  if (password.length < 8) fail('password must be at least 8 characters');
  if (cmd === 'reset-password') {
    const row = db.prepare('select id from staff where login_id=?').get(a) as { id: string } | undefined;
    if (!row) fail(`no such staff: ${a}`);
    const pw = await hashPassword(password);
    db.transaction(() => {
      db.prepare('update staff set pw_hash=? where login_id=?').run(pw, a);
      db.prepare('delete from sessions where staff_id=?').run(row!.id);
    })();
    console.log(`password reset for ${a}; sessions cleared`);
    return;
  }
  if (db.prepare('select 1 from staff where login_id=?').get(a)) fail(`loginId already exists: ${a}`);
  const role = cmd === 'create-owner' ? 'OWNER' : 'DESK';
  await createStaff(db, { loginId: a, name: b, role, password });
  console.log(`created ${role} ${a}`);
}
main().catch((e) => fail(`error: ${e instanceof Error ? e.message : String(e)}`));
