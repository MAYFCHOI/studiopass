-- 추가 페이: 시간표 수업이 아닌 일(웜업 등)에 강사에게 주는 돈. 날짜·강사·금액·메모, 정산에서 그 강사에게 한 줄로 더한다
create table extra_pays (id text primary key, date text not null, instructor_id text not null references instructors(id), fee integer not null, memo text, created_by text, created_at text not null);
create index extra_pays_date on extra_pays(date);
