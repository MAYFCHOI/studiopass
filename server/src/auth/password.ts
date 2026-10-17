import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto';
const N = 32768, R = 8, P = 1, LEN = 32;
const run = (pw: string, salt: Buffer, n: number, r: number, p: number) => new Promise<Buffer>((ok, no) => scrypt(pw, salt, LEN, { N: n, r, p, maxmem: 128 * n * r * 2 }, (e, k) => (e ? no(e) : ok(k))));
export async function hashPassword(pw: string) { const salt = randomBytes(16); const k = await run(pw, salt, N, R, P); return `scrypt$${N}$${R}$${P}$${salt.toString('hex')}$${k.toString('hex')}`; }
export async function verifyPassword(pw: string, stored: string) {
  const [alg, n, r, p, salt, hash] = stored.split('$'); if (alg !== 'scrypt') return false;
  const k = await run(pw, Buffer.from(salt, 'hex'), +n, +r, +p); const want = Buffer.from(hash, 'hex');
  return k.length === want.length && timingSafeEqual(k, want);
}
