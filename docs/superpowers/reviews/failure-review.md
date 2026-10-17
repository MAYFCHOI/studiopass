# studiopass failure review (feat/production @ c8295fb)

Reliability hunt for the ways the app breaks at a real studio: desk on phone/MacBook with flaky Wi-Fi, owner uploading OKPOS Excel, members opening a texted link, one 1GB Lightsail box. Method: read every server/route/domain file, the remote store, pages, member page, deploy tooling and runbook; built web + server; ran a local production-mode server on a temp DB (port 18282) and drove it with fetch probes; filled the DB with a synthetic year (300 members, 2,707 passes, 10,703 attendances); re-ran `src/lib/excel.ts` logic against xlsx with POS-style sheets. Server test suite: 83/83 pass.

Counts: **Critical 0 · High 6 · Medium 12 · Low 12**. Everything marked "confirmed" was reproduced; "unconfirmed" says what would confirm it.

---

## High

### H1. Scan page name search ignores the typed name and lists the first 6 members (confirmed)
- `src/pages/Scan.tsx:87`
  `s.members.filter((m) => m.name.includes(q.trim()) || m.phone.includes(q.replace(/\D/g, '')) || ...)`
  For any query without digits, `q.replace(/\D/g,'')` is `''` and `phone.includes('')` is `true`, so every member matches and `.slice(0,6)` returns the first six members by member number.
- Repro: members [회원A, 회원B, 김서연]; `scan('김서연')` → `['회원A','회원B','김서연']`; `scan('ㄱ')` → same three. `Members.tsx:538` does it right (`|| '\u0000'`).
- User sees: types a name on the 출석 page, gets an unrelated list; a tired desk taps the top row and the attendance (and the remaining count) lands on the wrong member. This is the only fallback when the camera fails or a member has no phone.
- Fix: copy the Members.tsx guard: `m.phone.includes(q.replace(/\D/g, '') || '\u0000')`.

### H2. Manual payment (직접 입력) double-tap creates two payments and two passes (confirmed)
- `src/pages/Payments.tsx:394-398` the 등록 button has no busy state and closes only in `.then`; `server/src/routes/payments.ts:546-562` has no idempotency key.
- Repro: two concurrent identical `POST /payments` → statuses `[200,200]`, member now has 2 payments, 2 passes, 16 remaining on an 8회권.
- User sees: "결제 등록, 수강권이 생겼어요" once, but the member has double credit and the owner's monthly total and settlement are inflated. Same pattern for 새 회원 등록 (`Members.tsx:561`, see M1) and the import 불러오기 button.
- Fix: disable the button while the request is in flight (local `busy` state), and server-side reject a MANUAL payment with the same `member_id, product_name, amount` within ~5 seconds (or accept a client `requestId` stored in `external_id`).

### H3. A refunded or wrongly linked payment cannot be undone from the UI; the pass stays usable (confirmed)
- `src/pages/Payments.tsx:87` the 취소 처리 button lives in the assign sheet, which opens only for queue items (no member or no pass). A payment that already has a pass offers only a chip to the member page; `Members.tsx:519-525` payment rows have no actions.
- `server/src/domain/payments.ts:72` `assignPayment` returns `{passId:null}` (HTTP 200) when the payment already has a pass, so reassigning to the right member is a silent no-op; the UI then toasts "연결했지만 상품명이 맞는 수강권 상품이 없어…" (`Payments.tsx:288`), which is wrong.
- Kiosk refunds: `payments.ts:95` only cancels when the refund row carries the **same** approval number. Probe P5: refund row with `externalId 'B2001-C'` → `{added:2, cancelled:0}`, original stays APPROVED, pass remaining 8, valid to 12-16. OKPOS-style exports commonly give the cancellation its own approval number (unconfirmed for this studio's export; a real refund row from the OKPOS admin web would confirm).
- User sees: member refunds at the kiosk, keeps the QR, keeps attending; settlement counts those attendances as revenue. Or the desk links a payment to the wrong 김민수 and has no way back.
- Fix: show 취소 처리 (and a 다른 회원으로 연결 that unassigns when the pass is unused) on linked payments in the 전체 tab and member detail; make `assignPayment` return 409 `ALREADY_LINKED` instead of 200; for refunds, also match a CANCELLED row against an APPROVED payment with same phone + amount + product within the same day when approval numbers differ, and surface unmatched refunds in the 확인 필요 queue instead of silently storing them.

### H4. No request timeout: on dead Wi-Fi the scanner silently freezes with the camera still running (confirmed by code)
- `src/api/client.ts:13` `fetch` with no `AbortSignal`; `src/pages/Scan.tsx:37-45` sets `busy.current = true` and only clears it when the spotlight is dismissed; the spotlight appears only after the promise settles.
- Repro path: phone associated to the AP but no uplink (`navigator.onLine` stays true, so `useOnline` says online). The POST hangs for the OS timeout (often 60 s+ on mobile). Every QR in the meantime is dropped by `if (busy.current) return;` with no feedback.
- User sees: camera live, QR in frame, nothing happens, no error, no offline bar. The desk re-aims, restarts the page; the queue of members grows.
- Fix: `signal: AbortSignal.timeout(8000)` in `api()`; map `AbortError`/`TimeoutError` to the OFFLINE reason; show a "처리 중…" badge while `busy`.

### H5. Excel column guess picks wrong columns on a POS-style header order, and the bad import poisons later re-imports (confirmed)
- `src/lib/excel.ts:21-31` `pick()` returns the first header containing any key. With headers `No, 영업일자, 승인일시, 승인번호, 결제구분, 상품명, 할인금액, 결제금액, 취소금액, 고객휴대폰` the guess is `amount: 할인금액`, `payerPhone: 승인번호`, `status: 결제구분` (probe E1). All rows import as 0원 with phone `30123456`, refunds (negative 결제금액) are not detected because the amount column is wrong.
- Because `ingestPayments` dedupes on `external_id` (`payments.ts:90-92`), re-uploading with the corrected mapping yields `dup` for every row; the wrong rows must be cancelled one by one (and H3 says they cannot be cancelled once linked).
- User sees: toast "N건 추가 · 자동 연결 0건", queue full of "일치 회원 없음", then a corrected upload says "0건 추가 (중복 N)".
- Fix: order keys by specificity and prefer exact/longer matches (`결제금액` > `금액`, exclude `할인|취소|부가|공급` for amount; exclude `승인번호` for phone); require the owner to confirm the mapping with a 3-row preview of parsed values (date, amount, phone) before 불러오기; remember the confirmed mapping per header signature in localStorage; add a server-side `POST /payments/import?dryRun=1` or a "최근 업로드 되돌리기" that cancels payments created by the last import batch (store `import_batch_id`).

### H6. Any invalid row rejects the whole 2,000-row chunk with a generic message (confirmed)
- `server/src/routes/payments.ts:541` `if (!b.rows.every(validRow)) return bad(c)`; `src/store/remote.ts:45` toasts "저장하지 못했어요. 다시 시도해 주세요".
- Repro P10: one row with a 101-char externalId → `400 BAD_REQUEST`, nothing stored.
- User sees: the import "fails", retrying fails the same way, no hint which row or column. Realistic triggers: a very long 승인번호/거래ID field, a 결제자 field over 50 chars (client slices names and product names but not externalId), a non-string status cell.
- Fix: validate per row and return `{rejected:[{index, reason}]}` while ingesting the valid rows; or at least echo the first failing row index in the 400 body and show it.

---

## Medium

### M1. Two members with the same phone silently disable auto-matching for that phone (confirmed)
- `server/src/routes/members.ts:331-350` no uniqueness check; `payments.ts:111-112` assigns only when `m.length === 1`.
- Repro P2: double submit of 이도윤 → `2026-0002` and `2026-0003`; import for that phone → `matched: 0`, queued.
- Fix: on `POST /members`, return 409 `PHONE_TAKEN` (with the existing member) unless `force: true`; in the form, warn "같은 번호 회원이 있어요" before saving; disable the submit button while in flight.

### M2. Toasts last 1.8 s and overwrite each other, so the import summary the runbook tells the owner to read is unreadable (confirmed by code)
- `src/components/Toast.tsx:744` fixed 1800 ms; the previous toast's timer clears the next one early.
- Example payload: "3건 추가 (중복 12) · 회원 자동 연결 2건 · 환불 1건 반영 · 환불 1건은 출석이 있어 확인 필요 · 결제 일시를 읽지 못한 4행은 건너뜀".
- Fix: duration proportional to length (min 3 s, ~60 ms/char), clear the pending timer on a new toast, and render the import result in a dismissable Sheet instead of a toast.

### M3. Sheets with a title row above the header cannot be mapped (confirmed)
- `src/lib/excel.ts:11-14` uses row 1 as headers. A sheet whose first row is "매출 상세 조회 (2026-10-01 ~ …)" yields headers `__EMPTY, __EMPTY_1…`, an empty guess, and a disabled 불러오기 (probe E2). The real header row becomes a data row and is dropped as `badDate`.
- Fix: detect the header row as the first row with ≥3 non-empty string cells matching known keys; or add a "헤더 행" selector in the mapping sheet.

### M4. Bootstrap is re-downloaded after every scan and grows without bound (confirmed)
- `src/store/remote.ts:82` `void refresh()` after each `attend`; `server/src/routes/bootstrap.ts:273` returns **all** passes ever, all members. Synthetic year: 1,090,268 bytes raw, 188,098 gzipped, 7 ms server time.
- Effect: ~190 KB per scan on studio Wi-Fi, several MB per class; on a phone with a weak signal the refresh fails or lands late, and `Today` counts lag. Passes are the growth driver (2,707 in a year at 300 members).
- Fix: window passes to `valid_to >= today - 62d` (or `remaining > 0 or valid_to >= since`), and after `attend` patch the local pass/attendance from the response instead of a full refresh (refresh on tab focus / every N minutes).

### M5. Validation and conflict errors surface as "다시 시도해 주세요" (confirmed)
- `remote.ts:45` maps every non-401 ApiError to the retry toast. Probe P7: product `count: 0` → 400, duplicate product name → 409 `DUPLICATE_NAME`; both show the retry message although retrying can never succeed.
- Fix: a small `ERRORS` map (`DUPLICATE_NAME` → "같은 이름의 상품이 있어요", `BAD_REQUEST` → "입력값을 확인해 주세요", `PASS_IN_USE`, `LOGIN_TAKEN`, `TOO_MANY`, `TOO_LARGE`) and show `e.body.error` when unknown.

### M6. Courses, products and instructors can never be removed or hidden; inactive courses still take attendance (confirmed)
- `src/pages/Settings.tsx` has no `active` toggle anywhere (grep: zero hits); server supports `active` (`owner.ts:437,450,464`). `attend()` (`attendance.ts:18`) does not check `course.active`; `Scan.tsx:15` does not filter inactive courses out of the strip. Probe Q1: course set `active:false` via API → attendance still `ok:true`.
- User sees: a mistyped 수업 추가 lives on the timetable and in the scan strip forever; a retired instructor stays in the list; a renamed kiosk product leaves the old one active and still matching (`findProduct` substring).
- Fix: add a 비활성 switch in the three edit sheets; hide inactive courses from Scan/Today/Timetable; return `UNKNOWN_COURSE` for inactive courses in `attend`.

### M7. While the api is restarting (deploy, reboot) the login screen says the password is wrong (confirmed by code)
- `remote.ts:61-66` `login` maps any `ApiError` other than 429 to `'INVALID'`; Caddy returns 502 (not a TypeError) while `api` is down. `load()` on 502 leaves `me=null` → login screen.
- User sees: "아이디나 비밀번호가 맞지 않아요" for ~30 s during each deploy; staff retype, and `LoginLimiter` (5 per 10 min) can then lock the real password out (probe Q11: correct password after 5 wrong → 429).
- Fix: treat status ≥ 500 as `online=false` ("서버에 연결할 수 없어요"), and do not count 5xx responses as login attempts.

### M8. Disk full or read-only data dir is invisible to monitoring until the 03:30 backup (confirmed by code)
- `server/src/routes/public.ts:592` healthz is `select 1`; writes fail with 500 `INTERNAL` → UI "저장하지 못했어요", scans fail with "출석을 넣지 못했어요". `deploy/healthcheck.sh` only hits healthz. ntfy for backup failure fires only if `NTFY_TOPIC` is set (`backup.sh:111`).
- Fix: healthz does `insert or replace into settings('healthz_at', now)` and reports `{ok, freeMb}` from `statfs`; healthcheck.sh alerts when `freeMb < 1000`; add a weekly "backup age" check (`aws s3 ls daily/ | tail -1` older than 2 days → notify).

### M9. Docker build cache on the host is never pruned (unconfirmed)
- `deploy/remote.sh:348` runs `docker image prune -f` (dangling images only). Each host build creates BuildKit cache layers (two `npm ci` stages, several hundred MB). On a 40 GB disk this is months, not days, but nothing bounds it. Confirm with `docker system df` after 5–10 deploys.
- Fix: `docker builder prune -f --keep-storage 2GB` in `prune_old`.

### M10. The 62-day bootstrap window hides older history without saying so (confirmed by data)
- `bootstrap.ts:274-275`. Synthetic DB: 10,703 attendances total, 1,703 in the window. Member detail 출석 기록 and 결제 lists (`Members.tsx:432-433`) are built from the window; a member whose last visit was 70 days ago shows "출석 기록 없음" in the list (`Members.tsx:546`); a payment from 3 months ago is not on the 전체 tab (which also caps at 100 rows), so it cannot be inspected or cancelled (ties to H3). Settlement correctly uses server data.
- Fix: label the lists "최근 62일" and add a "더 보기" that fetches `GET /members/:id/history`.

### M11. Re-issuing a link revokes the member's existing link instantly, and the member page then hides a QR that is still valid (confirmed)
- `links.ts:9` upsert replaces the token; probe P6: old token → 404 immediately, QR payload identical before/after (`AM2:<id>:<sig>` does not depend on the token). `Members.tsx:447-460` 링크 문자 보내기 on desktop reissues on every click with no confirmation; `MemberPage.tsx:486-493` shows "이 링크는 더 이상 쓸 수 없어요" with no QR.
- User sees: desk clicks 링크 문자 보내기 "to check", the member at the counter refreshes and loses the QR and the home-screen shortcut.
- Fix: keep the previous token valid for 24 h (two rows or `prev_token_hash`), or ask "예전 링크는 바로 막혀요. 다시 보낼까요?"; on 404 keep showing the cached QR with the notfound message.

### M12. Assign on a CANCELLED payment returns 200 `{passId:null}` and the UI reports a product-name mismatch (confirmed)
- `payments.ts:72`, probe P8. The 전체 tab hides the 회원 연결 chip for cancelled rows, but the assign sheet can still be open from a stale list after another device cancelled it.
- Fix: return 409 `PAYMENT_CANCELLED` / `ALREADY_LINKED`; map in the UI.

---

## Low

- **L1. Validity is inclusive, so a 30-day product is usable for 31 days** (`payments.ts:65` `addDays(from, period_days)` + `attendance.ts:11` `valid_to >= today`). Probe P11: 60-day product → `validFrom 2026-10-17`, `validTo 2026-12-16`, both usable. Decide and state it in Settings ("기간(일), 결제일 포함"); or store `addDays(from, period_days - 1)`.
- **L2. Fixing a member's phone does not pick up waiting payments** (`members.ts:352-360`; probe Q6 `memberId:null`). Only `POST /members` does. Run the same open-payment loop on PATCH when the phone changed.
- **L3. Kiosk product names with different whitespace do not match** ("정규 클래스  1회권" / "정규클래스 1회권" → 상품 미확인, probe Q8; `payments.ts:57-59`). Compare with `replace(/\s+/g,'')`.
- **L4. Substring matching can pick the wrong product** when one name is a suffix of another ("1회권" matches "11회권"); longest-match protects the common cases (probe Q9 picked "11회권 (이벤트)" correctly). Prefer word-boundary matches or require exact after whitespace normalisation, fall back to substring with a 상품 미확인 flag.
- **L5. ErrorBoundary shows "데모 데이터로 초기화" in production** (`ErrorBoundary.tsx:850`); it just clears a demo localStorage key and reloads. Hide unless `IS_DEMO`.
- **L6. Login limiter keeps the correct password locked for 10 min after 5 wrong tries** (probe Q11 → 429); in-memory, so a `compose restart api` clears it. Acceptable, but say "N분 뒤" in the message, and see M7.
- **L7. Retrying a scan whose response was lost shows "오늘 이 수업은 이미 출석했어요" without the remaining count** (`attendance.ts:20`). Return the existing attendance's pass info with `ALREADY` so the spotlight can show "이미 출석 · 남은 횟수 7".
- **L8. Date strings with 오전/오후 or `DD-MM-YYYY` are dropped as badDate** (probe E5 → `null`). Add a pre-parse for `(오전|오후)\s*(\d+):` and `YYYY.MM.DD` is handled; `20261017140321` works.
- **L9. Tiers and staff have API routes but no screen** (`owner.ts:479-519`; Settings has none). Desk accounts, password resets and tier edits need ssh + CLI, per runbook. Acceptable for launch; document that the owner cannot reset a desk password alone.
- **L10. Cookie `maxAge` is fixed at 30 days while the server session slides** (`auth.ts:236` vs `sessions.ts:22`), so every device re-logs in on day 30 even if used daily. Re-set the cookie on `/bootstrap` responses.
- **L11. Public token lookup is not constant-time as the spec says** (spec §5 "응답 지연 일정"; `public.ts:593-597`, 50 bad lookups in 10 ms). 128-bit tokens make this moot; drop the spec line or add a 150 ms floor.
- **L12. The member page depends on jsDelivr and Google Fonts** (`member.html` links). Offline/blocked CDN → system font (display=swap), page still works; note only.

---

## Scenarios that held up

- Two devices scanning the same member for the same course concurrently: one `ok`, one `ALREADY`, remaining decremented once (unique partial index `attendances_once` + sync transaction).
- Re-uploading the same kiosk file: all rows `dup`, nothing changes (externalId or phone|paidAt|amount key).
- Refund row with the **same** approval number, whether before or after the approval row in the file (P5b): net status CANCELLED, no pass.
- Refund of a pass that already has attendances: 409 `PASS_IN_USE`, pass kept, UI tells the desk to cancel the attendance first (Q4).
- PRO course with only COUNT passes → `PRO_ONLY`; expired/empty precedence picks the latest pass's state.
- Instructor changed on a course mid-month: earlier attendances stay with the old instructor in settlement (Q2).
- Month boundaries in settlement use KST for attendances and UTC-9 shifted bounds for payments; unit tests cover the 2026-06-30T16:00Z → July case.
- Migration runner: each file in its own transaction; a failed migration exits the process, healthz fails, deploy auto-rolls back; the pre-deploy backup is taken before `compose up`.
- Restore path removes `-wal/-shm`, re-chowns to uid 1000, checks `integrity_check` before swapping.
- Containers `restart: unless-stopped`; Docker enabled at boot; Caddy keeps certs in a named volume; ports 80/443 open for ACME renewals.
- Container logs capped 10 MB × 3; backup log is a few lines per day.
- Query plans: `members(phone)`, `attendances(attended_on)` and the partial unique index cover the hot paths; payments scans are over hundreds of rows a year. Bootstrap server time 7 ms with a year of data.
- WAL grows to the largest transaction (4 MB after the bulk insert) and is checkpointed by better-sqlite3's default; `sqlite3 .backup` from the host includes WAL content.
- DESK responses carry no `price`/`amount` keys (P13); DESK can still enter cash payments as designed.
- Session loss mid-shift: any 401 drops to the login screen and clears state; logout invalidates the server row (Q10).
- `/m/<token>` serves `member.html` with `Cache-Control: no-cache` and `Referrer-Policy: no-referrer`; hashed assets are immutable; HTML revalidates so a deploy takes effect on next load.
- Member page polls every 30 s only while visible, caches the last payload per token, and shows the cached QR when offline.
- Numeric phone cells (1020003100) and "180,000원" strings parse correctly; the app's own sample CSV (with BOM) round-trips; Excel Date cells come out in the browser's local time (KST) correctly.
- Footer "합계" rows are dropped as badDate and counted in the toast.

## Probe artefacts
Temporary server, DB and scripts lived under the session scratchpad and were removed after the run. No repo files were modified.
