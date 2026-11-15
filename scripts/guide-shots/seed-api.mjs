// Fake members, Toss-like payments and attendances through the API, so screens look like a normal day.
const O = process.env.ORIGIN;
async function login(id) {
  const r = await fetch(O + '/api/auth/login', { method: 'POST', headers: { origin: O, 'content-type': 'application/json' }, body: JSON.stringify({ loginId: id, password: 'guide-password-1' }) });
  return r.headers.get('set-cookie').split(';')[0];
}
const ck = await login('owner');
const api = async (m, p, b) => { const r = await fetch(O + '/api' + p, { method: m, headers: { origin: O, cookie: ck, 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); const t = await r.text(); if (!r.ok) throw new Error(p + ' ' + r.status + ' ' + t); return JSON.parse(t); };
const ago = (d, h = 19, mi = 0) => { const x = new Date(); x.setDate(x.getDate() - d); x.setHours(h, mi, 0, 0); return x.toISOString(); };
let n = 0; const pay = (productName, amount, payerPhone, paidAt) => ({ source: 'KIOSK', externalId: 'g' + (++n), paidAt, amount, payerName: null, payerPhone, productName });
const people = [['김하늘', '01020250001', 'HILLY', 130000], ['이도윤', '01020250002', 'YUZ', 130000], ['박서연', '01020250003', 'HILLY', 130000], ['최민준', '01020250004', 'REDY', 150000], ['정유나', '01020250005', 'HILLY', 130000], ['한지우', '01020250006', 'YENI CHO Lv.3', 150000]];
await api('POST', '/payments/import', { rows: [
  ...people.map(([, ph, prod, amt], i) => pay(prod, amt, ph, ago(3 + i, 18, 10 * i))),
  pay('YODA', 130000, '01020250099', ago(0, 13, 20)),          // 번호가 회원과 안 맞음 → 회원 연결
  pay('(1 TICKET) HILLY', 35000, null, ago(0, 13, 41)),        // 원데이, 이름 아직 없음
  pay('WARM UP TRAINING', 30000, null, ago(0, 13, 45)),        // 원데이, 이름 아직 없음
  pay('(1 TICKET) YUZ', 35000, null, ago(1, 18, 5)),
] });
const members = [];
for (const [name, phone] of people) members.push(await api('POST', '/members', { name, phone }));
const pays = await api('GET', '/bootstrap').then((b) => b.payments).catch(() => []);
const yuzDrop = pays.find?.((p) => p.productName === '(1 TICKET) YUZ');
if (yuzDrop) await api('POST', `/payments/${yuzDrop.id}/payer-name`, { name: '오세린' });
const hilly = (await api('GET', '/bootstrap')).courses.find((c) => c.weekday?.includes(new Date().getDay()));
console.log('today course', hilly?.name, hilly?.id);
for (const m of members.slice(0, 3)) if (hilly) await api('POST', '/attendances', { memberId: m.id, courseId: hilly.id }).catch((e) => console.log('att', e.message));
await api('POST', '/payments', { amount: 130000, productName: 'HILLY', memberId: members[4].id, method: 'TRANSFER', payerName: '정유나' }).catch((e) => console.log(e.message));
console.log('members', members.map((m) => m.memberNo).join(' '));
