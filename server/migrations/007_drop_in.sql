-- 원데이 상품(회원 없이 결제만): 결제가 들어와도 "회원 연결"을 요구하지 않고 이름만 적는다. 정산은 상품에 묶인 수업의 강사 몫으로 센다.
-- 결제 쪽 drop_in 은 적재 시점의 상품 설정을 고정해 둔 것(나중에 상품 설정을 바꿔도 지난 결제는 그대로).
alter table products add column drop_in integer not null default 0;
alter table payments add column drop_in integer not null default 0;
-- 2026-11-05 THE DEPTH: 토스 POS 의 1회권과 워밍업은 원데이.
update products set drop_in=1 where name='WARM UP TRAINING' or name like '(1 TICKET)%';
update payments set drop_in=1 where status='APPROVED' and member_id is null and pass_id is null and product_name in (select name from products where drop_in=1);
