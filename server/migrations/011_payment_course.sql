-- 원데이 결제가 어느 수업이었는지. 상품에 수업이 없을 때(웜업처럼 요일마다 강사가 다른 상품) 사람이 고른다. 정산은 이 수업 강사 몫으로 센다.
alter table payments add column course_id text references courses(id);
