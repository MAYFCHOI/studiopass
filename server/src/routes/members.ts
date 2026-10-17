import { Hono } from 'hono';
import type { Db } from '../db.js';
import { newId, nowIso, kstDate, normalizePhone } from '../util.js';
import { audit } from '../audit.js';
import { assignPayment } from '../domain/payments.js';
import { attend, cancelAttendance } from '../domain/attendance.js';
import { tierFor } from '../domain/tiers.js';
import { parseQr } from '../qr.js';
import { issueLink } from '../links.js';
import { toMember } from '../serialize.js';
import { alimtalkOn, passNotifier, sendLinkAlimtalk } from '../notify/link.js';
import { type AppEnv, type Deps, clock, body, bad, notFound, str, optStr } from './common.js';

const memberOut = (db: Db, id: string) => {
  const m = db.prepare('select * from members where id=?').get(id) as any;
  if (!m) return null;
  const t = tierFor(db, id);
  return toMember(m, { name: t.name, level: t.level, count: t.count });
};

export function memberRoutes(d: Deps) {
  const r = new Hono<AppEnv>(); const db = d.db; const onPass = passNotifier(d);

  r.post('/members', async (c) => {
    const b = await body(c);
    if (!b || !str(b.name) || !optStr(b.phone) || !optStr(b.memo)) return bad(c);
    const staffId = c.get('me').staffId; const phone = normalizePhone(b.phone);
    const year = kstDate(clock(d)).slice(0, 4);
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
      return { id, assigned };
    })();
    return c.json({ ...memberOut(db, id)!, assigned });
  });

  r.patch('/members/:id', async (c) => {
    const b = await body(c); const id = c.req.param('id');
    if (!b || (b.name !== undefined && !str(b.name)) || !optStr(b.phone) || !optStr(b.memo)) return bad(c);
    const m = db.prepare('select * from members where id=?').get(id) as any;
    if (!m) return notFound(c);
    db.prepare('update members set name=?, phone=?, memo=? where id=?').run(b.name !== undefined ? b.name.trim() : m.name, b.phone !== undefined ? normalizePhone(b.phone) : m.phone, b.memo !== undefined ? b.memo : m.memo, id);
    audit(db, c.get('me').staffId, 'member.update', 'member', id, { fields: Object.keys(b).filter((k) => ['name', 'phone', 'memo'].includes(k)) });
    return c.json(memberOut(db, id));
  });

  r.post('/members/:id/link', (c) => {
    const id = c.req.param('id');
    if (!db.prepare('select 1 from members where id=?').get(id)) return notFound(c);
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
    if (!db.prepare('select 1 from members where id=?').get(id)) return notFound(c);
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
    const m = db.prepare('select id, name from members where id=?').get(memberId) as { id: string; name: string } | undefined;
    return c.json(m ? { ...res, member: { id: m.id, name: m.name } } : res);
  });

  r.post('/attendances/:id/cancel', (c) => c.json({ ok: cancelAttendance(db, c.req.param('id'), c.get('me').staffId) }));
  return r;
}
