# studiopass 운영 런북

Lightsail 서울 인스턴스 1대(Ubuntu 24.04, 1GB) 위에서 Docker Compose 로 `api`(Node, 내부 8787) 와 `caddy`(80/443, Let's Encrypt) 를 돌립니다. 맥에는 Docker 가 없어도 됩니다. 이미지는 서버에서 빌드합니다.

## 구성 한눈에

| 항목 | 값 |
|---|---|
| 리전 / AZ | ap-northeast-2 / ap-northeast-2a |
| 인스턴스 | `studiopass-1`, blueprint `ubuntu_24_04`, bundle `micro_3_0` (1GB RAM, 2 vCPU, 40GB, IPv4 포함, 월 7달러, 2026-10-17 `get-bundles` 조회) |
| 고정 IP | `studiopass-ip` (붙어 있으면 무료) |
| 방화벽 | Lightsail 22/80/443 + ufw 22/80/443, SSH 비밀번호 로그인 끔 |
| 백업 버킷 | `studiopass-backup-<랜덤6>`, bundle `small_1_0` (5GB, 월 1달러). 이름은 맥의 `~/.studiopass/bucket-name` |
| AWS 프로파일 | `personal-ops` 만. 스크립트가 `AWS_CONFIG_FILE=~/personal/.aws/config AWS_SHARED_CREDENTIALS_FILE=~/personal/.aws/credentials` 를 강제합니다 |
| 서버 디렉터리 | `/srv/studiopass/app` (CURRENT_TAG 의 compose, Caddyfile, 스크립트, crontab, `.env`), `app.prev/` (PREV_TAG 의 같은 파일들), `data/` (SQLite, uid 1000), `src/<tag>/` (배포한 소스), `backups/`, `CURRENT_TAG`, `PREV_TAG` |
| 비밀 | 서버 `/etc/studiopass/backup.env` (버킷 전용 키), `/etc/studiopass/alerts.env` (`NTFY_TOPIC=`), `/etc/studiopass/alimtalk.env` (알림톡 키, 비어 있으면 꺼짐, docs/ALIMTALK.md), 모두 600 |
| cron | `/etc/cron.d/studiopass`: 18:30 UTC(03:30 KST) 백업, 5분마다 헬스체크 |
| 로그 | `/var/log/studiopass-backup.log`, `docker compose logs api` (컨테이너 로그는 10MB x 3 로 순환) |

## 비용 (월, 2026-10-17 기준)

| 항목 | 달러 | 원(1,400원/달러) |
|---|---|---|
| 인스턴스 micro_3_0 | 7.00 | 약 9,800 |
| 버킷 small_1_0 | 1.00 | 약 1,400 |
| 도메인 thedepthdance.com (연 16달러) | 1.33 | 약 1,900 |
| 자동 스냅샷 (켰을 때, 최근 7개 x 사용량 GB x 0.05달러) | 0.5 안팎 | 약 700 |
| 합계 | 약 9.8 | 약 1.4만 원 |

설계 문서의 "월 약 1.1만 원" 은 5달러 번들 기준이었습니다. 지금 IPv4 가 붙은 1GB 번들은 7달러짜리 하나뿐입니다(`micro_ipv6_3_0` 5달러는 IPv4 가 없어 쓰지 않습니다).

## 첫 배포 (한 번)

1. 도메인을 Route53 에서 삽니다(사용자 확인 후). 호스팅 영역이 같이 생깁니다.
2. 인프라를 만듭니다. 비용이 드는 단계마다 `계속할까요? (y/N)` 를 묻고, 다시 돌려도 있는 것은 건너뜁니다.
   ```bash
   scripts/provision.sh --domain thedepthdance.com
   ```
   결과: `~/.ssh/studiopass.pem`(600), `~/.studiopass/backup.env`(600, 버킷 키), 마지막에 출력되는 `~/.ssh/config` 블록을 붙여 넣습니다(`Host studiopass`).
3. 서버를 초기화합니다(docker, 2GB swap, ufw, SSH 키 전용, unattended-upgrades, aws cli, cron).
   ```bash
   scp -r deploy studiopass:/tmp/sp-deploy
   ssh studiopass sudo bash /tmp/sp-deploy/bootstrap-host.sh thedepthdance.com
   ```
4. 비밀을 넣습니다.
   ```bash
   scp ~/.studiopass/backup.env studiopass:/tmp/backup.env
   ssh studiopass 'sudo install -m 600 /tmp/backup.env /etc/studiopass/backup.env && rm /tmp/backup.env'
   ssh studiopass 'echo "NTFY_TOPIC=<개인 토픽>" | sudo tee /etc/studiopass/alerts.env >/dev/null'
   ```
5. 배포합니다(서버 빌드라 5~10분).
   ```bash
   scripts/deploy.sh
   ```
6. 원장 계정을 만듭니다. 비밀번호는 화면에 안 보이게 읽어 표준입력으로 넘깁니다(셸 기록·프로세스 목록에 안 남음).
   ```bash
   ssh -t studiopass 'read -rs -p "password: " P; echo; cd /srv/studiopass/app && printf "%s\n" "$P" | sudo docker compose exec -T api node server/dist/server/src/cli.js create-owner <loginId> <이름>'
   ```
   인포 계정은 `create-desk <loginId> <이름>`, 비밀번호 재설정은 `reset-password <loginId>` 입니다.
7. 확인: `https://thedepthdance.com/api/healthz` 가 `{"ok":true}`, 다음 날 아침 백업 로그에 `OK s3 daily/...` 가 있는지 봅니다.

## 첫 배포 순서 (실사용 시작 전 점검)

위 "첫 배포" 를 마친 뒤 이 순서로 실제 운영 데이터를 맞춥니다. 순서가 중요합니다: 상품명이 맞기 전에 키오스크 파일을 올리면 회원만 연결되고 수강권이 안 생깁니다("결제 > 확인 필요" 에 "상품 미확인" 으로 남습니다. 상품명을 고친 뒤 "다시 연결" 하면 됩니다).

1. 배포: `scripts/deploy.sh`, `https://<도메인>/api/healthz` 가 `{"ok":true}`.
2. 원장 계정 만들기(위 6번 `create-owner`).
3. 원장으로 로그인해 설정 > 수강권 상품의 기본 4개(정규 클래스 1회권/4회권/8회권, 전문반 월정액) 이름을 **키오스크 관리 웹의 상품명과 글자 그대로** 바꾸고 실제 가격·회차·기간을 넣습니다. 상품을 한 번 저장하면 "예시값" 안내가 사라집니다. 강사 정산 조건도 이때 실제 값으로.
4. 인포 계정 만들기: 위 6번 명령에서 `create-owner` 대신 `create-desk <loginId> <이름>`.
5. 첫 키오스크 파일 올리기: 결제 > 키오스크 엑셀 올리기. 완료 토스트의 "추가 / 중복 / 자동 연결 / 환불 반영" 숫자를 확인하고, "확인 필요" 탭에 남은 결제(번호 불일치, 상품 미확인)를 정리합니다. 결제 일시를 읽지 못한 행은 건너뛰고 토스트에 행 수가 나옵니다.
6. 문자 링크 확인(아이폰 1대): 회원 상세 > 문자로 링크 보내기. 메시지 앱에 본문이 채워지는지 봅니다. iOS 는 `sms:<번호>&body=` 형식을 읽고(화면이 아이폰을 알아보고 이 형식을 씁니다), 안드로이드는 `?body=` 입니다. 본문이 비어 있으면 iOS 버전을 적어 두고 링크 복사로 대신 보냅니다.
7. 회원 홈 화면 바로가기 확인(안드로이드 1대, 아이폰 1대): 받은 링크(`/m/<토큰>`)를 열고 "홈 화면에 추가" 합니다. 바로가기를 눌렀을 때 직원 로그인 화면이 아니라 그 회원 페이지(QR)가 열리고 아이콘이 THE DEPTH 로고인지 봅니다. 링크를 재발급하면 예전 바로가기는 막히니 다시 추가해야 합니다.

## 평소 배포

```bash
git commit ...           # 커밋된 HEAD 만 나갑니다. 커밋 안 한 변경은 경고만 하고 빠집니다
scripts/deploy.sh
```

`scripts/deploy.sh` 가 하는 일:

1. `git archive HEAD` 를 ssh 로 보내 서버 `/srv/studiopass/src/<git short sha>/` 에 풉니다.
2. 서버에서 `docker compose build` 로 `studiopass:<sha>` 를 만듭니다. 빌드가 실패하면 아무것도 바뀌지 않습니다.
3. 배포 전 백업: `/srv/studiopass/backups/pre-deploy/<KST날짜>-<UTC시각>-<sha>.db.gz` (최근 5개 보관) + 버킷 `pre-deploy/` 에 업로드(업로드 실패는 경고만, 로컬 사본이 있으면 계속). 로컬 백업이 실패하면 배포를 멈춥니다.
4. 지금 태그를 `/srv/studiopass/PREV_TAG` 에 적고 새 태그로 `docker compose up -d`.
5. 컨테이너 안에서 `/api/healthz` 를 최대 60초 확인합니다. `compose up` 이 실패하거나 헬스체크가 실패하면 자동으로 이전 버전으로 되돌립니다. 이미지뿐 아니라 compose, Caddyfile, 스크립트, crontab 도 배포 전 것(`app.pre/` 에 잠시 보관)으로 되돌립니다. ntfy 는 "studiopass 배포 실패, 이전 버전으로 되돌림", 되돌리기까지 실패하면 "studiopass 배포 실패, 되돌리기도 실패" 입니다.
6. 성공하면 `CURRENT_TAG` 를 갱신하고, 배포 전 `app/` 을 `app.prev/` 로 옮기고, 오래된 소스·이미지를 정리합니다(최근 3개 + CURRENT/PREV 는 남김).
7. Caddyfile 을 적용합니다. `compose up` 은 Caddyfile 만 바뀐 경우 caddy 를 다시 만들지 않기 때문입니다. 컨테이너 안 Caddyfile 이 새 파일과 같으면 `caddy reload`, 다르면(파일 하나짜리 bind mount 라 예전 파일을 붙잡고 있는 경우) `docker compose restart caddy`(1초 안팎 끊김)를 합니다. 적용 전에 새 Caddyfile 을 임시 caddy 컨테이너로 `caddy validate` 합니다. 검증이 실패하면 적용하지 않고(돌던 caddy 는 예전 설정 그대로) `WARNING: new Caddyfile failed 'caddy validate'` 를 남기고 ntfy "studiopass 설정 확인 필요" 를 보냅니다. 이때 서버 디스크의 `app/Caddyfile` 은 이미 새 파일이라, 고치지 않은 채 서버가 재부팅되면 caddy 가 못 뜹니다. 바로 고쳐서 다시 배포하거나 `--rollback` 합니다. 적용이 실패해도 배포는 성공으로 두고 `WARNING: caddy ...` 만 남깁니다. 그때는 `ssh studiopass 'cd /srv/studiopass/app && sudo docker compose restart caddy'` 로 직접 적용합니다. 롤백(자동·수동) 뒤에도 같은 단계를 거칩니다.

빌드나 배포 전 백업이 실패해도 `app/` 은 배포 전 상태로 돌아갑니다.

상태 보기: `scripts/deploy.sh --status` (CURRENT/PREV 태그, 컨테이너, 최근 배포 전 백업, 백업 로그).

## 롤백과 복원

**발동 조건: 문제가 이번 배포 때문일 때만 씁니다.** 배포와 무관한 장애(인증서, 디스크, 네트워크, AWS 장애)에 롤백부터 돌리지 않습니다. 먼저 `--status` 와 `docker compose logs api` 로 원인이 새 버전인지 확인합니다. 배포 직후부터 시작된 오류이고 이전 버전에서는 없던 것이면 롤백합니다.

| 상황 | 명령 | 데이터 | 시간 |
|---|---|---|---|
| 새 버전이 헬스체크를 못 넘김 | (자동) deploy.sh 가 PREV_TAG 로 되돌림 | 그대로 | 1분 안 |
| 새 버전은 뜨지만 기능이 깨짐 | `scripts/deploy.sh --rollback` | 그대로 | 약 1분 |
| 새 버전이 데이터를 망가뜨림 | `--rollback` 후 `scripts/deploy.sh --restore pre-deploy` | 배포 이후 데이터 사라짐 | 약 2분 |
| DB 파일 손상, 실수로 지운 데이터 | `scripts/deploy.sh --restore YYYY-MM-DD` | 그 날 03:30 이후 데이터 사라짐 | 약 2~3분 |

- `--rollback` 은 `app/` 과 `app.prev/` 를 맞바꾸고(compose, Caddyfile, 스크립트, crontab 이 이전 버전 것으로 돌아감) `/srv/studiopass/PREV_TAG` 의 이미지로 compose up 합니다. DB 는 건드리지 않습니다. 롤백 뒤 CURRENT/PREV 와 `app/`/`app.prev/` 가 서로 바뀌므로, 한 번 더 `--rollback` 하면 다시 앞 버전으로 갑니다. compose up 이 실패하면 파일을 다시 맞바꿔 놓고 멈춥니다.
- 이전 이미지가 서버에 있어야 합니다(`docker image ls studiopass`). 정리 단계가 CURRENT/PREV 이미지는 지우지 않습니다.
- 새 버전이 DB 마이그레이션을 추가했다면 `--rollback` 뒤에도 마이그레이션은 남습니다. 지금 마이그레이션은 테이블·컬럼 추가만 하므로 이전 코드가 대개 그대로 돕니다. 이전 코드가 새 스키마로 안 돌면 `--restore pre-deploy` 가 필요합니다.
- **`--restore` 는 백업 시점 이후에 들어온 출석·결제·회원 변경을 잃습니다. 마지막 수단입니다.** 실행하면 `restore <대상>` 을 그대로 입력하라고 묻고, 바꾸기 전에 지금 DB 를 `/srv/studiopass/backups/pre-restore/` 에 따로 저장합니다. 복원을 되돌리려면 그 파일을 같은 방법(서버에서 api 정지 후 `data/studiopass.db` 교체, `-wal`/`-shm` 삭제, uid 1000 소유)으로 다시 넣습니다.
- 백업 위치: 일일 = 버킷 `daily/YYYY-MM-DD.db.gz` (KST 날짜, 30일 보관), 배포 전 = 서버 `/srv/studiopass/backups/pre-deploy/` (최근 5개) + 버킷 `pre-deploy/` (30일).

## 백업 확인

```bash
ssh studiopass 'tail -n 5 /var/log/studiopass-backup.log'
ssh studiopass 'sudo bash -c ". /etc/studiopass/backup.env; export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_DEFAULT_REGION; aws s3 ls s3://\$BUCKET/daily/ | tail -n 3"'
ssh studiopass 'sudo /srv/studiopass/app/backup.sh daily && tail -n 1 /var/log/studiopass-backup.log'   # 지금 한 번 돌리기
```

백업은 `sqlite3 .backup` 으로 떠서 `PRAGMA integrity_check` 가 `ok` 일 때만 올립니다. 실패하면 ntfy "studiopass 백업 실패" 가 옵니다.

분기에 한 번은 복원 연습을 합니다: 버킷에서 하나 받아 맥에서 `gunzip` 후 `sqlite3 x.db "select count(*) from members"` 로 열리는지 봅니다.

## 알림

| 알림 | 언제 |
|---|---|
| studiopass 백업 실패 | 일일 백업 실패(DB 없음, .backup 실패, 무결성 실패, 업로드 실패) |
| studiopass 응답 없음 | `https://<도메인>/api/healthz` 가 5분 간격으로 2번 연속 실패 |
| studiopass 응답 회복 | 위 알림 뒤 처음 성공 |
| studiopass 배포 실패(, 이전 버전으로 되돌림) | deploy.sh 의 헬스체크 게이트 실패 |
| studiopass 설정 확인 필요 | 배포한 Caddyfile 이 `caddy validate` 를 못 넘겨 적용하지 않음(위 "평소 배포" 7번) |

토픽은 서버 `/etc/studiopass/alerts.env` 에만 있습니다. 본문에 IP·도메인·회원 정보를 넣지 않습니다. 헬스체크 상태 파일은 `/var/lib/studiopass/health` 입니다.

## 기기를 잃어버렸을 때

인포 태블릿이나 원장 휴대폰을 잃어버렸거나, 그만둔 직원이 로그인된 기기를 갖고 있을 때 씁니다. 로그인은 30일 동안 안 쓰면 끝나고, 계속 써도 로그인한 지 90일이 지나면 끝납니다. 그 전에 끊으려면 아래 둘 중 하나를 합니다. 둘 다 그 계정의 모든 기기 로그인을 바로 지웁니다.

| 상황 | 명령 | 결과 |
|---|---|---|
| 인포 기기 분실, 인포 계정을 계속 쓸 것 | `reset-password <인포 loginId>` | 비밀번호가 바뀌고 모든 기기가 로그아웃. 남은 기기에서 새 비밀번호로 다시 로그인 |
| 그만둔 직원 계정, 당분간 아무도 안 씀 | `deactivate <loginId>` | 로그인 막힘 + 모든 기기 로그아웃. 다시 쓰려면 `activate <loginId>` |
| 원장 기기 분실 | `reset-password <원장 loginId>` | 원장 비밀번호가 바뀌고 모든 기기 로그아웃 |

비밀번호를 바꾸는 명령(비밀번호는 화면에 안 보이게 읽어 표준입력으로 넘깁니다):

```bash
ssh -t studiopass 'read -rs -p "password: " P; echo; cd /srv/studiopass/app && printf "%s\n" "$P" | sudo docker compose exec -T api node server/dist/server/src/cli.js reset-password <loginId>'
```

계정 막기·풀기(비밀번호 필요 없음):

```bash
ssh studiopass 'cd /srv/studiopass/app && sudo docker compose exec -T api node server/dist/server/src/cli.js deactivate <loginId>'
ssh studiopass 'cd /srv/studiopass/app && sudo docker compose exec -T api node server/dist/server/src/cli.js activate <loginId>'
```

출력이 `password reset for <loginId>; sessions cleared` 또는 `<loginId> deactivated; sessions cleared` 면 끝입니다. 세 명령 모두 접속기록(`audit_log`)에 `staff.password_reset` / `staff.update` 로 남습니다. 잃어버린 기기에서 그 사이 누가 무엇을 봤는지는 아래 "접속기록 보기" 로 확인합니다.

## 접속기록 보기

로그인 성공(`auth.login`), 로그인 실패(`auth.login_fail`, 입력한 아이디와 IP. 비밀번호는 남기지 않음), 로그아웃(`auth.logout`), 정산 화면 조회(`settlement.view`), 정산 엑셀 받기(`settlement.export`), 회원 정보 삭제(`member.erase`), 결제자 정보 삭제(`payment.erase_payer`) 와 기존 변경 기록(회원 등록·수정, 결제, 출석 취소 등)이 `audit_log` 에 쌓입니다. 시각은 UTC 로 저장됩니다.

**보관: 지우지 않습니다.** 자동 삭제 작업이 없고, 개인정보 안전성 확보조치 기준의 접속기록 보관(최소 1년)을 이 테이블로 채웁니다. DB 를 복원하면 백업 시점 이후의 기록은 사라지니 복원은 마지막 수단으로 둡니다(위 "롤백과 복원"). 한 달에 한 번 지난달 기록을 훑어 모르는 IP 의 로그인, 반복된 로그인 실패, 예상하지 못한 정산 엑셀 받기가 없는지 봅니다.

원장 계정으로 로그인한 브라우저에서 주소창에 바로 엽니다(JSON 으로 보입니다. 날짜는 한국 날짜, 양 끝 포함, 최신순 100건):

```
https://<도메인>/api/audit?from=2026-10-01&to=2026-10-31
```

`limit=500` 까지 늘릴 수 있고, 응답 끝의 `next` 값이 있으면 `&before=<next 값>` 을 붙여 다음 쪽을 엽니다. 인포 계정은 403 입니다.

서버에서 표로 보기(한국 시각으로 바꿔 보여 줌):

```bash
ssh studiopass "cd /srv/studiopass/app && sudo docker compose exec -T api sqlite3 -header -column /data/studiopass.db \"select datetime(a.at,'+9 hours') kst, coalesce(s.login_id,'-') who, a.action, a.ip, a.detail_json from audit_log a left join staff s on s.id=a.staff_id where a.at >= '2026-09-30T15:00:00Z' and a.at < '2026-10-31T15:00:00Z' order by a.at\""
```

(`2026-09-30T15:00:00Z` 가 한국 시각 10월 1일 0시입니다.)

## 개인정보 파기

회원이 탈퇴하거나 삭제를 요청하면 원장 계정으로 회원 상세 > 개인정보 > "회원 정보 삭제" 를 누르고 확인합니다. 이름은 "삭제된 회원" 으로 바뀌고 전화번호·메모, 회원 페이지 링크, 그 회원 결제의 결제자 이름·전화가 지워집니다. 출석 기록, 수강권, 결제 금액은 정산과 법정 보관(결제 기록 5년)을 위해 남으므로 정산 숫자는 바뀌지 않습니다. 지운 회원은 출석 체크가 안 되고 예전 링크는 열리지 않습니다. 되돌릴 수 없습니다.

회원과 연결되지 않은 키오스크 결제(비회원 결제)의 이름·전화는 결제 > 확인 필요 > 그 결제 > "결제자 정보 삭제" 로 지웁니다.

지운 정보는 일일 백업(30일 보관)과 배포 전 백업에 그 기간 동안 남아 있다가 순환되며 사라집니다. 처리방침 초안은 `docs/PRIVACY.md` 입니다.

## 자주 쓰는 명령

```bash
ssh studiopass 'cd /srv/studiopass/app && sudo docker compose ps'
ssh studiopass 'cd /srv/studiopass/app && sudo docker compose logs --tail 100 api'
ssh studiopass 'cd /srv/studiopass/app && sudo docker compose logs --tail 100 caddy'   # 인증서 발급 문제
ssh studiopass 'free -m; df -h /'
```
