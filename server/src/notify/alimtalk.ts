// 카카오 알림톡(Solapi) 발송. 환경변수가 하나라도 비면 꺼진 상태(enabled=false)이고 네트워크를 전혀 쓰지 않는다.
// 로그에는 키·전화번호·이름·본문을 남기지 않는다. 오류 코드만.
import { createHmac, randomBytes } from 'node:crypto';
import type { Db } from '../db.js';
import { newId, nowIso } from '../util.js';
import type { TemplateKey } from './templates.js';
export type { TemplateKey } from './templates.js';

export type AlimtalkConfig = { enabled: boolean; apiKey: string; apiSecret: string; pfId: string; sender: string; templates: Record<TemplateKey, string> };
export type SendResult = { ok: boolean; id?: string; error?: string };

const ENDPOINT = 'https://api.solapi.com/messages/v4/send-many/detail';
const TIMEOUT_MS = 10_000;

export function loadAlimtalkConfig(env: Record<string, string | undefined>): AlimtalkConfig {
  const v = (k: string) => (env['SP_ALIMTALK_' + k] ?? '').trim();
  const cfg = {
    apiKey: v('API_KEY'), apiSecret: v('API_SECRET'), pfId: v('PF_ID'), sender: v('SENDER').replace(/\D/g, ''),
    templates: { LINK: v('TPL_LINK'), REMAINING: v('TPL_REMAINING'), EXPIRING: v('TPL_EXPIRING'), PRO_RENEW: v('TPL_PRO_RENEW') },
  };
  const enabled = [cfg.apiKey, cfg.apiSecret, cfg.pfId, cfg.sender, ...Object.values(cfg.templates)].every((x) => x.length > 0);
  return { enabled, ...cfg };
}

/** Solapi HMAC 인증 헤더: signature = hex(HMAC-SHA256(secret, date + salt)). */
export function authHeader(apiKey: string, apiSecret: string, date = new Date().toISOString(), salt = randomBytes(16).toString('hex')) {
  const signature = createHmac('sha256', apiSecret).update(date + salt).digest('hex');
  return `HMAC-SHA256 apiKey=${apiKey}, date=${date}, salt=${salt}, signature=${signature}`;
}

export async function sendAlimtalk(cfg: AlimtalkConfig, to: string, key: TemplateKey, vars: Record<string, string>, fetchImpl: typeof fetch = fetch): Promise<SendResult> {
  if (!cfg.enabled) return { ok: false, error: 'DISABLED' };
  const variables = Object.fromEntries(Object.entries(vars).map(([k, val]) => [k.startsWith('#{') ? k : `#{${k}}`, val]));
  const message = { to: to.replace(/\D/g, ''), from: cfg.sender, kakaoOptions: { pfId: cfg.pfId, templateId: cfg.templates[key], variables, disableSms: false } };
  let res: Response;
  try {
    res = await fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: authHeader(cfg.apiKey, cfg.apiSecret), 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [message] }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch { return { ok: false, error: 'NETWORK' }; }
  const j = (await res.json().catch(() => null)) as any;
  if (!res.ok) return { ok: false, error: code(j?.errorCode) ?? `HTTP_${res.status}` };
  const failed = Array.isArray(j?.failedMessageList) ? j.failedMessageList : [];
  if (failed.length) return { ok: false, error: code(failed[0]?.statusCode) ?? 'FAILED' };
  const id = j?.groupInfo?.groupId;
  return typeof id === 'string' ? { ok: true, id } : { ok: true };
}
// 공급자 오류 코드만 남긴다(본문·메시지 문구는 저장하지 않음).
const code = (v: unknown) => (typeof v === 'string' || typeof v === 'number') && /^[\w.-]{1,40}$/.test(String(v)) ? String(v) : undefined;

/** 회원에게 알림톡을 보내고 messages 에 결과를 남긴다. 꺼져 있거나 전화번호가 없으면 아무것도 하지 않는다. */
export async function notifyMember(db: Db, cfg: AlimtalkConfig, memberId: string, key: TemplateKey, vars: Record<string, string>, staffId: string | null, fetchImpl: typeof fetch = fetch): Promise<SendResult | { skipped: true }> {
  if (!cfg.enabled) return { skipped: true };
  const m = db.prepare('select phone from members where id=?').get(memberId) as { phone: string | null } | undefined;
  if (!m?.phone) return { skipped: true };
  const r = await sendAlimtalk(cfg, m.phone, key, vars, fetchImpl);
  db.prepare('insert into messages(id,member_id,channel,kind,status,error,provider_id,created_by,created_at) values(?,?,?,?,?,?,?,?,?)')
    .run(newId(), memberId, 'ALIMTALK', key, r.ok ? 'SENT' : 'FAILED', r.ok ? null : (r.error ?? 'FAILED'), r.id ?? null, staffId, nowIso());
  if (!r.ok) console.error(`alimtalk ${key} failed: ${r.error}`);
  return r;
}
