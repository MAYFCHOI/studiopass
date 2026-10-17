import { Hono } from 'hono';
import type { Db } from '../db.js';
import { newId, nowIso, kstDate, normalizePhone } from '../util.js';
import { audit } from '../audit.js';
import { assignPayment } from '../domain/payments.js';
import { attend, cancelAttendance } from '../domain/attendance.js';
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
  return toMember(m, { name: t.name, level: t.level, count: t.count });
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
      if (phone) {
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
    if (!b || (b.name !== undefined && !(str(b.name) && maxLen(b.name, LIMITS.name))) || !optStr(b.phone) || !maxLen(b.phone, 30) || !optStr(b.memo) || !maxLen(b.memo, LIMITS.memo)) return bad(c);
    const m = db.prepare('select * from members where id=?').get(id) as any;
    if (!m) return notFound(c);
    if (m.erased_at) return erased(c);
    const phone = b.phone !== undefined ? normalizePhone(b.phone) : m.phone;
    const assigned = db.transaction(() => {
      db.prepare('update members set name=?, phone=?, memo=? where id=?').run(b.name !== undefined ? b.name.trim() : m.name, phone, b.memo !== undefined ? b.memo : m.memo, id);
      audit(db, c.get('me').staffId, 'member.update', 'member', id, { fields: Object.keys(b).filter((k) => ['name', 'phone', 'memo'].includes(k)) });
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

  r.post('/attendances/:id/cancel', (c) => c.json({ ok: cancelAttendance(db, c.req.param('id'), c.get('me').staffId) }));
  return r;
}
