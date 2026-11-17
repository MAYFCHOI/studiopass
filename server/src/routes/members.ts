import { Hono } from 'hono';
import type { Db } from '../db.js';
import { newId, nowIso, kstDate, normalizePhone } from '../util.js';
import { audit } from '../audit.js';
import { assignPayment } from '../domain/payments.js';
import { attend, backfillAttendance, cancelAttendance } from '../domain/attendance.js';
import { tierFor } from '../domain/tiers.js';
import { parseQr } from '../qr.js';
import { issueLink } from '../links.js';
import { toMember, toAttendance, toPayment, toPass } from '../serialize.js';
import { idemKey, idemGet, idemPut } from '../idempotency.js';
import { alimtalkOn, passNotifier, sendLinkAlimtalk } from '../notify/link.js';
import { type AppEnv, type Deps, clock, body, bad, notFound, str, optStr, maxLen, LIMITS, ownerOnly, clientIp } from './common.js';

export const ERASED_NAME = '삭제된 회원';
const erased = (c: any) => c.json({ error: 'ERASED' }, 409);

const memberOut = (db: Db, id: string) => {
  const m = db.prepare('select * from members where id=?').get(id) as any;
  if (!m) return null;
  const t = tierFor(db, id);
  return toMember(m, { name: t.name, level: t.level, count: t.count, ...(t.manual ? { manual: true } : {}) });
};

export function memberRoutes(d: Deps) {
  const r = new Hono<AppEnv>(); const db = d.db; const onPass = passNotifier(d);
  /** 같은 번호를 쓰는 다른 회원 수(자동 연결이 안 되는 이유가 된다). */
  const samePhone = (id: string, phone: string) => (phone ? (db.prepare('select count(*) n from members where phone=? and id<>? and erased_at is null').get(phone, id) as { n: number }).n : 0);
  /** 전화번호가 생기거나 바뀌면 그 번호로 기다리던 결제를 연결한다(번호가 한 사람 것일 때만, 가입 때와 같은 규칙). */
  const pickUpOpen = (id: string, phone: string, staffId: string) => {
    if (!phone || samePhone(id, phone) > 0) return 0;
    const open = db.prepare("select id from payments where payer_phone=? and member_id is null and pass_id is null and status='APPROVED' order by paid_at").all(phone) as { id: string }[];
    for (const p of open) assignPayment(db, p.id, id, staffId, onPass);
    return open.length;
  };

  r.post('/members', async (c) => {
    const b = await body(c);
    if (!b || !str(b.name) || !maxLen(b.name, LIMITS.name) || !optStr(b.phone) || !maxLen(b.phone, 30) || !optStr(b.memo) || !maxLen(b.memo, LIMITS.memo)) return bad(c);
    const staffId = c.get('me').staffId; const phone = normalizePhone(b.phone);
    const year = kstDate(clock(d)).slice(0, 4);
    // 같은 Idempotency-Key 로 다시 오면 처음 만든 회원을 그대로 돌려준다(두 번 누름에 회원이 둘 생기지 않게).
    const key = idemKey(c); const hit = idemGet(db, key, staffId, 'members');
    if (hit) return c.json(hit.body as object, hit.status as 200);
    const { id, assigned } = db.transaction(() => {
      const last = db.prepare("select member_no from members where member_no like ? order by member_no desc limit 1").get(year + '-%') as { member_no: string } | undefined;
      const seq = (last ? Number(last.member_no.slice(5)) : 0) + 1;
      const id = newId();
      db.prepare('insert into members(id,member_no,name,phone,memo,created_at) values(?,?,?,?,?,?)').run(id, `${year}-${String(seq).padStart(4, '0')}`, b.name.trim(), phone, b.memo ?? null, nowIso());
      audit(db, staffId, 'member.create', 'member', id);
      let assigned = 0;
      if (phone && samePhone(id, phone) === 0) { // 번호를 다른 회원도 쓰면 자동 연결하지 않는다(PATCH 와 같은 규칙)
        const open = db.prepare("select id from payments where payer_phone=? and member_id is null and pass_id is null and status='APPROVED' order by paid_at").all(phone) as { id: string }[];
        for (const p of open) { assignPayment(db, p.id, id, staffId, onPass); assigned++; }
      }
      idemPut(db, key, staffId, 'members', 200, { ...memberOut(db, id)!, assigned, samePhone: samePhone(id, phone) });
      return { id, assigned };
    })();
    return c.json({ ...memberOut(db, id)!, assigned, samePhone: samePhone(id, phone) });
  });

  r.patch('/members/:id', async (c) => {
    const b = await body(c); const id = c.req.param('id');
    if (!b || (b.name !== undefined && !(str(b.name) && maxLen(b.name, LIMITS.name))) || !optStr(b.phone) || !maxLen(b.phone, 30) || !optStr(b.memo) || !maxLen(b.memo, LIMITS.memo)
      || (b.since !== undefined && b.since !== null && !(typeof b.since === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.since)))) return bad(c);
    // 처음 온 날은 등급(기간 조건)을 바꾸므로 원장만
    if (b.since !== undefined && c.get('me').role !== 'OWNER') return c.json({ error: 'OWNER_ONLY' }, 403);
    const m = db.prepare('select * from members where id=?').get(id) as any;
    if (!m) return notFound(c);
    if (m.erased_at) return erased(c);
    const phone = b.phone !== undefined ? normalizePhone(b.phone) : m.phone;
    const assigned = db.transaction(() => {
      db.prepare('update members set name=?, phone=?, memo=?, since=? where id=?').run(b.name !== undefined ? b.name.trim() : m.name, phone, b.memo !== undefined ? b.memo : m.memo, b.since !== undefined ? b.since : m.since, id);
      audit(db, c.get('me').staffId, 'member.update', 'member', id, { fields: Object.keys(b).filter((k) => ['name', 'phone', 'memo', 'since'].includes(k)) });
      return phone !== m.phone ? pickUpOpen(id, phone, c.get('me').staffId) : 0;
    })();
    return c.json({ ...memberOut(db, id)!, assigned, samePhone: samePhone(id, phone) });
  });

  // 개인정보 파기: 이름·전화·메모와 회원 링크, 이 회원 결제의 결제자 이름·전화를 지운다.
  // 출석·수강권·결제 금액은 남기므로 정산 합계는 바뀌지 않는다. 되돌릴 수 없다.
  r.post('/members/:id/erase', ownerOnly, (c) => {
    const id = c.req.param('id'); const staffId = c.get('me').staffId;
    const m = db.prepare('select erased_at from members where id=?').get(id) as { erased_at: string | null } | undefined;
    if (!m) return notFound(c);
    if (m.erased_at) return erased(c);
    db.transaction(() => {
      db.prepare("update members set name=?, phone='', memo=null, erased_at=? where id=?").run(ERASED_NAME, nowIso(), id);
      db.prepare('delete from member_links where member_id=?').run(id);
      const n = db.prepare("update payments set payer_name=null, payer_phone='' where member_id=?").run(id).changes;
      audit(db, staffId, 'member.erase', 'member', id, { payments: n }, clientIp(c));
    })();
    return c.json(memberOut(db, id));
  });

  // 회원 상세의 전체 기록(bootstrap 은 최근 62일만 준다). 금액은 원장에게만.
  r.get('/members/:id/history', (c) => {
    const id = c.req.param('id'); const role = c.get('me').role;
    if (!db.prepare('select 1 from members where id=?').get(id)) return notFound(c);
    return c.json({
      attendances: db.prepare('select * from attendances where member_id=? order by attended_at desc limit 2000').all(id).map(toAttendance),
      payments: db.prepare('select * from payments where member_id=? order by paid_at desc limit 1000').all(id).map((x) => toPayment(x, role)),
      passes: db.prepare('select * from passes where member_id=? order by created_at').all(id).map((x) => toPass(x, role)),
    });
  });

  r.post('/members/:id/link', (c) => {
    const id = c.req.param('id');
    const lm = db.prepare('select erased_at from members where id=?').get(id) as { erased_at: string | null } | undefined;
    if (!lm) return notFound(c);
    if (lm.erased_at) return erased(c);
    const token = issueLink(db, id, c.get('me').staffId);
    const origin = d.allowedOrigin ?? c.req.header('origin') ?? new URL(c.req.url).origin;
    return c.json({ url: `${origin}/m/${token}` });
  });

  /** 유효기간 연장: 수강권당 1번, 1~90일. 데스크도 한다. 원장은 잘못 넣은 연장을 되돌릴 수 있다(그 뒤 다시 1번 가능). */
  const passOut = (c: any, id: string) => toPass(db.prepare('select * from passes where id=?').get(id), c.get('me').role);
  r.post('/passes/:id/extend', async (c) => {
    const id = c.req.param('id'); const b = await body(c);
    const days = b?.days;
    if (!Number.isInteger(days) || days < 1 || days > 90) return bad(c);
    const p = db.prepare('select p.*, m.erased_at from passes p join members m on m.id=p.member_id where p.id=?').get(id) as any;
    if (!p) return notFound(c);
    if (p.erased_at) return erased(c);
    if (p.extended_at) return c.json({ error: 'ALREADY_EXTENDED' }, 409);
    const to = new Date(p.valid_to + 'T00:00:00Z'); to.setUTCDate(to.getUTCDate() + days);
    const validTo = to.toISOString().slice(0, 10);
    db.prepare('update passes set valid_to=?, extended_days=?, extended_at=?, extended_by=? where id=?').run(validTo, days, nowIso(), c.get('me').staffId, id);
    audit(db, c.get('me').staffId, 'pass.extend', 'pass', id, { days, from: p.valid_to, to: validTo });
    return c.json(passOut(c, id));
  });
  r.post('/passes/:id/extend/undo', ownerOnly, (c) => {
    const id = c.req.param('id');
    const p = db.prepare('select * from passes where id=?').get(id) as any;
    if (!p) return notFound(c);
    if (!p.extended_at) return c.json({ error: 'NOT_EXTENDED' }, 409);
    const to = new Date(p.valid_to + 'T00:00:00Z'); to.setUTCDate(to.getUTCDate() - p.extended_days);
    const validTo = to.toISOString().slice(0, 10);
    db.prepare('update passes set valid_to=?, extended_days=null, extended_at=null, extended_by=null where id=?').run(validTo, id);
    audit(db, c.get('me').staffId, 'pass.extend.undo', 'pass', id, { from: p.valid_to, to: validTo });
    return c.json(passOut(c, id));
  });

  /** 시작일 바꾸기: 입금일과 실제 시작일이 다를 때. 끝나는 날도 같은 날수만큼 옮긴다(연장 횟수는 쓰지 않는다).
   *  지금 시작일에서 앞뒤 60일 안, 이미 출석한 날보다 뒤로는 못 옮긴다. 데스크도 한다. */
  r.post('/passes/:id/start', async (c) => {
    const id = c.req.param('id'); const b = await body(c);
    const from = b?.from;
    if (typeof from !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(from) || Number.isNaN(Date.parse(from + 'T00:00:00Z'))) return bad(c);
    const p = db.prepare('select p.*, m.erased_at from passes p join members m on m.id=p.member_id where p.id=?').get(id) as any;
    if (!p) return notFound(c);
    if (p.erased_at) return erased(c);
    const day = 86400000;
    const shift = Math.round((Date.parse(from + 'T00:00:00Z') - Date.parse(p.valid_from + 'T00:00:00Z')) / day);
    if (Math.abs(shift) > 60) return bad(c);
    if (shift === 0) return c.json(passOut(c, id));
    const first = db.prepare('select min(attended_on) d from attendances where pass_id=? and cancelled_at is null').get(id) as { d: string | null };
    if (first.d && first.d < from) return c.json({ error: 'ATTENDED_BEFORE', first: first.d }, 409);
    const validTo = new Date(Date.parse(p.valid_to + 'T00:00:00Z') + shift * day).toISOString().slice(0, 10);
    db.prepare('update passes set valid_from=?, valid_to=? where id=?').run(from, validTo, id);
    audit(db, c.get('me').staffId, 'pass.start', 'pass', id, { from: p.valid_from, to: from, validTo: { from: p.valid_to, to: validTo } });
    return c.json(passOut(c, id));
  });

  /** 앱을 쓰기 전에 쓴 횟수 맞추기: 남은 횟수를 직접 정한다. 출석 기록은 만들지 않으니 정산·등급은 그대로다.
   *  앱에서 쓴 횟수(취소 안 된 출석)보다 많이 남길 수는 없다. 다시 맞추면 덮어쓴다. 데스크도 한다. */
  r.post('/passes/:id/adjust', async (c) => {
    const id = c.req.param('id'); const b = await body(c);
    const remaining = b?.remaining;
    if (!Number.isInteger(remaining) || remaining < 0) return bad(c);
    const p = db.prepare('select p.*, m.erased_at from passes p join members m on m.id=p.member_id where p.id=?').get(id) as any;
    if (!p) return notFound(c);
    if (p.erased_at) return erased(c);
    if (p.kind !== 'COUNT') return bad(c);
    const inApp = (db.prepare('select count(*) n from attendances where pass_id=? and cancelled_at is null').get(id) as { n: number }).n;
    const max = p.total_count - inApp;
    if (remaining > max) return c.json({ error: 'TOO_MANY', max }, 409);
    const used = max - remaining;
    db.prepare('update passes set remaining=?, adjusted_used=?, adjusted_at=? where id=?').run(remaining, used || null, used ? nowIso() : null, id);
    audit(db, c.get('me').staffId, 'pass.adjust', 'pass', id, { from: p.remaining, to: remaining, offline: used });
    return c.json(passOut(c, id));
  });

  /** 원장만: 등급 직접 올리기. level 은 1부터(등급 표 순서), null 이면 출석 기준으로 돌아간다. 출석으로 더 오르면 그 등급이 된다. */
  r.post('/members/:id/tier', ownerOnly, async (c) => {
    const id = c.req.param('id'); const b = await body(c);
    const level = b?.level ?? null;
    const n = (db.prepare('select count(*) n from tiers').get() as { n: number }).n;
    if (level !== null && (!Number.isInteger(level) || level < 1 || level > n)) return bad(c);
    const m = db.prepare('select erased_at, tier_floor from members where id=?').get(id) as { erased_at: string | null; tier_floor: number | null } | undefined;
    if (!m) return notFound(c);
    if (m.erased_at) return erased(c);
    db.prepare('update members set tier_floor=? where id=?').run(level, id);
    audit(db, c.get('me').staffId, 'member.tier', 'member', id, { from: m.tier_floor, to: level });
    return c.json(memberOut(db, id));
  });

  // channel 없음/SMS_LINK: 화면이 문자 앱을 연 기록만 남긴다. ALIMTALK: 서버가 새 링크를 발급해 바로 보낸다.
  r.post('/members/:id/messages', async (c) => {
    const id = c.req.param('id');
    const b = (await body(c)) ?? {};
    const channel = b.channel ?? 'SMS_LINK';
    if (channel !== 'SMS_LINK' && channel !== 'ALIMTALK') return bad(c);
    const mm = db.prepare('select erased_at from members where id=?').get(id) as { erased_at: string | null } | undefined;
    if (!mm) return notFound(c);
    if (mm.erased_at) return erased(c);
    if (channel === 'ALIMTALK') {
      if (!alimtalkOn(d)) return c.json({ error: 'ALIMTALK_OFF' }, 409);
      const r = await sendLinkAlimtalk(d, id, c.get('me').staffId);
      return c.json('skipped' in r ? { ok: false, error: 'NO_PHONE' } : r.ok ? { ok: true } : { ok: false, error: 'SEND_FAILED' });
    }
    db.prepare('insert into messages(id,member_id,channel,kind,created_by,created_at) values(?,?,?,?,?,?)').run(newId(), id, 'SMS_LINK', 'LINK', c.get('me').staffId, nowIso());
    return c.json({ ok: true });
  });

  r.post('/attendances', async (c) => {
    const b = await body(c);
    if (!b || !str(b.courseId) || !(str(b.qr) || str(b.memberId))) return bad(c);
    let memberId: string;
    if (str(b.qr)) {
      const parsed = parseQr(db, b.qr);
      if (!parsed) return c.json({ ok: false, reason: 'UNKNOWN_QR' });
      memberId = parsed;
    } else memberId = b.memberId;
    const res = attend(db, { memberId, courseId: b.courseId, staffId: c.get('me').staffId, now: clock(d) });
    const m = db.prepare('select id, name from members where id=? and erased_at is null').get(memberId) as { id: string; name: string } | undefined;
    // The created attendance lets the screen update its lists without downloading /bootstrap again.
    const extra = res.ok ? { attendance: toAttendance(db.prepare('select * from attendances where id=?').get(res.attendanceId)) } : {};
    return c.json(m ? { ...res, ...extra, member: { id: m.id, name: m.name } } : { ...res, ...extra });
  });

  r.post('/attendances/backfill', async (c) => {
    const b = await body(c);
    if (!b || !str(b.memberId) || !str(b.passId) || !str(b.courseId) || !str(b.date)) return bad(c);
    const res = backfillAttendance(db, { memberId: b.memberId, passId: b.passId, courseId: b.courseId, date: b.date, staffId: c.get('me').staffId, now: clock(d) });
    if (!res.ok) return c.json({ error: res.reason }, res.reason === 'ALREADY' || res.reason === 'EMPTY' ? 409 : 400);
    return c.json({ ok: true, attendance: toAttendance(db.prepare('select * from attendances where id=?').get(res.attendanceId)) });
  });

  r.post('/attendances/:id/cancel', (c) => c.json({ ok: cancelAttendance(db, c.req.param('id'), c.get('me').staffId) }));
  return r;
}
