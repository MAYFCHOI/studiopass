-- 수강권 유효기간 연장(수강권당 1번). 원래 끝나는 날은 valid_to - extended_days 로 되돌릴 수 있다.
alter table passes add column extended_days integer;
alter table passes add column extended_at text;
alter table passes add column extended_by text;
