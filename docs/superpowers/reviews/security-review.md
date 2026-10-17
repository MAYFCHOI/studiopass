# studiopass security & personal-data review

Branch `feat/production` @ `c8295fb`, reviewed 2026-10-17. Scope: server (Hono + better-sqlite3), admin SPA, member page, deploy/ and scripts/, docs/RUNBOOK.md, spec §4.
Method: full read of server/src, deploy/, scripts/, member page and the import/export code; `npm audit --omit=dev` in root and server/; `npx vitest run` (83/83 pass); a production-mode build run locally on port 18181 against a throwaway DB (`SP_ORIGIN=http://localhost:18181`), probed with curl as anonymous, DESK and OWNER. The temp DB and cookie jars were deleted afterwards. No repo files were modified.

Threat model used: internet attacker reaching the domain; a member holding their own `/m/<token>` link; a DESK account that must not see money; a lost or shared desk device.

Counts: Critical 0, High 0, Medium 5, Low 13.

---

## Medium

### M1. Login endpoint can be used to exhaust CPU/memory; limiter is per `ip|loginId` only
- Where: `server/src/routes/auth.ts:37-41`, `server/src/auth/rateLimit.ts:1-6`, `server/src/auth/password.ts:2-3`
- Scenario: An internet attacker POSTs `/api/auth/login` with a different `loginId` each time (`user1`, `user2`, ...). The limiter key is `${ip}|${loginId}`, so no request is ever throttled. Every request, including unknown ids, runs one scrypt with N=32768, r=8 (32 MB RAM, tens of ms CPU on the 1 vCPU / 1 GB Lightsail host). The libuv threadpool (4 threads) saturates, logins for real staff time out, and the whole API slows (better-sqlite3 shares the event loop). The `Map` in `LoginLimiter` also grows by one entry per distinct key and is never evicted except on a later hit for the same key.
- Evidence: probe A6/A7: 5 wrong tries on `owner` gave `401 401 401 401 429`, but the same attempts with a rotated `X-Forwarded-For` (which Caddy replaces, so only loginId rotation matters in prod) went `401 401 401`; probe A15: 60 parallel unknown-id logins all reached scrypt (none 429). On the Mac this took 1 s; cost on the Lightsail host is **unconfirmed** (confirm by running the same loop against the real host once and watching `docker stats`).
- Also note: because the lock is `ip|loginId`, a locked-out owner cannot log in from the same IP for 10 minutes even with the right password (probe A8 returned 429), while an attacker on another IP is unaffected. Per-account protection is weak and self-DoS is possible on a shared studio Wi-Fi.
- Smallest fix: add a second limiter keyed by IP only (e.g. 30 attempts / 10 min) checked before scrypt, and a third keyed by loginId only (e.g. 20 / 10 min) so a single account cannot be sprayed from many IPs; cap the Map (evict oldest when > 10k keys). Optionally lower scrypt to N=16384 and add a small global concurrency gate (e.g. at most 2 verifications in flight, others wait or 429).

### M2. `xlsx` 0.18.5 has two unpatched advisories and parses untrusted files
- Where: `package.json` (`"xlsx": "^0.18.5"`), `src/lib/excel.ts:9-16` (`XLSX.read(buf, ...)`)
- Scenario: Staff imports the kiosk export. A crafted .xlsx/.xls (from a compromised kiosk vendor export, a phishing mail "정산 파일", or a member-supplied file) triggers GHSA-4r6h-8v6p-xvw6 (prototype pollution) or GHSA-5pgg-2g8v-p4x9 (ReDoS) in the staff's browser. Prototype pollution in the admin SPA can be chained into script execution in a logged-in OWNER session (full data access, payment edits). Likelihood is low for a single studio; impact is the whole admin session.
- Evidence: `npm audit --omit=dev` (root): `xlsx * Severity: high ... No fix available`. Installed 0.18.5. Server audit: 0 vulnerabilities.
- Smallest fix: install SheetJS 0.20.3 from its own CDN (`npm i https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`) which fixes both, or switch to `exceljs`. Keep parsing in the browser (it already is), so the server never touches the file.

### M3. Sessions never expire absolutely; 30-day persistent cookie on a shared desk device; lost-device procedure not written down
- Where: `server/src/auth/sessions.ts:5` (`TTL = 30 * DAY`), `sessions.ts:22` (expiry re-extended on every request), `server/src/routes/auth.ts:45` (`maxAge: 30 * 86400`), `docs/RUNBOOK.md` (no section on lost device / revoking sessions)
- Scenario: The desk tablet is stolen or taken home by a former part-timer. The cookie is persistent and sliding, so as long as the app is opened once every 30 days the session lives forever and shows every member's name, phone, memo and attendance. The owner has no screen to see or kill sessions. The working remedy today (deactivate the DESK account, then reactivate: `PATCH /api/staff/:id {active:false}` deletes its sessions, confirmed in probe C7) exists only as an API route; there is no UI for staff management (`src/pages/Settings.tsx` has no staff section) and the runbook does not mention it. If the lost device was logged in as OWNER, the only remedy is `cli.js reset-password` over SSH, which the runbook mentions only as a password-reset tool.
- Evidence: `set-cookie: sp_session=...; Max-Age=2592000; Path=/; HttpOnly; Secure; SameSite=Lax` (probe C1); `getSession` updates `expires_at = now + TTL` on every call.
- Smallest fix: add an absolute cap (`created_at + 90d`) in `getSession`; give DESK a shorter idle TTL (e.g. 14 days) than OWNER; add a runbook section "기기 분실 시" with the two commands (deactivate+reactivate DESK via API or a new `cli.js revoke-sessions <loginId>` subcommand that runs `delete from sessions where staff_id=?`). A "다른 기기 로그아웃" button in Settings for OWNER is the better medium-term fix.

### M4. No way to delete or anonymize a member or a non-member payer (개인정보 파기 의무)
- Where: `server/src/routes/members.ts` (POST/PATCH only, no DELETE), `server/src/routes/payments.ts` (payer name/phone kept indefinitely), `server/migrations/001_init.sql:3,9`
- Scenario: A member quits and asks the studio to delete their data (정보주체의 삭제 요구, 개인정보보호법 §36) or the studio no longer needs it (§21 파기, "지체 없이", in practice within 5 business days). The app has no route, no UI and no CLI to delete or mask `members.name/phone/memo`, `payments.payer_name/payer_phone`, `member_links`, `messages`. Kiosk rows for people who never became members keep their phone forever (`payments where member_id is null`). The only option is hand-editing SQLite on the host, which bypasses audit and FK rules (`attendances.member_id references members`).
- Evidence: route listing in `server/src/app.ts:22-27` and the five route files; `grep -n delete server/src/routes/*.ts` returns nothing for members/payments.
- Note: 전자상거래법 §6 requires keeping 계약·대금결제 기록 for 5 years, so payments should be retained but with the payer's name/phone masked, not dropped.
- Smallest fix: an OWNER-only `POST /api/members/:id/anonymize` that sets `name='탈퇴회원'`, `phone=''`, `memo=null`, deletes `member_links` and `messages` for the member, masks `payments.payer_name/payer_phone` for linked payments, and writes `member.anonymize` to `audit_log`; plus a yearly job (or CLI) that masks `payer_name/payer_phone` on `payments` with `member_id is null` older than N months. Write the retention periods into a one-page 개인정보 처리방침 kept at the desk.

### M5. No access log: logins, IPs and reads/exports are not recorded (접속기록 보관 의무)
- Where: `server/src/audit.ts`, `server/src/routes/auth.ts:44` (login writes nothing to `audit_log`), `server/src/auth/sessions.ts:25` (logout deletes the row, so no trace remains), `server/src/routes/owner.ts:24-28` (settlement detail export, which contains every member name and payment, is not audited), `server/src/routes/bootstrap.ts:22` (full member list with phone+memo on every refresh, not audited)
- Scenario: The studio must keep 개인정보처리시스템 접속기록 (계정, 접속일시, 접속지 IP, 수행업무) for at least 1 year and review them monthly (개인정보의 안전성 확보조치 기준 §8). Today `audit_log` records only writes, without IP, and login/logout leave nothing once the session row is deleted. After a leak the owner cannot answer "who was logged in from where on that day" or "who exported the settlement file".
- Evidence: `audit_log` after the probe session contained `staff.update / member.link / member.update / payment.manual / payment.assign / member.create` only; `sessions` table was empty after logout.
- Smallest fix: in `/login` success and `/logout`, call `audit(db, staffId, 'auth.login'|'auth.logout', 'staff', staffId, { ip: clientIp(c) })`; audit `settlement.export` in `GET /settlement/detail`; keep `audit_log` for ≥ 1 year (it is already in the DB and backups, so just do not prune it). Optionally audit `bootstrap` once per session instead of every refresh.

---

## Low

### L1. No Content-Security-Policy or Permissions-Policy; inline script in index.html
- Where: `deploy/Caddyfile:3-9`, `index.html:15-20`
- Scenario: Any future XSS (e.g. via M2) has no second barrier; a CSP restricting `script-src 'self'` plus the two font origins would neutralize injected scripts. The inline reload script in `index.html` currently blocks a strict CSP.
- Smallest fix: move the inline script into the Vite bundle (or give it a hash), then add to the Caddy `header` block: `Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' https://cdn.jsdelivr.net https://fonts.googleapis.com; font-src https://cdn.jsdelivr.net https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'"` and `Permissions-Policy "camera=(self), geolocation=()"` (camera is needed for the scanner).

### L2. Caddy overwrites the app's `Referrer-Policy: no-referrer` on `/m/*` with `same-origin`
- Where: `deploy/Caddyfile:6` vs `server/src/app.ts:41`
- Scenario: Because the block contains `-Server`, Caddy defers the whole `header` block and applies it to the proxied response, so `Referrer-Policy` becomes `same-origin` for member pages. `same-origin` still prevents the token from reaching jsdelivr/Google Fonts, so there is no leak today; it only means the stricter value the app chose is silently discarded. **Unconfirmed at runtime** (no Caddy locally); confirm with `curl -sI https://<domain>/m/x | grep -i referrer` (expected today: `same-origin`).
- Smallest fix: in the Caddyfile use `?Referrer-Policy same-origin` (set only if upstream did not), or put `Referrer-Policy no-referrer` in a `@member path /m/*` matcher block.

### L3. Server accepts and stores arbitrary `raw` kiosk rows on import
- Where: `server/src/routes/payments.ts:10-11` (`validRow` does not reject `raw`), `server/src/domain/payments.ts:62-63` (`raw_json` persisted)
- Scenario: The web client strips `raw` before sending (`src/store/remote.ts:97`), but the server still stores whatever a client sends. Any staff with devtools (or a future client bug) can persist full kiosk rows, including columns the studio never meant to keep (masked card numbers, approval details) into `payments.raw_json`, which then lands in every backup.
- Evidence: probe B11 imported `{"raw":{"카드번호":"1234-56**-****-7890"}}` and `select raw_json from payments` returned it verbatim.
- Smallest fix: drop `raw` server-side (`r.raw = undefined` in the import route, or remove the column in a migration).

### L4. Static member QR can be replayed from a screenshot
- Where: `server/src/qr.ts:11` (`AM2:<memberId>:<hmac16>`, no time component)
- Scenario: A member screenshots their QR and sends it to a friend; the friend shows it at the desk and consumes the member's pass. Since staff scan it face to face and the scan result shows the member name (probe B8), this is a business-rule risk, not a data leak. The HMAC (64 bits, constant-time compare) and the second-scan `ALREADY` guard are fine.
- Smallest fix: if it matters to the studio, include the KST date in the signed payload (`AM2:<id>:<yyyymmdd>:<sig>`) so the page must be open live; the member page already polls every 30 s.

### L5. Backups are plaintext SQLite (gz) with the QR secret and password hashes; encryption at rest and bucket privacy are unconfirmed
- Where: `deploy/backup.sh:54-61`, `scripts/provision.sh:102-123`, `server/src/qr.ts:3-9` (`qr_secret` in `settings`)
- Scenario: Anyone holding the bucket access key (`/etc/studiopass/backup.env`, root 600, and the copy at `~/.studiopass/backup.env` on the Mac) or the Mac's SSH key gets every member's name, phone, memo, attendance and payment history for the last 30 days of snapshots, plus `qr_secret` (forge any member's QR) and scrypt hashes. Lightsail buckets are private by default and AWS states Lightsail object storage is encrypted at rest, but neither is verified by the scripts. **Unconfirmed**: confirm with `aws lightsail get-bucket-access-keys` / `get-buckets --bucket-name ... --query 'buckets[0].accessRules'` (expect `getObject: private`) and an `s3api head-object` via the bucket's S3 endpoint for `ServerSideEncryption`.
- Smallest fix: encrypt before upload with a passphrase that lives only on the Mac/password manager (`gzip -9 | age -p` or `gpg --symmetric --batch --passphrase-file /etc/studiopass/backup.key`), adjust `cmd_restore` accordingly, and write the key location into the runbook; keep `chmod 700 /srv/studiopass/backups` as is.

### L6. SSH port 22 open to the world; `ubuntu` has passwordless sudo
- Where: `scripts/provision.sh:88-90`, `deploy/bootstrap-host.sh:64-68`
- Scenario: Key-only auth and no root login are set correctly, so this is mostly log noise and a dependency on the one `.pem` on the Mac. If the Mac is compromised, the attacker has root on the host and all data.
- Smallest fix: restrict 22 in the Lightsail firewall to the owner's IP(s) (`put-instance-public-ports ... fromPort=22,toPort=22,protocol=tcp,cidrs=<ip>/32`) or keep it closed and use Lightsail browser SSH only when needed; store the `.pem` in the macOS keychain-backed ssh-agent with a passphrase.

### L7. Container images are not refreshed or hardened
- Where: `deploy/docker-compose.yml:10-13,33`, `deploy/Dockerfile:2,9,18`, `deploy/remote.sh:122`
- Scenario: `compose build api` reuses the cached `node:22-bookworm-slim` layer, so OS packages in the image never get patches unless the base is re-pulled; `caddy:2.8` floats within 2.8.x only. The api container runs as `node` (good) but without `cap_drop`, `no-new-privileges`, or a read-only root FS.
- Smallest fix: `compose build --pull api` in `remote.sh`; add to both services `security_opt: ["no-new-privileges:true"]`, `cap_drop: [ALL]` (caddy needs `NET_BIND_SERVICE`), `read_only: true` with `tmpfs: [/tmp]` for api; bump caddy to the current 2.x on each deploy.

### L8. Member and admin pages load fonts from Google and jsdelivr
- Where: `member.html:10-13`, `index.html:10-13`
- Scenario: Every member who opens their page sends their IP and user agent to Google Fonts and jsdelivr. Under 개인정보보호법 this is a (minor) third-party disclosure that should appear in the privacy notice; it also adds two external dependencies to a page that is designed to work offline from cache.
- Smallest fix: self-host Pretendard and Archivo subsets under `/assets` (Vite can bundle them) and remove the `<link>`s and preconnects.

### L9. No password change for staff in the UI; DESK password is shared and reset only via SSH
- Where: `server/src/routes/owner.ts:94-117` (no password field in PATCH), `src/pages/Settings.tsx` (no staff section), `server/src/cli.ts:32-41`
- Scenario: When a part-timer leaves, the DESK password must be changed with `ssh ... cli.js reset-password desk`, so in practice it will not be rotated. The owner also cannot change their own password without SSH.
- Smallest fix: add `password` to `PATCH /staff/:id` (OWNER only, min 8, re-hash, delete that staff's sessions) and `POST /auth/password` for self-change requiring the current password; expose both in Settings for OWNER.

### L10. Member page caches personal data in `localStorage` keyed by token; token sits in browser history
- Where: `src/member/MemberPage.tsx:29-44`, `server/src/app.ts:43`
- Scenario: On a shared or resold phone, anyone with the browser can open history and see the member page (masked name, passes, QR). This is the chosen UX (offline QR) and the data shown is already minimized; noting it so it is a conscious trade-off.
- Smallest fix: none required; optionally clear the cache entry when the server returns 404 for the token (link reissued).

### L11. Login limiter trusts the first `X-Forwarded-For` entry
- Where: `server/src/routes/auth.ts:24-28`
- Scenario: Safe today because the api is only `expose`d on the compose network and Caddy (no `trusted_proxies`) replaces client-sent XFF. If someone ever adds `ports:` to the api service or runs it outside compose, the limiter is bypassable by header. Probe A7 confirmed the bypass when hitting the api directly.
- Smallest fix: a one-line comment is already in docker-compose; add a startup assert in `main.ts` that refuses `NODE_ENV=production` unless `SP_TRUST_PROXY=1` is set, and only then read XFF.

### L12. Free-text `memo` can collect 민감정보 without a purpose
- Where: `server/src/routes/members.ts:26,47` (500-char free text visible to DESK)
- Scenario: Staff will write health notes ("허리 디스크 주의") or family details. Health information is 민감정보 (§23) and needs separate consent; it is also shown to every DESK account and stored in every backup.
- Smallest fix: put a hint under the field ("건강·가족 등 민감한 내용은 적지 않습니다") and say so in the desk 개인정보 안내문; keep the 500-char cap.

### L13. Processors and purposes are not written down for the data subjects
- Where: operational (no file); related: `server/src/notify/alimtalk.ts`, `deploy/backup.sh`
- Scenario: Member names and phone numbers go to Solapi (알림톡 발송 위탁) and to AWS Seoul (호스팅·백업). 개인정보보호법 §26/§30 expects a 처리방침 naming the purposes (출석·수강권 관리, 안내 발송), items (이름, 휴대폰, 출석·결제 기록), retention (탈퇴 후 즉시 파기, 결제기록 5년), and the processors. The LINK template is 정보성, so no 광고 동의 is needed, but the 수신 consent for 알림톡 should be ticked on the registration form.
- Smallest fix: a one-page 개인정보 처리방침/수집·이용 동의서 at the desk and a link to it from the member page footer.

---

## Checked and found sound

- Session token: 32 random bytes (256 bits) base64url, only sha256 stored (`sessions.ts:14-15`); DB lookup by hash, so no timing oracle.
- Session fixation: server never accepts a client-chosen token; a made-up cookie gets 401 (probe A10). Logout deletes the row and clears the cookie (probe C8); the old cookie is 401 afterwards.
- Cookie flags: `HttpOnly; Secure; SameSite=Lax; Path=/` in production (probe C1); `secure` is tied to `NODE_ENV=production` which the Dockerfile sets.
- Password hashing: scrypt N=32768 r=8 p=1, 16-byte salt, constant-time compare, format self-describing; min length 8 enforced in CLI and API; max 200 chars.
- User enumeration: unknown and known ids return the same `401 {"error":"INVALID"}` and the unknown path still runs one scrypt (probe A5: 0.08 s vs 0.04 s, noise-level); inactive staff look identical.
- Brute force on one id from one IP: 5 tries per 10 min then 429 (probe A6), success resets.
- CSRF: `originGuard` rejects POST/PUT/PATCH/DELETE with missing Origin (403, probe A1/A11), `Origin: null` (A2), look-alike or foreign origins (A3); strict string equality against `SP_ORIGIN`; production refuses to start without `SP_ORIGIN` (`main.ts:8-12`). No GET has side effects beyond the session `last_seen` update. No CORS middleware, so cross-origin reads fail as well.
- Authorization: `ownerOnly` covers `/settlement`, `/settlement/*`, `/instructors/*`, `/courses/*`, `/products/*`, `/tiers`, `/staff`, `/staff/*`. DESK got 403 on every variant tried including trailing slash and `/./staff`; uppercase and encoded-slash variants 404 (probe B1/B2).
- Money fields for DESK: `/bootstrap`, `/payments` POST response and passes contain no `amount`, `price`, `ratioInstructor`, `perSessionFee` (probe B3/B4/B6, key scan found only `settlementType`, `durationMin`, `needsRealPrices`). Spec §4 says DESK may enter an amount but not read it back; that matches.
- IDOR: single-tenant, ids are 12 random base62 chars (~71 bits); every id is existence-checked before use (`members.ts:48,57,69`, `payments.ts:28,46,52`).
- Mass assignment: PATCH `/members/:id` writes only name/phone/memo; `id`, `memberNo`, `createdAt` in the body are ignored (probe B5). PATCH `/staff/:id` ignores `role`, `pwHash`, `loginId` (probe C6). PUT upserts spread the body but then write only validated columns; unknown keys only end up in `audit_log.detail_json`.
- SQL injection: every statement is parameterized; the two LIKE patterns use server-built prefixes (`members.ts:30` year from clock, `settlement.ts:5,21` month validated by regex; `%` and `'` rejected with 400 in probe C2).
- XSS: no `dangerouslySetInnerHTML`/`innerHTML` anywhere in `src/`; Excel preview and member/payer names render through React text nodes; member page renders server JSON as text.
- Excel formula injection in exports: `downloadXlsx` uses `json_to_sheet`, which writes string cells (`t:'s'`), not formulas; a `=HYPERLINK(...)` payer name is stored and shown as text in .xlsx (confirmed the value round-trips as a string via `/settlement/detail`, probe C3). Would only matter if a CSV export were added.
- Member link: 16 random bytes (128 bits) base64url; only sha256 stored (`links.ts:8-9`, DB check D2); charset/length regex before lookup; malformed and unknown tokens both return the same 404 with `Cache-Control: no-store` (probe A13); reissue invalidates the old token immediately (probe B7b); `Referrer-Policy: no-referrer` on `/m/*` (A13); Caddy has no `log` directive so access logs (and the token in the path) are not written; the app logs nothing per request.
- Public page minimization: name masked (`홍**2`), no phone, memo, money, member number or other members; only active passes (probe B7). A member cannot learn anything about another member from their link.
- QR: HMAC-SHA256 truncated to 64 bits, `timingSafeEqual`, wrong signature gives `UNKNOWN_QR` (probe B9); double scan same day gives `ALREADY` (B8).
- Secrets: nothing committed (grep for AKIA/ASIA/private keys/real ntfy topics over tracked files: only placeholders). `alimtalk.env`, `backup.env`, `alerts.env` are root 600 in `/etc/studiopass`; the bucket key is bucket-scoped; `provision.sh` runs with `umask 077` and never prints keys; the owner password is read from a hidden prompt via stdin, not argv. Alimtalk logging prints only provider error codes, never phone/name/body (`alimtalk.ts:51-52,62`).
- Audit log minimization: `member.update` records field names only; payment and member rows record ids.
- Body limits: 2 MB on `/api/*` (413 confirmed, probe A12); import capped at 2000 rows; name/memo/payerName/productName/loginId/password length caps.
- Static serving: traversal attempts (`/assets/../../server/package.json`, `%2e%2e`, `/../.env`) all fell through to the SPA `index.html` (probe C9); `dist/` contains no source maps or server code.
- Container/host: api runs as `node` (`USER node`), only Caddy publishes 80/443, api is `expose` only; ufw and the Lightsail firewall allow 22/80/443 only; SSH is key-only with root login off and the drop-in sorts before cloud-init's; unattended-upgrades on; HSTS 1 year, `nosniff`, `X-Frame-Options DENY`, `Server` header removed; Docker logs capped 10 MB x 3.
- Backups: `sqlite3 .backup` + `integrity_check` before upload; 30-day S3 retention and 5 local pre-deploy copies, local dir 700; backup log has no personal data; ntfy messages carry no IPs, domains or member data (verified in all three scripts).
- Dependencies: server `npm audit --omit=dev` clean (hono 4.13.13, @hono/node-server 1.19.17, better-sqlite3 12.11.1); web clean except `xlsx` (M2); React 19.3, zustand 5, qrcode 1.5.4, html5-qrcode 2.3.8.
- Tests: 83 pass, including Origin rejection, Secure cookie, limiter, DESK money exclusion, public page minimization, 2 MB limit, member-page referrer policy.

## Not verifiable from the repo (listed so they are checked once on the real host)
- Lightsail bucket access rules and server-side encryption (L5).
- Runtime `Referrer-Policy` value on `/m/*` behind Caddy (L2).
- scrypt cost and login-flood impact on the 1 vCPU host (M1).
- Lightsail instance disk encryption at rest (AWS documents it as default for current instances).
