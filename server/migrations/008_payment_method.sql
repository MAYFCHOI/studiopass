-- 키오스크(토스) 밖에서 받은 결제의 수단. 직접 입력한 결제만 채우고, 키오스크 결제와 예전 직접 입력은 null.
alter table payments add column method text check (method in ('CASH','TRANSFER','OTHER'));
-- 원데이 상품을 앱에 나중에 등록해 원데이 표시가 빠진 결제(2026-11-13 'Yeni Cho 1Day' 7건)를 채운다. 이후로는 상품 저장 때 같은 일을 한다.
update payments set drop_in=1 where status='APPROVED' and drop_in=0 and member_id is null and pass_id is null and product_name in (select name from products where drop_in=1 and active=1);
