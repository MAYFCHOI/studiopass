-- 같은 요청 키(Idempotency-Key)로 다시 온 등록 요청에 처음 응답을 그대로 돌려준다(24시간).
create table idempotency (key text not null, staff_id text not null, route text not null, status integer not null, response_json text not null, created_at text not null, primary key (key, staff_id, route));
create index idempotency_at on idempotency(created_at);
-- 엑셀 업로드 묶음(되돌리기용), 확인 필요 표시(REFUND_IN_USE: 환불됐지만 출석 기록 있음, REFUND_UNMATCHED: 원 결제를 못 찾은 환불), 환불 행이 가리키는 원 결제.
alter table payments add column import_batch_id text;
alter table payments add column review text;
alter table payments add column refund_of text;
create index payments_batch on payments(import_batch_id) where import_batch_id is not null;
create index payments_phone on payments(payer_phone);
