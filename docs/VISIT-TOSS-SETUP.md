# 학원 방문: 토스 연동 켜기 체크리스트

쌤 앞에서는 이 문서만 보고 진행한다. 코드 작업은 방문 전에 끝내 두고, 방문 날은 **가입 → 키 입력 → 실결제 확인**만 한다.

## 방문 전 (이번 주, 집 Mac)

- [ ] 토스 회신 확인(사업자번호 없이 개발자센터 가입하는 방법). 되면 내 계정으로 테스트 가맹점 연결.
- [ ] 테스트 가맹점으로 확인. 안 되면 방문 날 실결제로 확인(아래 5번).
  - 결제 시각에 시간대가 붙는지(없으면 한국 시각으로 읽게 해둠)
  - 주문 상품명(lineItems)이 오는지
  - 웹훅 서명 검증 통과(서버 로그에 401 없음)
- [ ] `feat/toss` → main 병합, `scripts/deploy.sh` 로 배포. 키가 없으니 토스는 꺼진 채로 올라간다.
  - 확인: `https://thedepthdance.com/api/healthz` = `{"ok":true}`, `scripts/deploy.sh --status`
  - 이러면 방문 날은 코드 배포 없이 키만 넣으면 된다.
- [ ] 서버 접속 수단 챙기기: 집 Mac 을 가져가거나, 들고 갈 노트북에 `ssh studiopass` 가 되게 해 두기. 방문 전에 `ssh studiopass 'echo ok'` 로 확인.
- [ ] 쌤께 미리 받기: 사업자등록증 나왔는지, 토스 POS 에 올릴 수강권 이름·가격 목록.
- [ ] 앱 상품(설정 > 상품) 이름·가격을 쌤 목록대로 맞춰 두기. 가격은 종류마다 다르게.

## 방문 날 (순서대로, 30분 안팎)

### 1. 쌤 명의 개발자센터 가입 (쌤 폰·이메일, 10분)
- [ ] https://developers.tossplace.com 가입. 회사명 = 학원 상호, 대표자 = 쌤, 사업자등록번호 = 쌤 사업자번호.
- [ ] 내 애플리케이션 > 애플리케이션 등록 > 유형 API. 앱 이름 `studiopass`.
- [ ] 인증 키 생성 → **Access Key, Secret Key** 메모(Secret 은 이때 한 번만 보인다).
- [ ] 테스트 가맹점 관리 > 테스트 가맹점 불러오기 → 학원 매장 연결 → 매장 상세에서 앱 활성화.
- [ ] 매장 상세의 **MerchantId**(숫자) 메모. 토스 POS 로그인용 매장고유번호(10자리)와 다른 값이다.

### 2. 웹훅 등록 (5분)
- [ ] 내 애플리케이션 > studiopass > 웹훅 > 생성
  - 수신 주소: `https://thedepthdance.com/hooks/toss`
  - 수신 범위: `payment.payment.approved.v1`, `payment.payment.cancelled.v1`
  - 서명 정보(Secret Key) 값 메모 = **Webhook Secret**

### 3. 서버에 키 넣기 (5분)
값을 채팅·메모앱에 남기지 않는다. 노트북 터미널에서 바로 입력.
```
ssh studiopass 'sudo tee /etc/studiopass/toss.env >/dev/null <<EOF
SP_TOSS_ACCESS_KEY=<Access Key>
SP_TOSS_SECRET_KEY=<Secret Key>
SP_TOSS_MERCHANT_ID=<MerchantId 숫자>
SP_TOSS_WEBHOOK_SECRET=<Webhook Secret>
EOF
sudo chmod 600 /etc/studiopass/toss.env'
ssh studiopass 'cd /srv/studiopass/app && sudo docker compose up -d --force-recreate api'
ssh studiopass 'cd /srv/studiopass/app && sudo docker compose logs --tail 20 api'
```
- [ ] 로그에 `toss on` 이 보이면 켜진 것. `toss off` 면 4개 중 빈 값이 있거나 MerchantId 가 숫자가 아님.

### 4. 토스 POS 상품 등록 (쌤이 직접, 5분)
- [ ] 토스 POS 상품 이름을 앱 상품 이름과 **글자 그대로** 맞춘다(띄어쓰기는 달라도 됨).
- [ ] 토스 POS 자체의 회원·횟수권 기능은 쓰지 않는다(잔여 횟수는 앱에서만).

### 5. 실결제 확인 (5분)
- [ ] 제일 싼 수강권을 키오스크 모드로 카드 결제.
- [ ] 1분 안에 앱 결제 화면 "배정 대기"에 뜨는지, 상품명·금액·시각이 맞는지.
- [ ] 회원 연결 → 수강권 생기는지.
- [ ] 토스 POS 에서 그 결제 취소 → 앱에서 결제 취소, 수강권 사라지는지.
- [ ] 안 뜨면: `ssh studiopass 'cd /srv/studiopass/app && sudo docker compose logs --tail 50 api'`
  - `401`/`BAD_SIGNATURE` → Webhook Secret 오타. 3번 다시.
  - 로그에 아무것도 없음 → 웹훅 주소·수신 범위 확인(2번), 토스 쪽 웹훅 전송 기록 확인.
  - `toss pending` 오류 → Access/Secret Key 또는 MerchantId 확인.
  - 웹훅이 끝내 안 와도 6시간마다 대조가 결제를 채운다. 그날은 엑셀 업로드로 대체 가능.

### 6. 마무리
- [ ] 쌤께: 결제는 자동으로 들어오고, 데스크는 "배정 대기"에서 회원만 눌러 연결하면 된다고 안내.
- [ ] 쌤 개발자센터 계정 정보는 쌤이 보관. 나는 키를 저장하지 않는다(서버 toss.env 에만).

## 문제 생기면 (롤백)
발동 조건: **문제 원인이 토스 연동일 때만.** 다른 장애에 먼저 돌리지 않는다.
```
ssh studiopass 'sudo truncate -s 0 /etc/studiopass/toss.env && cd /srv/studiopass/app && sudo docker compose up -d --force-recreate api'
```
1분 안에 토스 연동이 꺼진다(웹훅 404, 동기화 멈춤). 결제는 엑셀 업로드로 계속 받는다. 이미 들어온 토스 결제는 그대로 남는다. 코드까지 되돌리려면 `scripts/deploy.sh --rollback`(RUNBOOK).

상세 설계·토스 답변: docs/TOSS-OPENAPI.md
