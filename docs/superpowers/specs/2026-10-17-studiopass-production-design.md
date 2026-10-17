# studiopass 실사용 전환 설계 (THE DEPTH DANCE STUDIO)

작성 2026-10-17. 대상: 지금 GitHub Pages 에서 브라우저 저장으로 도는 프로토타입을, 선생님 학원이 실제로 쓰는 서비스로 바꾼다.
결정 경위는 claude-setup 메모리 `project_personal_studiopass.md`, 선생님 피드백은 `docs/FEEDBACK.md`, 가정은 `docs/ASSUMPTIONS.md`, 흐름도는 `docs/diagrams/flow-20261017.html`, 회원 화면 시안은 `docs/mockups/member-page.html`.

## 1. 목표와 범위

목표: 원장·인포가 폰과 맥북에서 같은 데이터를 보고, 회원은 개인 링크로 자기 QR·남은 횟수·등급을 본다. 데이터는 서버에 있고 매일 백업된다.

이번 범위 (1단계)
- 서버 + DB + 직원 로그인(원장 OWNER / 인포 DESK), 권한은 서버에서 막는다
- 지금 앱 화면(오늘·출석·회원·결제·정산·설정)을 서버 API 로 연결
- 회원 개인 링크 페이지 `/m/<토큰>` (시안 확정안: 검정 화면 + DEPTH 줄무늬 등급)
- 회원 링크 문자 보내기 = 폰 기본 문자 앱 열기(`sms:` 링크) + 발송 기록
- 키오스크 엑셀 업로드(지금 방식 유지), 정산, 엑셀 내보내기
- 개인 AWS Lightsail 배포, 도메인, HTTPS, 매일 백업, 장애 알림

범위 밖 (다음 단계)
- OKPOS 결제 자동 수집 (스파이크로 분리, 결제 적재 함수 자리만 둔다)
- 카카오 알림톡 (발송 기록 표만 먼저 만든다)
- 오프라인 출석 큐 (결정 A: 끊기면 화면에 오프라인 표시, 복구 뒤 이름 검색으로 넣는다)
- 강사 로그인, 다지점

## 2. 구성

```
[폰·맥북 브라우저] ──HTTPS──> Caddy (TLS 자동, 정적 파일, /api 프록시)
                                  └─> api (Node 22 + Hono, TypeScript)
                                         └─> SQLite 파일 (/data/studiopass.db, WAL)
백업: 매일 03:30 KST  sqlite .backup → gzip → Lightsail 버킷(30일 보관)  실패 시 ntfy
```

- 저장소 한 곳(MAYFCHOI/studiopass). 웹 앱은 지금처럼 루트에 두고, 서버는 `server/` 에 새로 만든다.
- 서버 실행: Docker Compose 서비스 2개(`caddy`, `api`). 빌드된 웹 정적 파일은 api 이미지 안에 넣고 Caddy 가 볼륨으로 받아 서빙하지 않고, **api 가 정적 파일까지 서빙**하고 Caddy 는 TLS 와 리버스 프록시만 한다(구성 단순화).
- DB 드라이버 `better-sqlite3`(동기, 트랜잭션 단순). ORM 없음. `server/migrations/NNN_*.sql` 을 순서대로 적용하고 `schema_migrations` 표에 기록.
- 비밀번호 해시는 Node 내장 `crypto.scrypt`(N=2^15, r=8, p=1, 16바이트 salt). 네이티브 의존성은 better-sqlite3 하나뿐.
- GitHub Pages 프로토타입은 데모로 남긴다(`VITE_MODE=demo` 빌드 = 지금처럼 브라우저 저장 + 가짜 데이터). 실서비스 빌드는 API 모드.

## 3. 데이터 구조 (SQLite)

시각은 전부 UTC ISO 문자열, 날짜는 KST 기준 `YYYY-MM-DD`. 금액은 원 단위 정수. id 는 서버가 만든 무작위 문자열(12자, base62).

| 표 | 열 (요지) | 비고 |
|---|---|---|
| staff | id, login_id(유일), name, role(OWNER/DESK), pw_hash, active, created_at | 초기 원장 1명은 CLI 로 만든다 |
| sessions | token_hash(PK), staff_id, created_at, expires_at, last_seen_at | 쿠키 토큰의 sha256 만 저장. 30일, 쓸 때마다 연장 |
| members | id, member_no(유일, 2026-0001), name, phone(숫자만), memo, created_at | |
| member_links | member_id(PK), token_hash, issued_at, issued_by | 재발급 = 덮어쓰기 → 이전 링크 즉시 무효 |
| instructors | id, name, genres, settlement_type(RATIO/PER_SESSION), ratio_instructor, per_session_fee, active | |
| courses | id, hall(HUB/LAB), name(장르), instructor_id, kind(GENERAL/PRO), level, note, weekday(0~6), start_time, duration_min, active | 한 칸 = 한 수업. 지우지 않고 active=0 |
| products | id, name(키오스크 상품명, 유일), course_id(null=정규 아무 수업), pass_kind(COUNT/PERIOD), count, period_days, price, active | |
| payments | id, source(KIOSK/MANUAL), external_id, paid_at, amount, payer_name, payer_phone, product_name, status(APPROVED/CANCELLED), member_id, pass_id, raw_json, created_by, created_at | external_id 유일(있을 때). 없으면 (전화, 시각, 금액) 으로 중복 판정 |
| passes | id, member_id, product_id, course_id, kind, total_count, remaining, valid_from, valid_to, payment_id, price, created_at | remaining 은 출석과 같은 트랜잭션에서만 바뀐다 |
| attendances | id, member_id, pass_id, course_id, instructor_id, attended_on(KST 날짜), attended_at, cancelled_at, created_by, cancelled_by | (member_id, course_id, attended_on) 활성 출석 유일 = 부분 유일 인덱스 WHERE cancelled_at IS NULL |
| tiers | id, name, min_count, sort | 기본 DEPTH 1~4 = 0/10/30/60 |
| messages | id, member_id, channel(SMS_LINK), kind(LINK), created_by, created_at | 1단계는 "보내기 버튼을 눌렀다" 기록 |
| audit_log | id, at, staff_id, action, entity, entity_id, detail_json | 출석 취소, 결제 연결·취소, 수강권 수정, 링크 재발급, 설정 변경 |
| settings | key(PK), value | studio_name, qr_secret(최초 기동 시 생성) |

규칙
- **출석 트랜잭션**: 회원 확인 → 같은 날 같은 수업 중복 확인 → 쓸 수강권 고르기 → 출석 insert + remaining-1 을 한 트랜잭션. 하나라도 실패하면 아무것도 안 바뀐다.
- **수강권 고르기** (프로토타입 그대로): 전문반(PRO) 수업은 월정액만. 정규 수업은 그 수업 전용권 → 정규 공통 회차권 → 월정액, 같은 순위면 만료 임박 순. 기간 안이고 remaining>0 인 것만.
- **출석 취소**: cancelled_at 기록 + 해당 수강권 remaining+1, 한 트랜잭션.
- **등급**: 저장하지 않는다. 활성 출석 수를 세어 tiers 에서 min_count 이하 중 최댓값.
- **결제 적재**: 프로토타입 `importPayments` 규칙 그대로(중복 제거 → 전화 일치 회원 자동 연결 → 상품명 일치 시 수강권 생성). 결제 적재 함수는 `ingestPayments(rows, source)` 하나로 두고, 나중에 OKPOS 자동 수집도 이 함수를 부른다.
- **결제 취소**: status=CANCELLED, 그 결제로 만든 수강권 삭제는 출석이 없을 때만. 출석이 있으면 거절하고 "출석 n회가 이 수강권을 썼어요" 를 보여준다(프로토타입은 그냥 지웠다 → 실서비스에서 바꾼다).

## 4. 권한

| 기능 | 회원(링크) | 인포 DESK | 원장 OWNER |
|---|---|---|---|
| 자기 QR·수강권·남은 횟수·기한·등급 | 자기 것만 | 전체 | 전체 |
| 회원 등록·수정·링크 재발급·문자 보내기 | – | ● | ● |
| 출석 찍기·취소 | – | ● | ● |
| 결제 올리기·회원 연결 (결제자명·상품·일시) | – | ● | ● |
| 결제 금액·상품 가격·수강권 가격 | – | 응답에서 제외 | ● |
| 정산·정산 엑셀 | – | 403 | ● |
| 수업·상품·강사·등급·직원 설정 | – | 403 | ● |

- DESK 응답에서 금액 필드는 직렬화 단계에서 빠진다(화면 숨김이 아니라 API 가 안 준다). 결제 직접 입력 시 DESK 도 금액을 넣을 수는 있게 한다(현금 결제 입력용), 저장 후 다시 보지는 못한다.
- 원장 계정 비밀번호 분실 시 서버에서 CLI 로 재설정.

## 5. API (요지)

인증: `POST /api/auth/login {login_id, password}` → httpOnly·Secure·SameSite=Lax 쿠키 `sp_session`. `POST /api/auth/logout`, `GET /api/auth/me`. 로그인 실패는 IP+아이디 기준 10분에 5회 제한.
변경 요청은 `Origin` 이 서비스 도메인일 때만 받는다(CSRF).

- `GET /api/bootstrap` → 화면에 필요한 전체 상태(회원·강사·수업·상품·활성 수강권·이번 달과 지난 달 출석·결제·등급). 학원 규모(회원 수백 명)에서는 한 번에 받아도 된다. DESK 는 금액 필드 제외.
- 회원: `POST /api/members`, `PATCH /api/members/:id`, `POST /api/members/:id/link`(재발급, 새 URL 반환), `POST /api/members/:id/messages`(보내기 기록)
- 출석: `POST /api/attendances {qr | member_id, course_id}` → 성공 시 회원·수강권·남은 횟수, 실패 시 사유 코드(UNKNOWN_QR, ALREADY, NO_PASS, EXPIRED, EMPTY, PRO_ONLY). `POST /api/attendances/:id/cancel`
- 결제: `POST /api/payments/import {rows}`(엑셀은 브라우저에서 파싱), `POST /api/payments`(직접 입력), `POST /api/payments/:id/assign {member_id}`, `POST /api/payments/:id/cancel`
- 정산(OWNER): `GET /api/settlement?month=YYYY-MM`
- 설정(OWNER): 강사·수업·상품·등급·직원 CRUD
- 회원 공개: `GET /api/public/m/:token` → 이름(가운데 가림), 등록일, 출석 수, 등급, 활성 수강권(이름·남은/전체·기한), QR 문자열. 금액 없음. 없는 토큰은 404, 응답 지연 일정.

QR 문자열: `AM2:<member_id>:<HMAC-SHA256(qr_secret, member_id) 앞 16자>`. 서버만 검증할 수 있다. 프로토타입의 AM1 은 받지 않는다.

## 6. 화면

- 지금 화면 구성과 THE DEPTH 디자인을 그대로 쓴다. 저장소 계층만 바꾼다: zustand store 가 `/api/bootstrap` 으로 채워지고, 액션은 API 를 부른 뒤 응답으로 상태를 갱신한다.
- 로그인 화면 추가. 세션이 없으면 로그인으로.
- DESK 로그인이면 정산 탭과 설정 탭이 안 보이고, 금액 칸이 없다.
- 오프라인: `navigator.onLine` 과 요청 실패를 보고 상단에 "인터넷 연결이 끊겼어요. 다시 연결되면 이름으로 출석을 넣어주세요" 띠. 출석 버튼은 막는다.
- 회원 페이지 `/m/:token`: 시안 확정안. 별도 진입 파일(`member.html`)로 빌드해 관리 앱 코드를 싣지 않는다. 홈 화면 추가용 manifest.
- 회원 링크 보내기: 회원 상세에서 "링크 문자 보내기" → 폰이면 `sms:<번호>?body=<안내문+링크>` 열기, PC 면 링크 복사. 누르면 messages 에 기록.

## 7. 배포와 운영

| 항목 | 값 |
|---|---|
| 서버 | Lightsail 서울(ap-northeast-2) Ubuntu 24.04, 1GB 플랜, 고정 IP |
| 방화벽 | 80, 443 전체. 22 는 키 접속만, 비밀번호 로그인 끔 |
| 도메인 | 후보 thedepthdance.com (Route53 에서 구매해 AWS 청구서로 함께 관리, 연 16달러, 2026-10-17 조회 시 구매 가능). 구매는 사용자 확인 후 |
| TLS | Caddy 자동(Let's Encrypt) |
| 백업 | 매일 03:30 KST DB 백업 → Lightsail 버킷(5GB 플랜), 30일 보관. 주 1회 인스턴스 자동 스냅샷 |
| 알림 | 백업 실패·헬스체크 실패 시 ntfy(개인 토픽). 본문에 IP·도메인·회원 정보 넣지 않음 |
| 배포 | 맥에서 `scripts/deploy.sh` = 이미지 빌드 → 서버로 전송 → compose up. 배포 전 자동 백업 1회 |
| 비용 | 인스턴스 약 7,700원 + 버킷 약 1,400원 + 도메인 월 약 1,800원 = 월 약 1.1만 원 |

롤백: 배포 직전 백업 파일과 이전 이미지 태그를 남긴다. 문제가 이번 배포 때문일 때만 `scripts/deploy.sh --rollback` 으로 이전 이미지 + 직전 백업 복원(약 2분). 데이터 복원은 배포 뒤 들어온 출석·결제가 사라지므로 마지막 수단.

## 8. 시험

- 서버 규칙은 vitest + 메모리 SQLite: 출석 트랜잭션(중복·수강권 순위·전문반·기간·소진·취소 복원), 결제 적재(중복·자동 연결·상품 매칭·취소 거절), 등급 계산, 정산 계산(프로토타입 결과와 같은 값), 권한(DESK 금액 제외·403), 로그인 제한, 링크 재발급 무효화, QR 서명.
- API 는 Hono `app.request` 로 통합 시험.
- 웹은 빌드·린트 통과 + 헤드리스 Chrome 으로 로그인→출석→회원 링크 화면 확인.
- 배포 후 실제 도메인에서 같은 흐름 1회.

## 9. 데이터 넣기

- 실서비스 첫 기동 시: 시간표·강사(28수업, 17명)를 `buildSchedule()` 결과로 넣고, 상품·정산 조건은 예시값으로 넣되 설정 화면 맨 위에 "가격과 정산 조건을 실제 값으로 바꿔주세요" 표시.
- 회원·결제는 비어 있게 시작. 데모 회원은 넣지 않는다.

## 10. 열린 것

- 도메인 구매 승인 (배포 단계 직전)
- 수강권 실제 종류·가격, 강사별 정산 조건 (선생님)
- OKPOS 엑셀 실제 열 구성 (업체)
