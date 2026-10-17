-- 승인번호가 다른 환불 행: 가져올 때 자동 취소하지 않고 원 결제 후보만 기억한다(사람이 확인 필요에서 확정).
alter table payments add column refund_suggested_of text;
