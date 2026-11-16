-- 지난 출석 넣기: ADJ = 횟수 맞추기로 빼 둔 횟수를 출석으로 바꿈, REM = 남은 횟수에서 뺌(취소하면 같은 곳으로 돌려준다)
alter table attendances add column backfilled text;
-- 출석 1회당 강사 추가 페이(전문반 프리 티켓 등). 비율제·타임제와 별도로 더한다
alter table products add column attend_bonus integer;
