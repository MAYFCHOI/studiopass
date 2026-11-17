-- 대강: 그 날 그 수업을 다른 강사가 맡음(정산에서 그 날 출석·원데이와 1타임이 대강 강사 몫). fee = 그 날 1타임 금액(비우면 수업·강사 기준)
create table substitutions (id text primary key, course_id text not null references courses(id), date text not null, instructor_id text not null references instructors(id), fee integer, created_by text, created_at text not null, unique (course_id, date));
-- 등급 기간 조건(년): 출석 횟수와 같이 채워야 그 등급
alter table tiers add column min_years integer;
-- 처음 다니기 시작한 날(앱 쓰기 전부터 다닌 회원). 없으면 등록일
alter table members add column since text;
-- 지운 수업: 목록·시간표·고르기에서 빠지고 지난 출석·정산 기록용으로만 남는다
alter table courses add column deleted_at text;
-- 강사 할인 등으로 깎아 받은 비율(%)
alter table payments add column discount_pct integer;
