-- 토스플레이스 웹훅 수신 기록. webhook_id(x-toss-webhook-id)는 재전송에도 같아서 멱등 키로 쓴다.
-- payload 는 결제(Payment) 객체만 둔다(카드번호는 토스가 마스킹해서 보낸다).
create table toss_events (
  webhook_id text primary key,
  type text not null,
  payment_id text,
  payload text,
  status text not null check (status in ('PENDING','DONE','IGNORED')),
  attempts integer not null default 0,
  last_error text,
  received_at text not null,
  processed_at text
);
create index toss_events_pending on toss_events(status) where status = 'PENDING';
