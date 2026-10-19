// 토스플레이스 Open API 설정. 환경변수가 하나라도 비면 꺼진 상태(enabled=false)이고 네트워크를 전혀 쓰지 않는다.
// 로그에는 키를 남기지 않는다.
export type TossConfig = { enabled: boolean; accessKey: string; secretKey: string; merchantId: string; webhookSecret: string; ntfyTopic: string };

export function loadTossConfig(env: Record<string, string | undefined>): TossConfig {
  const v = (k: string) => (env['SP_TOSS_' + k] ?? '').trim();
  const cfg = { accessKey: v('ACCESS_KEY'), secretKey: v('SECRET_KEY'), merchantId: v('MERCHANT_ID'), webhookSecret: v('WEBHOOK_SECRET') };
  const enabled = Object.values(cfg).every((x) => x.length > 0) && /^\d+$/.test(cfg.merchantId);
  // 알림은 선택. 비면 보내지 않는다. 서버 경보와 같은 토픽(/etc/studiopass/alerts.env 의 NTFY_TOPIC)을 쓴다.
  return { enabled, ...cfg, ntfyTopic: (env.SP_NTFY_TOPIC ?? env.NTFY_TOPIC ?? '').trim() };
}
