// 2026-11-17 선생님 요청: 결제 고치기, 대강, 등급 기간 조건, 수업 지우기, 이달 결제 합계
import { it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/db.js';
import { seedIfEmpty } from '../src/domain/seed.js';
import { createStaff } from '../src/auth/sessions.js';
import { createApp } from '../src/app.js';
import { attend } from '../src/domain/attendance.js';
const ORIGIN = 'https://studio.test';
let db: any, app: any, o: string, d: string;
const req = (path: string, init: any = {}, cookie?: string) => app.request('/api' + path, { ...init, headers: { 'content-type': 'application/json', origin: ORIGIN, ...(cookie ? { cookie } : {}) }, body: init.body ? JSON.stringify(init.body) : undefined });
const login = async (id: string) => { const r = await req('/auth/login', { method: 'POST', body: { loginId: id, password: 'pw-12345678' } }); return (r.headers.get('set-cookie') ?? '').split(';')[0]; };
const post = async (path: string, body?: unknown, c = o) => req(path, { method: 'POST', body }, c);
beforeEach(async () => {
  db = openDb(':memory:'); seedIfEmpty(db);
  await createStaff(db, { loginId: 'owner', name: '원장', role: 'OWNER', password: 'pw-12345678' });
  await createStaff(db, { loginId: 'desk', name: '인포', role: 'DESK', password: 'pw-12345678' });
  app = createApp({ db, secureCookies: false, allowedOrigin: ORIGIN, now: () => new Date('2026-11-17T10:30:00Z') });
  o = await login('owner'); d = await login('desk');
});
const member = async (name = '가', phone = '01012340000') => (await (await post('/members', { name, phone })).json()).id as string;

it('edits a manual transfer: wrong product remakes the pass, amount only reprices it', async () => {
  const m = await member();
  const pay = await (await post('/payments', { amount: 30000, productName: '정규 클래스 1회권', memberId: m, method: 'TRANSFER', paidAt: '2026-11-10T03:00:00Z' })).json();
  const before = db.prepare('select * from passes where payment_id=?').get(pay.id);
  expect(before.total_count).toBe(1);
  // 인포는 못 고친다
  expect((await post(`/payments/${pay.id}/edit`, { amount: 1 }, d)).status).toBe(403);
  const r = await (await post(`/payments/${pay.id}/edit`, { productName: '정규 클래스 8회권', amount: 180000, method: 'CASH' })).json();
  expect(r).toMatchObject({ productName: '정규 클래스 8회권', amount: 180000, method: 'CASH', paidAt: '2026-11-10T03:00:00.000Z' });
  const after = db.prepare('select * from passes where payment_id=?').all(pay.id);
  expect(after).toHaveLength(1);
  expect(after[0]).toMatchObject({ total_count: 8, price: 180000, valid_from: '2026-11-10' });
  expect(db.prepare('select 1 from passes where id=?').get(before.id)).toBeUndefined();
  // 출석하면 상품은 못 바꾸고 금액만 바꾼다
  attend(db, { memberId: m, courseId: (db.prepare("select id from courses where kind='GENERAL' and weekday=2 limit 1").get() as any).id, staffId: null, now: new Date('2026-11-17T10:30:00Z') });
  const blocked = await post(`/payments/${pay.id}/edit`, { productName: '정규 클래스 1회권' });
  expect(blocked.status).toBe(409);
  expect(await blocked.json()).toEqual({ error: 'PASS_IN_USE', used: 1 });
  expect((await post(`/payments/${pay.id}/edit`, { amount: 160000 })).status).toBe(200);
  expect(db.prepare('select price from passes where payment_id=?').get(pay.id).price).toBe(160000);
  expect(db.prepare("select count(*) n from audit_log where action='payment.edit'").get().n).toBe(2);
});

it('edits a guest drop-in and refuses kiosk or cancelled payments', async () => {
  const c = db.prepare("select id from courses where kind='GENERAL' limit 1").get() as { id: string };
  db.prepare("insert into products(id,name,course_id,pass_kind,count,period_days,price,drop_in) values('p_w','WARM UP',null,'COUNT',1,7,30000,1)").run();
  const pay = await (await post('/payments', { amount: 30000, productName: 'WARM UP', payerName: '손님', courseId: c.id, method: 'TRANSFER' })).json();
  const r = await (await post(`/payments/${pay.id}/edit`, { payerName: '손님2', amount: 25000 })).json();
  expect(r).toMatchObject({ payerName: '손님2', amount: 25000, courseId: c.id, dropIn: true });
  await post('/payments/import', { rows: [{ source: 'KIOSK', externalId: 'k1', paidAt: '2026-11-17T09:00:00Z', amount: 30000, productName: 'WARM UP' }] });
  const k = db.prepare("select id from payments where external_id='k1'").get();
  expect(await (await post(`/payments/${k.id}/edit`, { amount: 1 })).json()).toEqual({ error: 'KIOSK' });
  await post(`/payments/${pay.id}/cancel`);
  expect(await (await post(`/payments/${pay.id}/edit`, { amount: 1 })).json()).toEqual({ error: 'CANCELLED' });
});

it('substitution moves that day to the substitute, with a session even without attendance', async () => {
  const c = db.prepare("select id, instructor_id, weekday from courses where kind='GENERAL' and weekday=3 limit 1").get() as { id: string; instructor_id: string; weekday: number };
  const sub = (db.prepare('select id from instructors where id<>? limit 1').get(c.instructor_id) as { id: string }).id;
  db.prepare("update courses set settlement_type='PER_SESSION', per_session_fee=40000 where id=?").run(c.id);
  // 11/4·11/11 은 수요일. 11/4 는 출석 없이 대강, 11/11 은 원래 강사가 한 날
  expect(await (await post('/substitutions', { courseId: c.id, date: '2026-11-05', instructorId: sub })).json()).toEqual({ error: 'WRONG_DAY' });
  expect(await (await post('/substitutions', { courseId: c.id, date: '2026-11-04', instructorId: c.instructor_id })).json()).toEqual({ error: 'SAME_INSTRUCTOR' });
  expect((await post('/substitutions', { courseId: c.id, date: '2026-11-04', instructorId: sub }, d)).status).toBe(403);
  const s1 = await (await post('/substitutions', { courseId: c.id, date: '2026-11-04', instructorId: sub })).json();
  await post('/substitutions', { courseId: c.id, date: '2026-11-11', instructorId: sub, fee: 30000 });
  const m = await member(); db.prepare("insert into passes(id,member_id,product_id,course_id,kind,total_count,remaining,valid_from,valid_to,price,created_at) values('x1',?,'p_eight',null,'COUNT',8,8,'2026-11-01','2026-12-31',160000,'x')").run(m);
  attend(db, { memberId: m, courseId: c.id, staffId: null, now: new Date('2026-11-11T10:30:00Z') });
  const list = await (await req('/substitutions?month=2026-11', {}, o)).json();
  expect(list).toHaveLength(2);
  const lines = await (await req('/settlement?month=2026-11', {}, o)).json();
  const subLine = lines.find((l: any) => l.instructorId === sub).courses.find((x: any) => x.courseId === c.id && x.sub);
  // 11/4: 수업 기준 4만 원(타임제), 11/11: 대강 금액 3만 원이 따로 정해져 그 줄은 3만 원 × 2타임
  expect(subLine).toMatchObject({ sub: true, type: 'PER_SESSION', perSessionFee: 30000, sessions: 2, heads: 1, instructorPay: 60000 });
  const orig = lines.find((l: any) => l.instructorId === c.instructor_id).courses.find((x: any) => x.courseId === c.id);
  expect(orig).toBeUndefined();
  expect((await req(`/substitutions/${s1.id}`, { method: 'DELETE' }, o)).status).toBe(200);
  const after = (await (await req('/settlement?month=2026-11', {}, o)).json()).find((l: any) => l.instructorId === sub).courses.find((x: any) => x.courseId === c.id);
  expect(after).toMatchObject({ sessions: 1, instructorPay: 30000 });
});

it('drop-in counted on a later class day carries the payment day', async () => {
  const c = db.prepare("select id, instructor_id from courses where kind='GENERAL' and weekday=4 limit 1").get() as { id: string; instructor_id: string };
  db.prepare("insert into products(id,name,course_id,pass_kind,count,period_days,price,drop_in) values('p_j','(1 TICKET) J',?,'COUNT',1,7,35000,1)").run(c.id);
  await post('/payments/import', { rows: [{ source: 'KIOSK', externalId: 'j1', paidAt: '2026-11-16T11:48:00Z', amount: 35000, productName: '(1 TICKET) J' }] });
  const line = (await (await req('/settlement?month=2026-11', {}, o)).json()).find((l: any) => l.instructorId === c.instructor_id).courses.find((x: any) => x.courseId === c.id);
  expect(line.days[0]).toMatchObject({ date: '2026-11-19', people: [{ kind: 'DROP_IN', paidOn: '2026-11-16' }] });
});

it('tier year condition, member since, payments total, course delete', async () => {
  expect((await req('/tiers', { method: 'PUT', body: [{ name: '뎁스 1', minCount: 0 }, { name: '뎁스 4', minCount: 2, minYears: 2 }] }, o)).status).toBe(200);
  const m = await member();
  const c = db.prepare("select id from courses where kind='GENERAL' and weekday=2 limit 1").get() as { id: string };
  db.prepare("insert into passes(id,member_id,product_id,course_id,kind,total_count,remaining,valid_from,valid_to,price,created_at) values('t1',?,'p_eight',null,'COUNT',8,8,'2026-01-01','2026-12-31',160000,'x')").run(m);
  for (const day of ['2026-11-03', '2026-11-10']) db.prepare("insert into attendances(id,member_id,pass_id,course_id,instructor_id,attended_on,attended_at) values(?,?,'t1',?,(select instructor_id from courses where id=?),?,?)").run('a' + day, m, c.id, c.id, day, day + 'T10:00:00Z');
  const tierOfM = async () => (await (await req('/bootstrap', {}, o)).json()).members.find((x: any) => x.id === m).tier.name;
  expect(await tierOfM()).toBe('뎁스 1'); // 횟수는 채웠지만 다닌 지 2년이 안 됨
  expect((await req(`/members/${m}`, { method: 'PATCH', body: { since: '2024-01-01' } }, d)).status).toBe(403);
  expect((await req(`/members/${m}`, { method: 'PATCH', body: { since: '2024-01-01' } }, o)).status).toBe(200);
  expect(await tierOfM()).toBe('뎁스 4');
  expect((await (await req('/bootstrap', {}, o)).json()).tiers[1]).toEqual({ name: '뎁스 4', minCount: 2, minYears: 2 });

  await post('/payments', { amount: 30000, productName: '정규 클래스 1회권', memberId: m, paidAt: '2026-11-02T03:00:00Z' });
  await post('/payments', { amount: 15000, productName: '정규 클래스 1회권', memberId: m, paidAt: '2026-10-31T16:00:00Z', discountPct: 50 }); // KST 11/1
  expect(await (await req('/settlement/payments-total?month=2026-11', {}, o)).json()).toEqual({ total: 45000, count: 2 });
  expect((await req('/settlement/payments-total?month=2026-11', {}, d)).status).toBe(403);
  expect(db.prepare('select discount_pct from payments where amount=15000').get().discount_pct).toBe(50);

  db.prepare("insert into products(id,name,course_id,pass_kind,count,period_days,price,drop_in) values('p_y','Yeni Cho 1day',?,'COUNT',1,7,35000,1)").run(c.id);
  expect(await (await req(`/courses/${c.id}`, { method: 'DELETE' }, o)).json()).toEqual({ error: 'PRODUCTS', count: 1 });
  db.prepare("update products set course_id=null where id='p_y'").run();
  expect((await req(`/courses/${c.id}`, { method: 'DELETE' }, d)).status).toBe(403);
  expect((await req(`/courses/${c.id}`, { method: 'DELETE' }, o)).status).toBe(200);
  const course = (await (await req('/bootstrap', {}, o)).json()).courses.find((x: any) => x.id === c.id);
  expect(course).toMatchObject({ active: false, deleted: true });
  // 지난 출석 정산은 그대로
  expect((await (await req('/settlement?month=2026-11', {}, o)).json()).some((l: any) => l.courses.some((x: any) => x.courseId === c.id))).toBe(true);

  expect((await req('/settings/instructor-discount', { method: 'PUT', body: { pct: 40 } }, o)).status).toBe(200);
  expect((await (await req('/bootstrap', {}, o)).json()).instructorDiscountPct).toBe(40);
});

it('extra pay (warm-up) adds to the instructor without a course, owner only', async () => {
  const ins = (db.prepare('select id from instructors limit 1').get() as { id: string }).id;
  expect((await post('/extra-pays', { date: '2026-11-04', instructorId: ins, fee: 40000, memo: '웜업' }, d)).status).toBe(403);
  expect((await post('/extra-pays', { date: '2026-11-04', instructorId: ins, fee: 0 })).status).toBe(400);
  expect((await post('/extra-pays', { date: '2026-11-04', instructorId: 'nope', fee: 40000 })).status).toBe(400);
  await post('/extra-pays', { date: '2026-11-04', instructorId: ins, fee: 40000, memo: '웜업' });
  const second = await (await post('/extra-pays', { date: '2026-11-11', instructorId: ins, fee: 40000, memo: '웜업' })).json();
  await post('/extra-pays', { date: '2026-12-01', instructorId: ins, fee: 40000, memo: '웜업' });
  const list = await (await req('/extra-pays?month=2026-11', {}, o)).json();
  expect(list).toHaveLength(2);
  const line = (await (await req('/settlement?month=2026-11', {}, o)).json()).find((l: any) => l.instructorId === ins);
  const warm = line.courses.find((c: any) => c.extra);
  expect(warm).toMatchObject({ name: '웜업', sessions: 2, instructorPay: 80000, revenue: 0, perSessionFee: 40000 });
  expect(line.instructorPay).toBeGreaterThanOrEqual(80000);
  expect(line.academyPay).toBe(line.revenue - line.courses.filter((c: any) => c.type === 'RATIO').reduce((n: number, c: any) => n + c.instructorPay - c.bonus, 0));
  expect((await req(`/extra-pays/${second.id}`, { method: 'DELETE' }, o)).status).toBe(200);
  const after = (await (await req('/settlement?month=2026-11', {}, o)).json()).find((l: any) => l.instructorId === ins);
  expect(after.courses.find((c: any) => c.extra)).toMatchObject({ sessions: 1, instructorPay: 40000 });
});

// 2026-11-26: 웜업은 출석 쿠폰이 되지 않고, 결제한 날 웜업 수업(대강이면 대강 강사)으로 정산된다
it('warm-up in a combo makes no pass and settles to that day warm-up class', async () => {
  const wd = 3; // 수요일 2026-11-25
  // 시드 시간표의 수요일 18:20 웜업 띠 수업
  const warmId = (db.prepare("select id from courses where weekday=? and note='WarmUp Training'").get(wd) as { id: string }).id;
  db.prepare("update courses set settlement_type='PER_SESSION', per_session_fee=50000 where id=?").run(warmId);
  const owner = (db.prepare('select instructor_id from courses where id=?').get(warmId) as { instructor_id: string }).instructor_id;
  const sub = (db.prepare('select id from instructors where id<>? limit 1').get(owner) as { id: string }).id;
  db.prepare("insert or ignore into products(id,name,course_id,pass_kind,count,period_days,price,drop_in) values('p_warm','WARM UP TRAINING',null,'COUNT',1,6,30000,1)").run();
  const warmProd = (db.prepare("select id from products where name='WARM UP TRAINING'").get() as { id: string }).id;
  const reg = db.prepare("select name, price from products where drop_in=0 and pass_kind='COUNT' and price>0 limit 1").get() as { name: string; price: number };
  const m = await member();
  // 키오스크 묶음 결제(웜업 조각 이름에 공백이 여러 개)를 회원에 연결
  await post('/payments/import', { rows: [{ source: 'KIOSK', externalId: 'w1', paidAt: '2026-11-25T09:15:00Z', amount: reg.price + 30000, productName: `${reg.name} + WARM UP     TRAINING`, payerPhone: '01012340000' }] });
  const pay = db.prepare("select id from payments where external_id='w1'").get() as { id: string };
  await post(`/payments/${pay.id}/assign`, { memberId: m });
  const passes = db.prepare('select product_id, price from passes where payment_id=?').all(pay.id) as { product_id: string; price: number }[];
  expect(passes).toHaveLength(1);
  expect(passes[0].product_id).not.toBe(warmProd);
  expect(passes[0].price).toBe(reg.price);
  // 웜업만 결제한 회원도 수강권 없음
  const single = await (await post('/payments', { amount: 30000, productName: 'WARM UP TRAINING', memberId: m, method: 'TRANSFER', paidAt: '2026-11-25T09:00:00Z' })).json();
  expect(db.prepare('select count(*) n from passes where payment_id=?').get(single.id)).toEqual({ n: 0 });
  // 정산: 두 웜업 몫이 수요일 웜업 수업으로, 1타임 5만
  const line = (await (await req('/settlement?month=2026-11', {}, o)).json()).find((l: any) => l.instructorId === owner);
  const warm = line.courses.find((c: any) => c.courseId === warmId);
  expect(warm).toMatchObject({ sessions: 1, heads: 2, instructorPay: 50000 });
  // 다른 강사가 한 날은 대강으로: 그 강사에게 간다
  expect((await post('/substitutions', { courseId: warmId, date: '2026-11-25', instructorId: sub })).status).toBe(200);
  const after = await (await req('/settlement?month=2026-11', {}, o)).json();
  expect(after.find((l: any) => l.instructorId === owner).courses.find((c: any) => c.courseId === warmId)).toBeUndefined();
  expect(after.find((l: any) => l.instructorId === sub).courses.find((c: any) => c.courseId === warmId && c.sub)).toMatchObject({ heads: 2, instructorPay: 50000 });
});

it('repairs old warm-up passes: unused ones go, prices of the rest follow the split', async () => {
  db.prepare("insert or ignore into products(id,name,course_id,pass_kind,count,period_days,price,drop_in) values('p_warm','WARM UP TRAINING',null,'COUNT',1,6,30000,1)").run();
  const warmProd = (db.prepare("select id from products where name='WARM UP TRAINING'").get() as { id: string }).id;
  const reg = db.prepare("select id, name, price from products where drop_in=0 and pass_kind='COUNT' and price>0 limit 1").get() as { id: string; name: string; price: number };
  const m = await member();
  await post('/payments/import', { rows: [{ source: 'KIOSK', externalId: 'w2', paidAt: '2026-11-25T09:15:00Z', amount: reg.price + 30000, productName: `${reg.name} + WARM UP TRAINING` }] });
  const pay = db.prepare("select id from payments where external_id='w2'").get() as { id: string };
  // 예전 방식으로 만든 것처럼: 웜업 수강권이 결제의 첫 수강권
  const { repairPasslessPasses } = await import('../src/domain/payments.js');
  db.prepare("insert into passes(id,member_id,product_id,course_id,kind,total_count,remaining,valid_from,valid_to,payment_id,price,created_at) values('old_w',?,?,null,'COUNT',1,1,'2026-11-25','2026-12-01',?,30000,'x')").run(m, warmProd, pay.id);
  db.prepare("insert into passes(id,member_id,product_id,course_id,kind,total_count,remaining,valid_from,valid_to,payment_id,price,created_at) values('old_r',?,?,null,'COUNT',1,1,'2026-11-25','2026-12-01',?,1,'x')").run(m, reg.id, pay.id);
  db.prepare("update payments set member_id=?, pass_id='old_w' where id=?").run(m, pay.id);
  expect(repairPasslessPasses(db)).toEqual({ removed: 1, kept: 0 });
  expect(db.prepare('select pass_id from payments where id=?').get(pay.id)).toEqual({ pass_id: 'old_r' });
  expect(db.prepare("select price from passes where id='old_r'").get()).toEqual({ price: reg.price });
  expect(repairPasslessPasses(db)).toEqual({ removed: 0, kept: 0 });
});

// 2026-11-26: 웜업 인원 인센티브(11명부터 1명당 15,000원)
it('head bonus adds per head from the N-th person on a per-session class', async () => {
  const warmId = (db.prepare("select id from courses where weekday=3 and note='WarmUp Training'").get() as { id: string }).id;
  const cur = await (await req('/bootstrap', {}, o)).json();
  const course = cur.courses.find((c: any) => c.id === warmId);
  // 타임제가 아니면 못 넣는다, 둘 중 하나만도 안 된다
  expect((await req(`/courses/${warmId}`, { method: 'PUT', body: { ...course, settlementType: 'RATIO', ratioInstructor: 50, bonusFrom: 11, bonusPerHead: 15000 } }, o)).status).toBe(200);
  expect(db.prepare('select bonus_from from courses where id=?').get(warmId)).toEqual({ bonus_from: null });
  expect((await req(`/courses/${warmId}`, { method: 'PUT', body: { ...course, settlementType: 'PER_SESSION', perSessionFee: 50000, bonusFrom: 11 } }, o)).status).toBe(400);
  const saved = await (await req(`/courses/${warmId}`, { method: 'PUT', body: { ...course, settlementType: 'PER_SESSION', perSessionFee: 50000, bonusFrom: 11, bonusPerHead: 15000 } }, o)).json();
  expect(saved).toMatchObject({ bonusFrom: 11, bonusPerHead: 15000 });
  db.prepare("insert or ignore into products(id,name,course_id,pass_kind,count,period_days,price,drop_in) values('p_warm','WARM UP TRAINING',null,'COUNT',1,6,30000,1)").run();
  const ins = db.prepare("insert into payments(id,source,paid_at,amount,payer_phone,product_name,status,created_at,drop_in,payer_name) values(?,'MANUAL',?,30000,'','WARM UP TRAINING','APPROVED','x',1,?)");
  for (let i = 0; i < 12; i++) ins.run(`h${i}`, '2026-11-25T09:00:00Z', `손님${i}`); // 수 12명
  for (let i = 0; i < 10; i++) ins.run(`g${i}`, '2026-11-18T09:00:00Z', `손님${i}`); // 수 10명
  const owner = (db.prepare('select instructor_id from courses where id=?').get(warmId) as { instructor_id: string }).instructor_id;
  const line = (await (await req('/settlement?month=2026-11', {}, o)).json()).find((l: any) => l.instructorId === owner);
  const w = line.courses.find((c: any) => c.courseId === warmId && !c.sub);
  // 50,000×2 + (12-10)×15,000
  expect(w).toMatchObject({ sessions: 2, headBonus: 30000, instructorPay: 130000, bonusFrom: 11, bonusPerHead: 15000 });
  expect(w.days.find((d: any) => d.date === '2026-11-25').over).toBe(2);
  expect(w.days.find((d: any) => d.date === '2026-11-18').over).toBeUndefined();
});
