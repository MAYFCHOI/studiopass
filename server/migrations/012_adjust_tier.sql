-- 앱 쓰기 전에 쓴 횟수 맞추기(출석 기록은 만들지 않는다), 원장이 정한 최소 등급(1부터, 출석으로 더 오르면 그쪽)
alter table passes add column adjusted_used integer;
alter table passes add column adjusted_at text;
alter table members add column tier_floor integer;
