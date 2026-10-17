import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Db } from './db.js';
export function getSecret(db: Db) {
  const r = db.prepare("select value from settings where key='qr_secret'").get() as { value: string } | undefined;
  if (r) return r.value;
  const v = randomBytes(32).toString('hex');
  db.prepare("insert into settings(key,value) values('qr_secret',?)").run(v);
  return v;
}
const sig = (secret: string, id: string) => createHmac('sha256', secret).update(id).digest('hex').slice(0, 16);
export const qrPayload = (db: Db, memberId: string) => `AM2:${memberId}:${sig(getSecret(db), memberId)}`;
export function parseQr(db: Db, text: string) {
  const m = /^AM2:([0-9A-Za-z_]+):([0-9a-f]{16})$/.exec(text.trim());
  if (!m) return null;
  const want = Buffer.from(sig(getSecret(db), m[1])); const got = Buffer.from(m[2]);
  return want.length === got.length && timingSafeEqual(want, got) ? m[1] : null;
}
