// 토스 연동 일정: 웹훅이 오면 바로, 그 밖에는 1분마다 대기 웹훅 처리. 6시간마다 최근 48시간 주문 대조.
// 한 번에 하나만 돈다(겹치면 건너뛴다). 문제는 ntfy 로 [ISSUE]/[RESOLVED].
import type { Db } from '../db.js';
import type { TossConfig } from './config.js';
import { tossClient, type TossClient } from './client.js';
import { processPending, reconcile, issueTracker, ntfySender } from './sync.js';
import { ingestPayments } from '../domain/payments.js';

type OnPass = Parameters<typeof ingestPayments>[3];
const PENDING_EVERY_MS = 60_000;
const RECONCILE_EVERY_MS = 6 * 3600_000;
const RECONCILE_WINDOW_MS = 48 * 3600_000;

export function startToss(db: Db, cfg: TossConfig, onPass?: OnPass, client: TossClient = tossClient(cfg)) {
  const issue = issueTracker(ntfySender(cfg.ntfyTopic));
  let busy = false;
  const run = async (job: () => Promise<void>) => {
    if (busy) return; busy = true;
    try { await job(); } finally { busy = false; }
  };
  const pending = () => run(async () => {
    try {
      const r = await processPending(db, client, onPass);
      issue('toss-pending', r.stuck > 0, '토스 결제 처리 지연');
    } catch (e) { console.error('toss pending', (e as Error).message); }
  });
  const recon = () => run(async () => {
    const to = new Date(); const from = new Date(to.getTime() - RECONCILE_WINDOW_MS);
    try {
      const r = await reconcile(db, client, from, to, onPass);
      if (r.added || r.cancelled || r.cancelFailed) console.log(`toss reconcile: orders ${r.orders}, added ${r.added}, cancelled ${r.cancelled}, cancelFailed ${r.cancelFailed}`);
      issue('toss-reconcile', false, '토스 결제 대조');
    } catch (e) {
      console.error('toss reconcile', (e as Error).message);
      issue('toss-reconcile', true, '토스 결제 대조 실패');
    }
  });
  const timers = [setInterval(pending, PENDING_EVERY_MS), setInterval(recon, RECONCILE_EVERY_MS), setTimeout(recon, 30_000)];
  return { onReceived: () => void pending(), stop: () => timers.forEach((t) => clearInterval(t)) };
}
