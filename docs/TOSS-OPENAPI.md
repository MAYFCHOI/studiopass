# 토스플레이스 Open API 연동 검토 (2026-10-19)

## 결론
- 쌤이 토스 POS + 토스프론트2로 기기를 알아보는 중(10-19). OKPOS·신화포스 KCP(JY-P1000)는 공식 연동 없음.
- 공식 연동 = Open API(결제 조회 + 결제 승인·취소 웹훅). 매장은 토스 POS 설정 > 기타설정 > 서비스 연동에 서비스 코드 입력.
- 미확인: 개인 개발자/개인사업자 매장도 라이브 검수 가능한지(문서상 "솔루션 파트너사용"), 비용, 프론트 키오스크 모드 결제 수신, Mac용 토스 POS.
- 확인된 한계: 카드 결제에는 결제자 전화번호 없음(현금영수증 PHONE 발급 시 identityNumber 만). 회원 연결은 데스크 수동.

## 토스 답변 (2026-10-19 오후, developer-support)
- 개발자센터 가입: 이메일만, 사업자번호 불필요.
- 라이브 가맹점 연결: 사업자번호 전제. 가장 간단 = 가맹점 사업자(쌤)가 본인 사업자번호로 가입 → "테스트 가맹점 불러오기"에서 본인 매장 바로 연결.
- 비용: 계약 없음, 2026-12-31 까지 무료, 이후 변경 시 사전 안내.
- 토스프론트2 결제(키오스크 모드 포함)는 결제 조회 API·웹훅으로 동일 수신. 조회 응답과 웹훅은 같은 Payment 모델, 채널 구분 필드 없음.
- 토스 POS Mac/PC 설치 불가(실물 단말기 전제). 세트에 태블릿 포함이라 무관.
- 외부 POS(KCP 등)가 주문 생성 API를 안 부르면 결제가 토스에 기록되지 않음 → 수신 불가.
- 상품 정보는 Payment 가 아니라 Order.lineItems. 토스 답은 외부 POS 기준이라, 토스 POS 자체 주문에 lineItems 가 채워지는지 테스트로 확인. 안 되면 수강권별 가격을 겹치지 않게 해서 금액으로 매핑.

## 결정 (10-19)
- 쌤 구매 = 신신엠앤씨(토스 우수대리점) 토스 태블릿 포스 + 토스프론트 세트(158,500원, 태블릿 포함, 키오스크 모드 가능). 쌤께 "연동 된다, 앱 연결 작업은 우리가, 연동 이용료 연말까지 무료(포스 이용료와 별개)" 전달 완료.
- 토스 POS 자체 회원·횟수권 기능은 쓰지 않는다. 수강권·출석·잔여 횟수는 studiopass 만.

## 할 일
기기 도착 전
1. (사용자) 개발자센터 가입 → 앱 생성 → 키는 ~/.cred/ 파일로(채팅 금지)
2. 테스트 가맹점으로 결제 조회·웹훅 페이로드, 토스 POS 주문 lineItems 확인
3. 토스 어댑터: 웹훅 엔드포인트(서명 검증, x-toss-webhook-id 중복 방지) → Payment 를 PaymentInput 으로 변환 → 기존 ingestPayments(회원 연결·취소·환불 규칙 재사용). 일 1회 결제 조회 대조로 누락 보정, ntfy ISSUE/RESOLVED. 상품 매핑 = lineItems 이름 우선, 없으면 금액. 엑셀 업로드는 비상용 유지.
4. 테스트(중복·재시도 포함) → studiopass-1 배포. 이 노트북엔 ssh·AWS 키 없음 → 배포는 집 Mac 또는 키 이전 후.
쌤 사업자등록 후
5. 쌤 사업자번호로 개발자센터 가입 → 테스트 가맹점 불러오기로 매장 연결 → 앱 설치(같이)
6. 쌤 계정 키로 교체, 소액 실결제·취소로 끝까지 확인
쌤이 정할 것
7. 토스 POS 상품명·가격 = 앱 상품과 동일 이름, 가격 겹치지 않게

## 문서
- https://docs.tossplace.com/guide/pos-integration/open-api/intro.html
- https://docs.tossplace.com/guide/pos-integration/open-api/develop-tutorial.html
- https://docs.tossplace.com/guide/pos-integration/open-api/service-install.html
- https://docs.tossplace.com/guide/pos-integration/open-api/faq.html
- https://docs.tossplace.com/reference/open-api/payment.html
- https://docs.tossplace.com/reference/open-api/webhook.html

## 문의 메일 초안
받는 사람: developer-support@tossplace.com
제목: 개인사업자 매장 대상 Open API 이용 가능 여부 문의

안녕하세요.

개인사업자로 운영될 댄스 학원 한 곳의 출결·수강권 관리 웹앱을 개발하고 있습니다. 학원에 토스 POS와 토스프론트2를 도입하고, 결제 내역을 Open API로 받아 회원 수강권을 자동으로 등록하려고 합니다.

문서에서 Open API가 솔루션 파트너사를 위한 서비스라고 안내되어 있어, 아래 내용을 문의드립니다.

1. 사업자등록이 없는 개인 개발자도 개발자센터에서 앱을 만들고 검수를 받아 실제 가맹점 1곳에 설치할 수 있나요?
2. 1번이 어렵다면, 가맹점(개인사업자)이 직접 개발자센터에 가입해 자기 매장 전용 앱으로 검수를 받는 것은 가능한가요?
3. Open API 이용에 별도 비용이나 계약이 필요한가요?
4. 토스프론트2를 키오스크 모드로 사용해 결제한 건도 결제 조회 API와 결제 웹훅으로 동일하게 받을 수 있나요?
5. 토스 POS 앱을 Mac에 설치해 사용할 수 있나요?
6. 외부 포스(NHN KCP)에 토스프론트2를 결제 단말기로 연결해 쓰는 경우에도, 프론트에서 승인된 결제를 Open API로 조회하거나 웹훅으로 받을 수 있나요? 이때 상품 정보도 함께 받을 수 있나요?

연동 범위는 결제 조회와 결제 승인·취소 웹훅 수신만 필요하며, 주문 생성이나 배달 기능은 사용하지 않습니다.

답변 부탁드립니다. 감사합니다.

## 구현 (브랜치 feat/toss, 10-19, 미배포)
- 웹훅 주소: `https://thedepthdance.com/hooks/toss` (/api 밖, 세션·Origin 검사 없음, 서명으로만 받음). 개발자센터 웹훅 수신 범위 = `payment.payment.approved.v1`, `payment.payment.cancelled.v1`.
- 흐름: 서명 검증(HMAC-SHA256, 5분 시각 허용) → `toss_events` 에 webhook_id 로 한 번만 기록 → 바로 200 → 뒤에서 처리. 승인은 주문 조회로 상품명(lineItems), 5번 실패하면 금액으로 적재. 우리에게 승인 기록이 없는 취소는 버림.
- 적재: `toss:<결제ID>` 를 승인번호 자리에 두고 기존 `ingestPayments` 그대로(중복·취소·출석 쓴 수강권 취소 시 REFUND_IN_USE). 결제자 번호가 없어서 회원 연결은 데스크(배정 대기).
- 대조: 6시간마다(시작 30초 뒤 한 번) 최근 48시간 주문 목록으로 빠진 결제 적재. 대기 처리는 1분마다 + 웹훅 즉시.
- 알림: `NTFY_TOPIC`(alerts.env) 로 대조 실패·처리 지연을 [ISSUE]/[RESOLVED].
- 설정: 서버 `/etc/studiopass/toss.env` (600) `SP_TOSS_ACCESS_KEY`, `SP_TOSS_SECRET_KEY`, `SP_TOSS_MERCHANT_ID`(숫자 매장 ID, POS 매장고유번호 아님), `SP_TOSS_WEBHOOK_SECRET`. 하나라도 비면 꺼짐(웹훅 404, 네트워크 안 씀). 바꾼 뒤 `up -d --force-recreate api`.
- 코드: server/src/toss/{config,signature,client,mapper,sync,routes,runner}.ts, server/migrations/006_toss.sql, 테스트 server/test/toss.test.ts(토스 문서 서명 예시로 검증).

## 실데이터로 확인할 것 (테스트 가맹점 또는 첫 실결제)
- approvedAt 등 시각에 오프셋이 없는지(없으면 한국 시각으로 읽음, mapper.tossTime).
- 토스 POS·키오스크 주문의 lineItems.item.title 이 상품명 그대로 오는지.
- 웹훅 서명이 문서대로인지(실패하면 401 → 토스가 재시도하다 중단할 수 있으니 첫 연결 때 로그 확인).
- 주문 목록 from/to 형식(ISO UTC 로 보냄) 이 받아들여지는지.

## 롤백
- 원인이 토스 연동일 때만: `/etc/studiopass/toss.env` 키를 비우고 `up -d --force-recreate api` → 웹훅 404, 동기화 멈춤(1분). 결제는 엑셀 업로드로 계속. 이미 들어온 토스 결제는 그대로 남음.
- 코드까지 되돌리려면 이전 배포 태그로 재배포(RUNBOOK). 006 마이그레이션은 테이블 추가뿐이라 이전 코드와 함께 둬도 무해.
