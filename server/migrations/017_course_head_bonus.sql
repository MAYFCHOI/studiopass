-- 인원 인센티브(타임제 수업): 그 날 인원이 bonus_from 명 이상이면 bonus_from 번째 사람부터 1명당 bonus_per_head 원을 1타임 금액에 더한다(웜업 11명부터 1명당 15,000원)
alter table courses add column bonus_from integer;
alter table courses add column bonus_per_head integer;
