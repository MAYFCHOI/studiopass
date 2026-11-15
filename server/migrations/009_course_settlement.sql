-- 수업별 정산 조건. null 이면 강사 기본 조건을 따른다(한 강사가 비율제·타임제 수업을 같이 할 때).
alter table courses add column settlement_type text check (settlement_type in ('RATIO','PER_SESSION'));
alter table courses add column ratio_instructor integer;
alter table courses add column per_session_fee integer;
