import { Hono } from 'hono';
import { newId } from '../util.js';
import { audit } from '../audit.js';
import { settle, settlementDetail } from '../domain/settlement.js';
import { markDropInPayments } from '../domain/payments.js';
import { createStaff } from '../auth/sessions.js';
import { toInstructor, toCourse, toProduct } from '../serialize.js';
import { type AppEnv, type Deps, ownerOnly, body, bad, notFound, str, optStr, int, maxLen, LIMITS, clientIp } from './common.js';

const bool = (v: unknown) => v === undefined || typeof v === 'boolean';
const staffOut = (r: any) => ({ id: r.id, loginId: r.login_id, name: r.name, role: r.role, active: !!r.active, createdAt: r.created_at });

/** OWNER-only routes. Every PUT is an upsert: an existing row is merged with the given fields, a new id needs every required field. */
export function ownerRoutes(d: Deps) {
  const r = new Hono<AppEnv>(); const db = d.db;
  // Guard by path, not '*': a '*' middleware in a sub-app mounted at /api would also catch every other /api route.
  for (const path of ['/settlement', '/settlement/*', '/instructors/*', '/courses/*', '/products/*', '/tiers', '/staff', '/staff/*', '/audit', '/substitutions', '/substitutions/*', '/extra-pays', '/extra-pays/*', '/settings/*']) r.use(path, ownerOnly);

  r.get('/settlement', (c) => {
    const month = c.req.query('month') ?? '';
    if (!/^\d{4}-\d{2}$/.test(month)) return c.json({ error: 'BAD_MONTH' }, 400);
    audit(db, c.get('me').staffId, 'settlement.view', 'settlement', month, undefined, clientIp(c));
    return c.json(settle(db, month));
  });

  r.get('/settlement/detail', (c) => {
    const month = c.req.query('month') ?? '';
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return c.json({ error: 'BAD_MONTH' }, 400);
    // The detail (every member name and payment of the month) is only fetched for the Excel export.
    audit(db, c.get('me').staffId, 'settlement.export', 'settlement', month, undefined, clientIp(c));
    return c.json(settlementDetail(db, month));
  });

  // 그 달(KST) 승인 결제 합계(결제 화면에 있던 '이달 결제'를 정산 화면에서 달마다 본다)
  r.get('/settlement/payments-total', (c) => {
    const month = c.req.query('month') ?? '';
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return c.json({ error: 'BAD_MONTH' }, 400);
    const [y, m] = month.split('-').map(Number);
    const from = new Date(Date.UTC(y, m - 1, 1) - 9 * 3600000).toISOString(), to = new Date(Date.UTC(y, m, 1) - 9 * 3600000).toISOString();
    const r = db.prepare("select coalesce(sum(amount),0) total, count(*) n from payments where status='APPROVED' and paid_at >= ? and paid_at < ?").get(from, to) as { total: number; n: number };
    return c.json({ total: r.total, count: r.n });
  });

  // 대강: 그 날 그 수업을 다른 강사가 맡음. 정산에서 그 날 출석·원데이와 1타임이 대강 강사 몫이 된다
  r.get('/substitutions', (c) => {
    const month = c.req.query('month') ?? '';
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return c.json({ error: 'BAD_MONTH' }, 400);
    return c.json((db.prepare('select id, course_id, date, instructor_id, fee from substitutions where date like ? order by date').all(month + '-%') as any[]).map((x) => ({ id: x.id, courseId: x.course_id, date: x.date, instructorId: x.instructor_id, ...(x.fee != null ? { fee: x.fee } : {}) })));
  });
  r.post('/substitutions', async (c) => {
    const b = await body(c);
    if (!b || !str(b.courseId) || !str(b.instructorId) || (b.fee != null && !int(b.fee)) || typeof b.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(b.date) || Number.isNaN(Date.parse(b.date))) return bad(c);
    const course = db.prepare('select weekday, instructor_id from courses where id=?').get(b.courseId) as { weekday: number; instructor_id: string } | undefined;
    if (!course || !db.prepare('select 1 from instructors where id=?').get(b.instructorId)) return bad(c);
    if (new Date(b.date + 'T00:00:00Z').getUTCDay() !== course.weekday) return c.json({ error: 'WRONG_DAY' }, 409);
    if (course.instructor_id === b.instructorId) return c.json({ error: 'SAME_INSTRUCTOR' }, 409);
    const id = newId();
    db.transaction(() => {
      db.prepare('delete from substitutions where course_id=? and date=?').run(b.courseId, b.date);
      db.prepare('insert into substitutions(id,course_id,date,instructor_id,fee,created_by,created_at) values(?,?,?,?,?,?,?)').run(id, b.courseId, b.date, b.instructorId, b.fee ?? null, c.get('me').staffId, new Date().toISOString());
      audit(db, c.get('me').staffId, 'substitution.create', 'substitution', id, { courseId: b.courseId, date: b.date, instructorId: b.instructorId, fee: b.fee ?? null });
    })();
    return c.json({ id, courseId: b.courseId, date: b.date, instructorId: b.instructorId, ...(b.fee != null ? { fee: b.fee } : {}) });
  });
  r.delete('/substitutions/:id', (c) => {
    const id = c.req.param('id');
    if (!db.prepare('delete from substitutions where id=?').run(id).changes) return notFound(c);
    audit(db, c.get('me').staffId, 'substitution.delete', 'substitution', id);
    return c.json({ ok: true });
  });

  // 추가 페이: 시간표 수업이 아닌 일(웜업 등). 정산에서 그 강사에게 날짜별 금액을 더한다
  r.get('/extra-pays', (c) => {
    const month = c.req.query('month') ?? '';
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return c.json({ error: 'BAD_MONTH' }, 400);
    return c.json((db.prepare('select id, date, instructor_id, fee, memo from extra_pays where date like ? order by date, created_at').all(month + '-%') as any[]).map((x) => ({ id: x.id, date: x.date, instructorId: x.instructor_id, fee: x.fee, memo: x.memo ?? '' })));
  });
  r.post('/extra-pays', async (c) => {
    const b = await body(c);
    if (!b || !str(b.instructorId) || !int(b.fee) || b.fee <= 0 || (b.memo != null && (typeof b.memo !== 'string' || b.memo.length > 40)) || typeof b.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(b.date) || Number.isNaN(Date.parse(b.date))) return bad(c);
    if (!db.prepare('select 1 from instructors where id=?').get(b.instructorId)) return bad(c);
    const id = newId(); const memo = typeof b.memo === 'string' ? b.memo.trim() : '';
    db.transaction(() => {
      db.prepare('insert into extra_pays(id,date,instructor_id,fee,memo,created_by,created_at) values(?,?,?,?,?,?,?)').run(id, b.date, b.instructorId, b.fee, memo || null, c.get('me').staffId, new Date().toISOString());
      audit(db, c.get('me').staffId, 'extra_pay.create', 'extra_pay', id, { date: b.date, instructorId: b.instructorId, fee: b.fee, memo });
    })();
    return c.json({ id, date: b.date, instructorId: b.instructorId, fee: b.fee, memo });
  });
  r.delete('/extra-pays/:id', (c) => {
    const id = c.req.param('id');
    if (!db.prepare('delete from extra_pays where id=?').run(id).changes) return notFound(c);
    audit(db, c.get('me').staffId, 'extra_pay.delete', 'extra_pay', id);
    return c.json({ ok: true });
  });

  // 강사 특전 할인율(%). 현금·이체 결제 넣기에서 '강사 할인' 을 누르면 이 비율만큼 깎는다
  r.put('/settings/instructor-discount', async (c) => {
    const b = await body(c);
    if (!b || !int(b.pct, 1) || b.pct > 100) return bad(c);
    db.prepare("insert into settings(key,value) values('instructor_discount_pct',?) on conflict(key) do update set value=excluded.value").run(String(b.pct));
    audit(db, c.get('me').staffId, 'settings.instructor_discount', 'settings', null, { pct: b.pct });
    return c.json({ pct: b.pct });
  });

  // 수업 지우기: 목록·시간표·고르기에서 사라진다. 지난 출석·원데이·정산 기록은 남는다(그래서 실제로 지우지 않고 표시만).
  // 이 수업에 묶인 사용 중 상품이 있으면 409 PRODUCTS(상품을 먼저 다른 수업으로 바꾸거나 쉬게 한다)
  r.delete('/courses/:id', (c) => {
    const id = c.req.param('id');
    const cur = db.prepare('select deleted_at from courses where id=?').get(id) as { deleted_at: string | null } | undefined;
    if (!cur) return notFound(c);
    const products = (db.prepare('select count(*) n from products where course_id=? and active=1').get(id) as { n: number }).n;
    if (products > 0) return c.json({ error: 'PRODUCTS', count: products }, 409);
    db.transaction(() => {
      db.prepare('update courses set active=0, deleted_at=coalesce(deleted_at, ?) where id=?').run(new Date().toISOString(), id);
      audit(db, c.get('me').staffId, 'course.delete', 'course', id);
    })();
    return c.json({ ok: true });
  });

  r.put('/instructors/:id', async (c) => {
    const b = await body(c); const id = c.req.param('id');
    if (!b) return bad(c);
    const cur = db.prepare('select * from instructors where id=?').get(id) as any;
    const v = { ...(cur ? toInstructor(cur, 'OWNER') : {}), ...b } as any;
    if (!str(v.name) || !maxLen(v.name, LIMITS.name) || !optStr(v.crew) || !maxLen(v.crew, LIMITS.name) || !['RATIO', 'PER_SESSION'].includes(v.settlementType) || !int(v.ratioInstructor ?? 50) || v.ratioInstructor > 100 || !int(v.perSessionFee ?? 0) || !bool(v.active)) return bad(c);
    db.prepare('insert into instructors(id,name,genres,settlement_type,ratio_instructor,per_session_fee,active) values(?,?,?,?,?,?,?) on conflict(id) do update set name=excluded.name, genres=excluded.genres, settlement_type=excluded.settlement_type, ratio_instructor=excluded.ratio_instructor, per_session_fee=excluded.per_session_fee, active=excluded.active')
      .run(id, v.name.trim(), v.crew ?? '', v.settlementType, v.ratioInstructor ?? 50, v.perSessionFee ?? 0, v.active === false ? 0 : 1);
    audit(db, c.get('me').staffId, cur ? 'instructor.update' : 'instructor.create', 'instructor', id, b);
    return c.json(toInstructor(db.prepare('select * from instructors where id=?').get(id), 'OWNER'));
  });

  r.put('/courses/:id', async (c) => {
    const b = await body(c); const id = c.req.param('id');
    if (!b) return bad(c);
    const cur = db.prepare('select * from courses where id=?').get(id) as any;
    const v = { ...(cur ? toCourse(cur, 'OWNER') : {}), ...b } as any;
    const wd = Array.isArray(v.weekday) ? v.weekday : [v.weekday];
    if (!str(v.name) || !maxLen(v.name, LIMITS.name) || !str(v.instructorId) || !['GENERAL', 'PRO'].includes(v.kind) || !['HUB', 'LAB'].includes(v.hall) || !optStr(v.level) || !optStr(v.note) || !maxLen(v.note, LIMITS.memo)
      || wd.length !== 1 || !int(wd[0]) || wd[0] > 6 || typeof v.startTime !== 'string' || !/^\d{2}:\d{2}$/.test(v.startTime) || !int(v.durationMin, 1) || !bool(v.active)) return bad(c);
    // 정산 조건: 셋 다 null 이면 강사 기본. 방식을 정하면 그 방식의 값이 있어야 한다
    const st = v.settlementType ?? null, ratio = v.ratioInstructor ?? null, fee = v.perSessionFee ?? null;
    if (st !== null && !['RATIO', 'PER_SESSION'].includes(st)) return bad(c);
    if (st === 'RATIO' && (!int(ratio) || ratio > 100)) return bad(c);
    if (st === 'PER_SESSION' && !int(fee)) return bad(c);
    // 인원 인센티브: 둘 다 비우거나 둘 다(타임제만). N명부터 1명당 금액
    const bf = st === 'PER_SESSION' ? v.bonusFrom ?? null : null, bp = st === 'PER_SESSION' ? v.bonusPerHead ?? null : null;
    if ((bf === null) !== (bp === null) || (bf !== null && (!int(bf, 2) || bf > 999 || !int(bp) || bp > 10000000))) return bad(c);
    if (!db.prepare('select 1 from instructors where id=?').get(v.instructorId)) return bad(c);
    db.prepare('insert into courses(id,hall,name,instructor_id,kind,level,note,weekday,start_time,duration_min,active,settlement_type,ratio_instructor,per_session_fee,bonus_from,bonus_per_head) values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) on conflict(id) do update set hall=excluded.hall, name=excluded.name, instructor_id=excluded.instructor_id, kind=excluded.kind, level=excluded.level, note=excluded.note, weekday=excluded.weekday, start_time=excluded.start_time, duration_min=excluded.duration_min, active=excluded.active, settlement_type=excluded.settlement_type, ratio_instructor=excluded.ratio_instructor, per_session_fee=excluded.per_session_fee, bonus_from=excluded.bonus_from, bonus_per_head=excluded.bonus_per_head')
      .run(id, v.hall, v.name.trim(), v.instructorId, v.kind, v.level ?? null, v.note ?? null, wd[0], v.startTime, v.durationMin, v.active === false ? 0 : 1, st, st === 'RATIO' ? ratio : null, st === 'PER_SESSION' ? fee : null, bf, bp);
    audit(db, c.get('me').staffId, cur ? 'course.update' : 'course.create', 'course', id, b);
    return c.json(toCourse(db.prepare('select * from courses where id=?').get(id), 'OWNER'));
  });

  r.put('/products/:id', async (c) => {
    const b = await body(c); const id = c.req.param('id');
    if (!b) return bad(c);
    const cur = db.prepare('select * from products where id=?').get(id) as any;
    const v = { ...(cur ? toProduct(cur, 'OWNER') : {}), ...b } as any;
    if (!str(v.name) || !maxLen(v.name, LIMITS.productName) || !optStr(v.courseId) || !['COUNT', 'PERIOD'].includes(v.passKind) || !int(v.count, 1) || !int(v.periodDays, 1) || !int(v.price) || !bool(v.active) || !bool(v.dropIn)) return bad(c);
    if (v.attendBonus != null && !int(v.attendBonus)) return bad(c);
    if (v.courseId && !db.prepare('select 1 from courses where id=?').get(v.courseId)) return bad(c);
    const clash = db.prepare('select id from products where name=? and id<>?').get(v.name.trim(), id);
    if (clash) return c.json({ error: 'DUPLICATE_NAME' }, 409);
    // Ruling 7: an owner saving any product means prices are no longer the seeded samples.
    db.transaction(() => {
      db.prepare('insert into products(id,name,course_id,pass_kind,count,period_days,price,active,drop_in,attend_bonus) values(?,?,?,?,?,?,?,?,?,?) on conflict(id) do update set name=excluded.name, course_id=excluded.course_id, pass_kind=excluded.pass_kind, count=excluded.count, period_days=excluded.period_days, price=excluded.price, active=excluded.active, drop_in=excluded.drop_in, attend_bonus=excluded.attend_bonus')
        .run(id, v.name.trim(), v.courseId ?? null, v.passKind, v.count, v.periodDays, v.price, v.active === false ? 0 : 1, v.dropIn === true ? 1 : 0, v.attendBonus || null);
      db.prepare("insert into settings(key,value) values('needs_real_prices','0') on conflict(key) do update set value='0'").run();
      audit(db, c.get('me').staffId, cur ? 'product.update' : 'product.create', 'product', id, b);
      if (v.dropIn === true && v.active !== false) markDropInPayments(db, id);
    })();
    return c.json(toProduct(db.prepare('select * from products where id=?').get(id), 'OWNER'));
  });

  // Replaces the whole tier ladder. Accepts [{name,minCount}] or {tiers:[...]}; stored in ascending minCount order.
  r.put('/tiers', async (c) => {
    const raw = await c.req.json().catch(() => null);
    const list = Array.isArray(raw) ? raw : raw?.tiers;
    if (!Array.isArray(list) || !list.length || !list.every((t: any) => t && str(t.name) && int(t.minCount) && (t.minYears == null || (int(t.minYears) && t.minYears <= 50)))) return bad(c);
    const sorted = [...list].sort((a: any, b: any) => a.minCount - b.minCount);
    if (sorted[0].minCount !== 0 || new Set(sorted.map((t: any) => t.minCount)).size !== sorted.length) return bad(c);
    db.transaction(() => {
      db.prepare('delete from tiers').run();
      const ins = db.prepare('insert into tiers(id,name,min_count,sort,min_years) values(?,?,?,?,?)');
      sorted.forEach((t: any, i: number) => ins.run(newId(), t.name.trim(), t.minCount, i, t.minYears || null));
      audit(db, c.get('me').staffId, 'tiers.replace', 'tiers', null, sorted);
    })();
    return c.json(sorted.map((t: any) => ({ name: t.name.trim(), minCount: t.minCount, ...(t.minYears ? { minYears: t.minYears } : {}) })));
  });

  // 접속기록 조회. from/to = KST 날짜(YYYY-MM-DD, 포함), 최신순. 다음 쪽은 응답의 next 를 before 로 넘긴다.
  r.get('/audit', (c) => {
    const q = (k: string) => c.req.query(k) ?? '';
    const day = /^\d{4}-\d{2}-\d{2}$/;
    const from = q('from'), to = q('to'), before = q('before');
    const limit = Math.min(Math.max(Number(q('limit') || 100) || 100, 1), 500);
    if ((from && !day.test(from)) || (to && !day.test(to)) || (before && !/^[^|]{1,40}\|[A-Za-z0-9]{1,20}$/.test(before))) return bad(c);
    const kstStart = (d: string) => new Date(`${d}T00:00:00+09:00`).toISOString();
    const where: string[] = []; const args: unknown[] = [];
    if (from) { where.push('a.at >= ?'); args.push(kstStart(from)); }
    if (to) { where.push('a.at < ?'); args.push(new Date(new Date(`${to}T00:00:00+09:00`).getTime() + 86400000).toISOString()); }
    if (before) { const [at, id] = before.split('|'); where.push('(a.at < ? or (a.at = ? and a.id < ?))'); args.push(at, at, id); }
    const rows = db.prepare(`select a.*, s.login_id, s.name staff_name from audit_log a left join staff s on s.id = a.staff_id ${where.length ? 'where ' + where.join(' and ') : ''} order by a.at desc, a.id desc limit ?`).all(...args, limit + 1) as any[];
    const items = rows.slice(0, limit).map((a) => ({ id: a.id, at: a.at, staffId: a.staff_id ?? undefined, loginId: a.login_id ?? undefined, staffName: a.staff_name ?? undefined, action: a.action, entity: a.entity, entityId: a.entity_id ?? undefined, ip: a.ip ?? undefined, detail: a.detail_json ? JSON.parse(a.detail_json) : undefined }));
    const last = items[items.length - 1];
    return c.json({ items, next: rows.length > limit && last ? `${last.at}|${last.id}` : null });
  });

  r.get('/staff', (c) => c.json(db.prepare('select * from staff order by created_at').all().map(staffOut)));

  r.post('/staff', async (c) => {
    const b = await body(c);
    if (!b || !str(b.loginId) || !maxLen(b.loginId, LIMITS.loginId) || !str(b.name) || !maxLen(b.name, LIMITS.name) || typeof b.password !== 'string' || b.password.length > LIMITS.password || (b.role !== undefined && b.role !== 'DESK' && b.role !== 'OWNER')) return bad(c);
    if (b.password.length < 8) return c.json({ error: 'WEAK_PASSWORD' }, 400);
    if (db.prepare('select 1 from staff where login_id=?').get(b.loginId.trim())) return c.json({ error: 'LOGIN_TAKEN' }, 409);
    const id = await createStaff(db, { loginId: b.loginId.trim(), name: b.name.trim(), role: b.role ?? 'DESK', password: b.password });
    audit(db, c.get('me').staffId, 'staff.create', 'staff', id, { role: b.role ?? 'DESK' });
    return c.json(staffOut(db.prepare('select * from staff where id=?').get(id)));
  });

  // Rename or (de)activate. Deactivation also drops that account's sessions; an owner cannot deactivate themself.
  r.patch('/staff/:id', async (c) => {
    const b = await body(c); const id = c.req.param('id');
    if (!b || (b.name !== undefined && !(str(b.name) && maxLen(b.name, LIMITS.name))) || !bool(b.active)) return bad(c);
    const cur = db.prepare('select * from staff where id=?').get(id) as any;
    if (!cur) return notFound(c);
    if (b.active === false && id === c.get('me').staffId) return c.json({ error: 'SELF' }, 400);
    db.transaction(() => {
      db.prepare('update staff set name=?, active=? where id=?').run(b.name !== undefined ? b.name.trim() : cur.name, b.active === undefined ? cur.active : b.active ? 1 : 0, id);
      if (b.active === false) db.prepare('delete from sessions where staff_id=?').run(id);
      audit(db, c.get('me').staffId, 'staff.update', 'staff', id, { name: b.name, active: b.active });
    })();
    return c.json(staffOut(db.prepare('select * from staff where id=?').get(id)));
  });
  return r;
}
