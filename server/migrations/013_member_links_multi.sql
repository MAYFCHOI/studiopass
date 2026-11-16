-- 회원 링크를 다시 만들어도 이전 링크가 계속 열리게 한다(회원당 최근 5개). 회원 정보 삭제 때는 전부 지운다.
create table member_links_new (token_hash text primary key, member_id text not null references members(id), issued_at text not null, issued_by text);
insert into member_links_new(token_hash, member_id, issued_at, issued_by) select token_hash, member_id, issued_at, issued_by from member_links;
drop table member_links;
alter table member_links_new rename to member_links;
create index member_links_member on member_links(member_id);
