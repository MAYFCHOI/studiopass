# 카카오 알림톡 켜기

알림톡 발송 기능은 코드에 들어가 있지만 **꺼진 상태**로 배포됩니다. 아래 6단계를 마치고 서버에 키를 넣으면 켜집니다.
키가 하나라도 비어 있으면 서버는 알림톡을 보내지 않고, 회원 상세 화면도 지금처럼 "링크 문자 보내기"(휴대폰 문자 앱 열기)를 보여줍니다.

## 지금 되는 것 / 아직 안 되는 것

| 템플릿 | 상태 |
|---|---|
| 회원 페이지 안내 (LINK) | 켜면 바로 동작합니다. 수강권이 새로 생기면 자동 발송, 회원 상세의 "알림톡으로 링크 보내기" 버튼으로 수동 발송 |
| 잔여 횟수 안내 (REMAINING) | 문구만 준비돼 있습니다. 보내는 스케줄러는 아직 없습니다 |
| 기한 만료 예정 안내 (EXPIRING) | 문구만 준비돼 있습니다. 보내는 스케줄러는 아직 없습니다 |
| 전문반 갱신 안내 (PRO_RENEW) | 문구만 준비돼 있습니다. 보내는 스케줄러는 아직 없습니다 |

검수는 한 번에 받는 것이 편해서 4종을 모두 신청합니다. 4개 templateId 가 모두 있어야 켜지도록 되어 있습니다.

알아둘 점:

- 수강권이 새로 생길 때(키오스크 적재·직접 입력·회원 연결) 자동으로 보내는 LINK 알림톡은 **그 회원에게 아직 링크가 없을 때만** 나갑니다. 이때 첫 링크를 발급해 보냅니다. 이미 링크가 있는 회원에게는 자동으로 보내지 않습니다. 보내면 링크가 새로 발급돼 회원이 쓰던 링크와 홈 화면 바로가기가 막히기 때문입니다.
- 회원 상세의 "알림톡으로 링크 보내기" 버튼은 누를 때마다 링크를 **새로 발급**해 보냅니다. 예전 링크는 막힙니다(문자 보내기와 같습니다). 링크를 잃어버린 회원에게 다시 보낼 때 씁니다.
- 서버 주소(`SP_ORIGIN`)가 설정돼 있지 않으면 링크를 만들 수 없어서 보내지 않습니다. 운영 서버는 docker-compose 가 자동으로 넣어 줍니다.
- 발송이 실패해도 결제 적재나 수강권 생성은 그대로 됩니다. 발송 결과는 `messages` 테이블에 `channel='ALIMTALK'`, `status='SENT'` 또는 `'FAILED'` 와 오류 코드로 남습니다.
- 회원 전화번호가 없으면 보내지 않습니다.

## 켜는 순서

1. **카카오톡 채널 개설** — [카카오톡 채널 관리자센터](https://center-pf.kakao.com)에서 학원 이름(THE DEPTH)으로 채널을 만듭니다.
2. **채널 비즈니스 인증** — 같은 관리자센터에서 사업자등록증으로 비즈니스 채널 인증을 신청합니다. 알림톡은 비즈니스 인증된 채널만 보낼 수 있습니다.
3. **Solapi 가입·발신번호 등록** — [Solapi](https://solapi.com)에 가입하고 학원 대표 전화번호를 발신번호로 등록합니다(통신서비스 이용증명원 등 서류가 필요할 수 있습니다). 알림톡이 실패하면 이 번호로 문자가 대신 나갑니다.
4. **Solapi 에서 채널 연동** — Solapi 콘솔의 카카오 채널 메뉴에서 1번 채널을 연동합니다. 연동이 끝나면 발신 프로필 ID(`pfId`, `KA01PF...` 로 시작)가 나옵니다.
5. **템플릿 4종 검수 신청** — Solapi 콘솔의 알림톡 템플릿 메뉴에서 아래 4개를 **글자 그대로** 등록하고 검수를 신청합니다. 보통 1~3 영업일 걸립니다. 반려되면 사유에 맞춰 고친 뒤, 고친 문구를 `server/src/notify/templates.ts` 와 이 문서에도 똑같이 반영해야 합니다(승인된 문구와 한 글자라도 다르면 발송이 실패합니다).
6. **서버에 키 넣고 재시작** — 승인된 templateId 4개와 API 키를 서버의 `/etc/studiopass/alimtalk.env` 에 넣고 api 컨테이너를 다시 만듭니다(아래 "서버에 키 넣기").

## 템플릿 원문 (검수 신청용)

공통: 메시지 유형은 기본형, 카테고리는 "회원/수강 안내" 계열을 고릅니다. 버튼은 없습니다(링크는 본문에 들어갑니다).
검수에서 링크를 버튼으로 옮기라고 하면 버튼(웹링크) 지원을 코드에 추가해야 하니 알려 주세요.

변수 설명:

| 변수 | 들어가는 값 |
|---|---|
| `#{이름}` | 회원 이름 |
| `#{수강권}` | 수강권(상품) 이름. 예: 정규 클래스 8회권 |
| `#{남은횟수}` | 남은 횟수 숫자 |
| `#{기한}` | 수강권 마지막 날. 예: 2026-11-30 |
| `#{링크}` | 회원 페이지 주소. 예: https://도메인/m/xxxx |

### 1. 회원 페이지 안내 (LINK)

- 템플릿 이름: 회원 페이지 안내
- 환경변수: `SP_ALIMTALK_TPL_LINK`
- 변수: `#{이름}`, `#{링크}`
- 언제 나가나: 수강권이 새로 생길 때(결제 적재·수기 결제·회원 등록 시 자동 배정), 회원 상세의 "알림톡으로 링크 보내기" 버튼

```text
[THE DEPTH] 회원 페이지 안내

#{이름}님, THE DEPTH 회원 페이지를 보내드려요.

회원 페이지에서 수강권의 남은 횟수와 기한을 확인할 수 있어요.
출석할 때 회원 페이지의 QR 을 보여주세요.

회원 페이지: #{링크}

※ 수강 등록을 하셨거나 회원 페이지 발급을 요청하신 분께 보내는 안내예요.
```

### 2. 잔여 횟수 안내 (REMAINING)

- 템플릿 이름: 잔여 횟수 안내
- 환경변수: `SP_ALIMTALK_TPL_REMAINING`
- 변수: `#{이름}`, `#{수강권}`, `#{남은횟수}`, `#{기한}`, `#{링크}`
- 언제 나가나: 아직 자동 발송 없음(예정: 남은 횟수가 적을 때)

```text
[THE DEPTH] 잔여 횟수 안내

#{이름}님, #{수강권} 남은 횟수가 #{남은횟수}회예요.
기한: #{기한}까지

회원 페이지: #{링크}

※ 수강권을 이용 중인 회원께 보내는 안내예요.
```

### 3. 기한 만료 예정 안내 (EXPIRING)

- 템플릿 이름: 기한 만료 예정 안내
- 환경변수: `SP_ALIMTALK_TPL_EXPIRING`
- 변수: `#{이름}`, `#{수강권}`, `#{남은횟수}`, `#{기한}`, `#{링크}`
- 언제 나가나: 아직 자동 발송 없음(예정: 기한 3일 전)

```text
[THE DEPTH] 기한 만료 예정 안내

#{이름}님, #{수강권} 기한이 3일 뒤(#{기한})에 끝나요.
남은 횟수: #{남은횟수}회

회원 페이지: #{링크}

※ 수강권을 이용 중인 회원께 보내는 안내예요.
```

### 4. 전문반 갱신 안내 (PRO_RENEW)

- 템플릿 이름: 전문반 갱신 안내
- 환경변수: `SP_ALIMTALK_TPL_PRO_RENEW`
- 변수: `#{이름}`, `#{수강권}`, `#{기한}`, `#{링크}`
- 언제 나가나: 아직 자동 발송 없음(예정: 전문반 기한 전)

```text
[THE DEPTH] 전문반 갱신 안내

#{이름}님, 전문반 #{수강권} 기한이 #{기한}에 끝나요.
계속 수강하시려면 기한 안에 갱신 결제를 해 주세요.

회원 페이지: #{링크}

※ 전문반 수강권을 이용 중인 회원께 보내는 안내예요.
```

## 서버에 키 넣기

필요한 값 8개입니다. 하나라도 비어 있으면 꺼진 상태로 동작합니다.

| 환경변수 | 어디서 |
|---|---|
| `SP_ALIMTALK_API_KEY` | Solapi 콘솔 → API Key 관리 |
| `SP_ALIMTALK_API_SECRET` | 같은 곳(만들 때 한 번만 보입니다) |
| `SP_ALIMTALK_PF_ID` | 4번에서 받은 발신 프로필 ID |
| `SP_ALIMTALK_SENDER` | 3번에서 등록한 발신번호(숫자만, 예: 0212345678) |
| `SP_ALIMTALK_TPL_LINK` | 회원 페이지 안내 templateId |
| `SP_ALIMTALK_TPL_REMAINING` | 잔여 횟수 안내 templateId |
| `SP_ALIMTALK_TPL_EXPIRING` | 기한 만료 예정 안내 templateId |
| `SP_ALIMTALK_TPL_PRO_RENEW` | 전문반 갱신 안내 templateId |

서버에 접속해서 파일을 채웁니다. `deploy/bootstrap-host.sh` 가 빈 파일을 미리 만들어 둡니다(없으면 새로 만들면 됩니다).

```bash
sudo nano /etc/studiopass/alimtalk.env
```

```text
SP_ALIMTALK_API_KEY=NCS...
SP_ALIMTALK_API_SECRET=...
SP_ALIMTALK_PF_ID=KA01PF...
SP_ALIMTALK_SENDER=0212345678
SP_ALIMTALK_TPL_LINK=KA01TP...
SP_ALIMTALK_TPL_REMAINING=KA01TP...
SP_ALIMTALK_TPL_EXPIRING=KA01TP...
SP_ALIMTALK_TPL_PRO_RENEW=KA01TP...
```

권한을 잠그고 api 컨테이너를 다시 만듭니다. `docker compose restart` 는 env 파일을 다시 읽지 않으므로 반드시 `up -d --force-recreate` 로 합니다.

```bash
sudo chmod 600 /etc/studiopass/alimtalk.env
cd /srv/studiopass/app && sudo docker compose up -d --no-build --force-recreate api
sudo docker compose logs api | tail -3   # "studiopass api listening (alimtalk on)" 이 보이면 켜진 것입니다
```

확인: 관리자 화면에서 본인 전화번호로 테스트 회원을 만들고, 회원 상세의 "알림톡으로 링크 보내기" 를 눌러 카카오톡이 오는지 봅니다.
결과는 `sudo sqlite3 /srv/studiopass/data/studiopass.db "select kind,status,error,created_at from messages where channel='ALIMTALK' order by created_at desc limit 5"` 로 볼 수 있습니다.

### 끄기 (되돌리기)

문제가 알림톡 때문일 때만 끕니다. `/etc/studiopass/alimtalk.env` 에서 아무 값이나 하나(예: `SP_ALIMTALK_API_KEY`)를 비우거나 파일을 지우고, 위와 같은 `up -d --no-build --force-recreate api` 를 실행합니다. 1분 안에 끝나고, 화면은 다시 "링크 문자 보내기" 로 돌아갑니다. 데이터는 바뀌지 않습니다.

## 비용

- 알림톡은 건당 약 8~13원입니다(Solapi 충전 금액·요금제에 따라 다름). 쓰기 전에 Solapi 에 금액을 충전해 둡니다.
- 알림톡이 실패하면(카카오톡 미사용자 등) 등록한 발신번호로 문자가 대신 나가고, 이 문자 요금은 별도입니다. 안내 문구가 길어서 장문(LMS) 요금이 붙습니다.
- 지금은 수강권이 생길 때와 버튼을 누를 때만 나가므로, 한 달 수강 등록 건수만큼 나간다고 보면 됩니다.

## 기술 메모

- 발송 API: Solapi `POST https://api.solapi.com/messages/v4/send-many/detail` (`messages` 배열에 1건), 인증은 `Authorization: HMAC-SHA256 apiKey=..., date=..., salt=..., signature=...`.
- 코드: `server/src/notify/alimtalk.ts`(설정·발송·기록), `server/src/notify/templates.ts`(문구), `server/src/notify/link.ts`(링크 발급 후 발송, 수강권 생성 훅).
- 서버 로그에는 키, 전화번호, 이름, 본문을 남기지 않고 오류 코드만 남깁니다.
