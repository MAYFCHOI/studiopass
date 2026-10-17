-- 개인정보 파기(회원 익명화) 시각과 접속기록용 IP. audit_log 는 지우지 않는다(최소 1년 보관).
alter table members add column erased_at text;
alter table audit_log add column ip text;
create index audit_log_at on audit_log(at);
