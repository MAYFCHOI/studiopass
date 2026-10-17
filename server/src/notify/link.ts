// 회원 페이지 링크를 알림톡(LINK 템플릿)으로 보낸다. 링크를 새로 발급하므로 예전 링크는 막힌다(문자 보내기와 같다).
import type { Deps } from '../routes/common.js';
import { issueLink } from '../links.js';
import { notifyMember, type SendResult } from './alimtalk.js';

export const alimtalkOn = (d: Deps) => !!d.alimtalk?.enabled && !!d.allowedOrigin;

export async function sendLinkAlimtalk(d: Deps, memberId: string, staffId: string | null): Promise<SendResult | { skipped: true }> {
  if (!alimtalkOn(d)) return { skipped: true };
  const m = d.db.prepare('select name, phone from members where id=?').get(memberId) as { name: string; phone: string | null } | undefined;
  if (!m?.phone) return { skipped: true };
  const url = `${d.allowedOrigin}/m/${issueLink(d.db, memberId, staffId)}`;
  return notifyMember(d.db, d.alimtalk!, memberId, 'LINK', { 이름: m.name, 링크: url }, staffId, d.fetchImpl ?? fetch);
}

export type OnPass = (memberId: string, passId: string, staffId: string | null) => void;

/**
 * 수강권이 새로 생겼을 때 부르는 훅. 바로 보내지 않고 microtask 로 미룬다: better-sqlite3 트랜잭션은 동기라서
 * microtask 가 돌 때는 바깥 트랜잭션이 이미 커밋(또는 롤백)돼 있다. 롤백됐으면 수강권이 없으니 보내지 않는다.
 * 같은 묶음에서 한 회원에게 수강권이 여러 개 생겨도 한 번만 보낸다. 발송 오류는 삼키고 코드만 로그.
 */
export function passNotifier(d: Deps): OnPass | undefined {
  if (!alimtalkOn(d)) return undefined;
  let pending: Map<string, { passId: string; staffId: string | null }> | null = null;
  return (memberId, passId, staffId) => {
    if (!pending) {
      pending = new Map();
      queueMicrotask(() => {
        const batch = pending!; pending = null;
        void (async () => {
          for (const [mid, p] of batch) {
            if (!d.db.prepare('select 1 from passes where id=?').get(p.passId)) continue;
            await sendLinkAlimtalk(d, mid, p.staffId).catch((e) => console.error('alimtalk hook error:', e instanceof Error ? e.name : 'unknown'));
          }
        })();
      });
    }
    if (!pending.has(memberId)) pending.set(memberId, { passId, staffId });
  };
}
