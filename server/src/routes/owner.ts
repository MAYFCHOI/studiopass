import { Hono } from 'hono';
import { newId } from '../util.js';
import { audit } from '../audit.js';
import { settle, settlementDetail } from '../domain/settlement.js';
import { createStaff } from '../auth/sessions.js';
import { toInstructor, toCourse, toProduct } from '../serialize.js';
import { type AppEnv, type Deps, ownerOnly, body, bad, notFound, str, optStr, int, maxLen, LIMITS } from './common.js';

const bool = (v: unknown) => v === undefined || typeof v === 'boolean';
const staffOut = (r: any) => ({ id: r.id, loginId: r.login_id, name: r.name, role: r.role, active: !!r.active, createdAt: r.created_at });

/** OWNER-only routes. Every PUT is an upsert: an existing row is merged with the given fields, a new id needs every required field. */
export function ownerRoutes(d: Deps) {
  const r = new Hono<AppEnv>(); const db = d.db;
  // Guard by path, not '*': a '*' middleware in a sub-app mounted at /api would also catch every other /api route.
  for (const path of ['/settlement', '/settlement/*', '/instructors/*', '/courses/*', '/products/*', '/tiers', '/staff', '/staff/*']) r.use(path, ownerOnly);

  r.get('/settlement', (c) => {
    const month = c.req.query('month') ?? '';
    if (!/^\d{4}-\d{2}$/.test(month)) return c.json({ error: 'BAD_MONTH' }, 400);
    return c.json(settle(db, month));
  });

  r.get('/settlement/detail', (c) => {
    const month = c.req.query('month') ?? '';
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return c.json({ error: 'BAD_MONTH' }, 400);
    return c.json(settlementDetail(db, month));
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
    const v = { ...(cur ? toCourse(cur) : {}), ...b } as any;
    const wd = Array.isArray(v.weekday) ? v.weekday : [v.weekday];
    if (!str(v.name) || !maxLen(v.name, LIMITS.name) || !str(v.instructorId) || !['GENERAL', 'PRO'].includes(v.kind) || !['HUB', 'LAB'].includes(v.hall) || !optStr(v.level) || !optStr(v.note) || !maxLen(v.note, LIMITS.memo)
      || wd.length !== 1 || !int(wd[0]) || wd[0] > 6 || typeof v.startTime !== 'string' || !/^\d{2}:\d{2}$/.test(v.startTime) || !int(v.durationMin, 1) || !bool(v.active)) return bad(c);
    if (!db.prepare('select 1 from instructors where id=?').get(v.instructorId)) return bad(c);
    db.prepare('insert into courses(id,hall,name,instructor_id,kind,level,note,weekday,start_time,duration_min,active) values(?,?,?,?,?,?,?,?,?,?,?) on conflict(id) do update set hall=excluded.hall, name=excluded.name, instructor_id=excluded.instructor_id, kind=excluded.kind, level=excluded.level, note=excluded.note, weekday=excluded.weekday, start_time=excluded.start_time, duration_min=excluded.duration_min, active=excluded.active')
      .run(id, v.hall, v.name.trim(), v.instructorId, v.kind, v.level ?? null, v.note ?? null, wd[0], v.startTime, v.durationMin, v.active === false ? 0 : 1);
    audit(db, c.get('me').staffId, cur ? 'course.update' : 'course.create', 'course', id, b);
    return c.json(toCourse(db.prepare('select * from courses where id=?').get(id)));
  });

  r.put('/products/:id', async (c) => {
    const b = await body(c); const id = c.req.param('id');
    if (!b) return bad(c);
    const cur = db.prepare('select * from products where id=?').get(id) as any;
    const v = { ...(cur ? toProduct(cur, 'OWNER') : {}), ...b } as any;
    if (!str(v.name) || !maxLen(v.name, LIMITS.productName) || !optStr(v.courseId) || !['COUNT', 'PERIOD'].includes(v.passKind) || !int(v.count, 1) || !int(v.periodDays, 1) || !int(v.price) || !bool(v.active)) return bad(c);
    if (v.courseId && !db.prepare('select 1 from courses where id=?').get(v.courseId)) return bad(c);
    const clash = db.prepare('select id from products where name=? and id<>?').get(v.name.trim(), id);
    if (clash) return c.json({ error: 'DUPLICATE_NAME' }, 409);
    // Ruling 7: an owner saving any product means prices are no longer the seeded samples.
    db.transaction(() => {
      db.prepare('insert into products(id,name,course_id,pass_kind,count,period_days,price,active) values(?,?,?,?,?,?,?,?) on conflict(id) do update set name=excluded.name, course_id=excluded.course_id, pass_kind=excluded.pass_kind, count=excluded.count, period_days=excluded.period_days, price=excluded.price, active=excluded.active')
        .run(id, v.name.trim(), v.courseId ?? null, v.passKind, v.count, v.periodDays, v.price, v.active === false ? 0 : 1);
      db.prepare("insert into settings(key,value) values('needs_real_prices','0') on conflict(key) do update set value='0'").run();
      audit(db, c.get('me').staffId, cur ? 'product.update' : 'product.create', 'product', id, b);
    })();
    return c.json(toProduct(db.prepare('select * from products where id=?').get(id), 'OWNER'));
  });

  // Replaces the whole tier ladder. Accepts [{name,minCount}] or {tiers:[...]}; stored in ascending minCount order.
  r.put('/tiers', async (c) => {
    const raw = await c.req.json().catch(() => null);
    const list = Array.isArray(raw) ? raw : raw?.tiers;
    if (!Array.isArray(list) || !list.length || !list.every((t: any) => t && str(t.name) && int(t.minCount))) return bad(c);
    const sorted = [...list].sort((a: any, b: any) => a.minCount - b.minCount);
    if (sorted[0].minCount !== 0 || new Set(sorted.map((t: any) => t.minCount)).size !== sorted.length) return bad(c);
    db.transaction(() => {
      db.prepare('delete from tiers').run();
      const ins = db.prepare('insert into tiers(id,name,min_count,sort) values(?,?,?,?)');
      sorted.forEach((t: any, i: number) => ins.run(newId(), t.name.trim(), t.minCount, i));
      audit(db, c.get('me').staffId, 'tiers.replace', 'tiers', null, sorted);
    })();
    return c.json(sorted.map((t: any) => ({ name: t.name.trim(), minCount: t.minCount })));
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
