import { randomBytes } from 'node:crypto';
const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
export const newId = () => Array.from(randomBytes(12), (b) => B62[b % 62]).join('');
export const nowIso = (d = new Date()) => d.toISOString();
const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' });
export const kstDate = (d = new Date()) => fmt.format(d);
export const kstMonth = (d = new Date()) => kstDate(d).slice(0, 7);
export const addDays = (ymd: string, n: number) => { const t = new Date(ymd + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
export function maskName(name: string) {
  const c = [...name]; if (c.length < 2) return name; if (c.length === 2) return c[0] + '*';
  return c[0] + '*'.repeat(c.length - 2) + c[c.length - 1];
}
export function normalizePhone(s: unknown) {
  if (s === undefined || s === null) return '';
  let d = String(s).replace(/\D/g, '');
  if (d.startsWith('82')) d = '0' + d.slice(2);
  if (d.length === 10 && d.startsWith('10')) d = '0' + d;
  return d;
}
