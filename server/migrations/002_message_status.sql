-- 알림톡 발송 결과. SMS_LINK(문자 앱 열기) 행은 status 가 비어 있다.
alter table messages add column status text;
alter table messages add column error text;
alter table messages add column provider_id text;
