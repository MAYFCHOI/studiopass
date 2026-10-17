# studiopass 실사용 전환 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 브라우저 저장 프로토타입을, 원장·인포 로그인과 회원 개인 링크가 있는 서버 기반 서비스로 바꾸고 개인 AWS Lightsail 에 올릴 준비를 끝낸다.

**Architecture:** 루트의 Vite+React 앱은 그대로 두고 `server/`(Node 22, Hono, better-sqlite3)를 새로 만든다. 도메인 규칙(출석·결제·정산·등급)은 `server/src/domain/` 의 순수 함수 + SQLite 트랜잭션으로 두고, Hono 라우트는 얇게 감싼다. 웹 store 는 같은 액션 이름을 유지한 채 `demo`(지금 브라우저 저장) / `api`(서버) 두 구현을 가진다.

**Tech Stack:** Node 22, TypeScript 6, Hono 4 + @hono/node-server, better-sqlite3 11, vitest 3, tsx, React 19, Vite 8, zustand 5, Docker Compose, Caddy 2.

**Spec:** `docs/superpowers/specs/2026-10-17-studiopass-production-design.md`

## Global Constraints

- 개인 프로젝트: 커밋에 `Co-Authored-By`·`Generated with` 트레일러 금지. Conventional Commits 자유. git identity 는 MAYFCHOI / cjm104174@gmail.com (`git config user.email` 확인).
- 시각은 UTC ISO 문자열 저장, 날짜는 KST(`Asia/Seoul`) 기준 `YYYY-MM-DD`. 금액은 원 단위 정수.
- id 는 서버가 만드는 12자 base62 무작위 문자열.
- DESK 역할에는 금액 필드(`amount`, `price`, 정산 전체)를 API 가 주지 않는다. 화면 숨김만으로 끝내지 않는다.
- 회원 공개 응답에 금액·전화번호·메모를 넣지 않는다. 이름은 가운데 글자를 `*` 로 가린다(2자면 둘째 글자, 3자 이상이면 처음·끝 제외 전부).
- QR 문자열 형식 `AM2:<member_id>:<hmac16>`. 프로토타입 `AM1` 은 거절.
- 쿠키 `sp_session`: httpOnly, SameSite=Lax, 운영(`NODE_ENV=production`)에서 Secure.
- 화면 문구는 지금 앱의 해요체 그대로. 디자인은 THE DEPTH 토큰(`src/index.css` 의 `:root`)을 쓴다.
- ntfy 본문에 IP·도메인·회원 정보 금지.
- 서버 네이티브 의존성은 better-sqlite3 하나.

## Review Focus

1. 같은 회원 QR 을 두 번 빠르게 찍음 → 두 번째는 "오늘 이 수업은 이미 출석했어요", 횟수는 한 번만 준다 (DB 부분 유일 인덱스로도 막혀야 함). Task 3 에 동시 호출 테스트.
2. 자정 근처(KST 00:10) 출석 → UTC 로는 전날이어도 KST 날짜로 중복·기간 판정. Task 3 에 시각 주입 테스트.
3. 출석에 쓰인 수강권의 결제를 취소 → 거절하고 사용 횟수를 알려줌, 수강권·출석 그대로. Task 4 테스트.
4. 인포 계정으로 `/api/settlement` 나 상품 가격 조회 → 403 또는 금액 필드 없음. Task 6·7 테스트.
5. 회원 링크 재발급 후 예전 링크 → 404, 새 링크만 열림. 없는 토큰도 같은 404. Task 7 테스트.

---

## File Structure

```
shared/schedule.ts              실제 시간표·강사 (웹 데모와 서버 시드가 같이 씀)
server/package.json, tsconfig.json, vitest.config.ts
server/migrations/001_init.sql  전체 스키마
server/src/db.ts                DB 열기 + 마이그레이션
server/src/util.ts              newId, nowIso, kstDate, maskName, normalizePhone
server/src/qr.ts                QR 서명/검증
server/src/domain/tiers.ts      등급 계산
server/src/domain/attendance.ts 출석·취소 트랜잭션
server/src/domain/payments.ts   결제 적재·연결·취소
server/src/domain/settlement.ts 정산
server/src/domain/seed.ts       첫 기동 데이터
server/src/auth/password.ts     scrypt
server/src/auth/sessions.ts     세션 발급·조회·삭제
server/src/auth/rateLimit.ts    로그인 제한
server/src/links.ts             회원 링크 발급·조회
server/src/serialize.ts         역할별 응답 직렬화(금액 제거)
server/src/app.ts               Hono 앱(라우트 전부)
server/src/main.ts              실행 진입점
server/src/cli.ts               원장 계정 생성·비번 재설정
server/test/*.test.ts
src/api/client.ts               fetch 래퍼
src/store.ts                    (수정) 비동기 액션 + 모드 분기
src/store/demo.ts               지금 로직(브라우저 저장)
src/store/remote.ts             서버 구현
src/pages/Login.tsx             로그인
src/components/OfflineBar.tsx   오프라인 띠
member.html, src/member/*       회원 페이지 별도 진입
deploy/Dockerfile, deploy/docker-compose.yml, deploy/Caddyfile
deploy/backup.sh, deploy/healthcheck.sh, scripts/deploy.sh
docs/RUNBOOK.md                 배포·백업·복구·롤백
```

---

### Task 1: 서버 뼈대, 스키마, 공용 시간표

**Files:**
- Create: `shared/schedule.ts`, `server/package.json`, `server/tsconfig.json`, `server/vitest.config.ts`, `server/migrations/001_init.sql`, `server/src/db.ts`, `server/src/util.ts`, `server/test/db.test.ts`, `server/test/util.test.ts`
- Modify: `src/lib/seed.ts` (SCHEDULE·buildSchedule 를 `shared/schedule.ts` 에서 import), `tsconfig.app.json` include 에 `shared` 추가, `.gitignore` 에 `server/node_modules`, `server/data`, `*.db`

**Interfaces:**
- Produces: `openDb(file: string): Database.Database` (`':memory:'` 허용, 마이그레이션 적용, `PRAGMA foreign_keys=ON; journal_mode=WAL` 파일일 때)
- Produces: `newId(): string`, `nowIso(d?: Date): string`, `kstDate(d?: Date): string`, `kstMonth(d?: Date): string`, `maskName(name: string): string`, `normalizePhone(s: unknown): string`
- Produces (shared): `SCHEDULE`, `buildSchedule(): { instructors: Instructor[]; courses: Course[] }` — 지금 `src/lib/seed.ts` 의 것을 그대로 옮긴다. 타입은 `shared/schedule.ts` 안에 최소 형태로 다시 선언(웹 `src/types.ts` 와 필드명 동일).

- [ ] **Step 1: 공용 시간표 이동**

`src/lib/seed.ts` 의 `type Row`, `const W`, `const SCHEDULE`, `slug`, `buildSchedule` 를 `shared/schedule.ts` 로 옮기고 `export`. 타입은:

```ts
export type Hall = 'HUB' | 'LAB';
export interface ScheduleInstructor { id: string; name: string; crew: string; settlementType: 'RATIO' | 'PER_SESSION'; ratioInstructor: number; perSessionFee: number }
export interface ScheduleCourse { id: string; name: string; instructorId: string; kind: 'GENERAL' | 'PRO'; hall: Hall; level?: string; note?: string; weekday: number[]; startTime: string; durationMin: number }
```

`src/lib/seed.ts` 는 `import { buildSchedule } from '../../shared/schedule'` 로 바꾼다. 웹 빌드 확인: `npm run build` 통과.

- [ ] **Step 2: 서버 패키지**

`server/package.json`:

```json
{
  "name": "studiopass-server",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/main.ts",
    "start": "node dist/server/src/main.js",
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "cli": "tsx src/cli.ts"
  },
  "dependencies": {
    "@hono/node-server": "^1.13.7",
    "better-sqlite3": "^11.7.0",
    "hono": "^4.6.14"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.12",
    "@types/node": "^22.10.2",
    "tsx": "^4.19.2",
    "typescript": "~5.7.2",
    "vitest": "^3.0.0"
  }
}
```

`server/tsconfig.json`: `target ES2022, module NodeNext, moduleResolution NodeNext, strict, outDir dist, rootDir ..`, include `src`, `../shared`. `vitest.config.ts`: `test: { include: ['test/**/*.test.ts'] }`. `cd server && npm install`.

- [ ] **Step 3: 실패하는 테스트**

`server/test/db.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db';
describe('openDb', () => {
  it('applies migrations once', () => {
    const db = openDb(':memory:');
    const tables = db.prepare("select name from sqlite_master where type='table'").all().map((r: any) => r.name);
    for (const t of ['staff','sessions','members','member_links','instructors','courses','products','payments','passes','attendances','tiers','messages','audit_log','settings','schema_migrations']) expect(tables).toContain(t);
    expect(db.prepare('select count(*) n from schema_migrations').get()).toEqual({ n: 1 });
  });
  it('blocks a second active attendance for the same member, course and day', () => {
    const db = openDb(':memory:');
    db.exec(`insert into members(id,member_no,name,phone,created_at) values('m','2026-0001','김서연','01011112222','2026-10-17T00:00:00Z');
      insert into instructors(id,name,settlement_type,ratio_instructor,per_session_fee) values('i','YUZ','RATIO',50,0);
      insert into courses(id,hall,name,instructor_id,kind,weekday,start_time,duration_min) values('c','HUB','HIPHOP','i','GENERAL',1,'19:25',80);
      insert into products(id,name,pass_kind,count,period_days,price) values('p','정규 8회권','COUNT',8,60,180000);
      insert into passes(id,member_id,product_id,kind,total_count,remaining,valid_from,valid_to,price,created_at) values('s','m','p','COUNT',8,8,'2026-10-01','2026-11-30',180000,'2026-10-01T00:00:00Z');`);
    const ins = "insert into attendances(id,member_id,pass_id,course_id,instructor_id,attended_on,attended_at) values(?,?,?,?,?,?,?)";
    db.prepare(ins).run('a1','m','s','c','i','2026-10-19','2026-10-19T10:30:00Z');
    expect(() => db.prepare(ins).run('a2','m','s','c','i','2026-10-19','2026-10-19T10:31:00Z')).toThrow(/UNIQUE/);
    db.prepare("update attendances set cancelled_at='x' where id='a1'").run();
    expect(() => db.prepare(ins).run('a3','m','s','c','i','2026-10-19','2026-10-19T10:32:00Z')).not.toThrow();
  });
});
```

`server/test/util.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { kstDate, maskName, normalizePhone, newId } from '../src/util';
describe('util', () => {
  it('kstDate uses Seoul time', () => {
    expect(kstDate(new Date('2026-10-18T15:10:00Z'))).toBe('2026-10-19');
    expect(kstDate(new Date('2026-10-18T14:59:00Z'))).toBe('2026-10-18');
  });
  it('maskName', () => {
    expect(maskName('김서연')).toBe('김*연'); expect(maskName('이도')).toBe('이*'); expect(maskName('남궁민수')).toBe('남**수'); expect(maskName('A')).toBe('A');
  });
  it('normalizePhone', () => {
    expect(normalizePhone('010-1234-5678')).toBe('01012345678'); expect(normalizePhone(1012345678)).toBe('01012345678'); expect(normalizePhone('+82 10 1234 5678')).toBe('01012345678'); expect(normalizePhone(undefined)).toBe('');
  });
  it('newId is 12 base62 chars', () => { expect(newId()).toMatch(/^[0-9A-Za-z]{12}$/); });
});
```

Run: `cd server && npx vitest run` → FAIL (모듈 없음).

- [ ] **Step 4: 스키마와 구현**

`server/migrations/001_init.sql` (스펙 §3 표 그대로):

```sql
create table staff (id text primary key, login_id text not null unique, name text not null, role text not null check (role in ('OWNER','DESK')), pw_hash text not null, active integer not null default 1, created_at text not null);
create table sessions (token_hash text primary key, staff_id text not null references staff(id), created_at text not null, expires_at text not null, last_seen_at text not null);
create table members (id text primary key, member_no text not null unique, name text not null, phone text not null default '', memo text, created_at text not null);
create index members_phone on members(phone);
create table member_links (member_id text primary key references members(id), token_hash text not null unique, issued_at text not null, issued_by text);
create table instructors (id text primary key, name text not null, genres text not null default '', settlement_type text not null check (settlement_type in ('RATIO','PER_SESSION')), ratio_instructor integer not null default 50, per_session_fee integer not null default 0, active integer not null default 1);
create table courses (id text primary key, hall text not null check (hall in ('HUB','LAB')), name text not null, instructor_id text not null references instructors(id), kind text not null check (kind in ('GENERAL','PRO')), level text, note text, weekday integer not null check (weekday between 0 and 6), start_time text not null, duration_min integer not null, active integer not null default 1);
create table products (id text primary key, name text not null unique, course_id text references courses(id), pass_kind text not null check (pass_kind in ('COUNT','PERIOD')), count integer not null, period_days integer not null, price integer not null, active integer not null default 1);
create table payments (id text primary key, source text not null check (source in ('KIOSK','MANUAL')), external_id text, paid_at text not null, amount integer not null, payer_name text, payer_phone text not null default '', product_name text not null, status text not null check (status in ('APPROVED','CANCELLED')), member_id text references members(id), pass_id text, raw_json text, created_by text, created_at text not null);
create unique index payments_external on payments(external_id) where external_id is not null;
create table passes (id text primary key, member_id text not null references members(id), product_id text not null references products(id), course_id text references courses(id), kind text not null check (kind in ('COUNT','PERIOD')), total_count integer not null, remaining integer not null check (remaining >= 0), valid_from text not null, valid_to text not null, payment_id text references payments(id), price integer not null, created_at text not null);
create index passes_member on passes(member_id);
create table attendances (id text primary key, member_id text not null references members(id), pass_id text not null references passes(id), course_id text not null references courses(id), instructor_id text not null references instructors(id), attended_on text not null, attended_at text not null, cancelled_at text, created_by text, cancelled_by text);
create unique index attendances_once on attendances(member_id, course_id, attended_on) where cancelled_at is null;
create index attendances_on on attendances(attended_on);
create table tiers (id text primary key, name text not null, min_count integer not null, sort integer not null);
create table messages (id text primary key, member_id text not null references members(id), channel text not null, kind text not null, created_by text, created_at text not null);
create table audit_log (id text primary key, at text not null, staff_id text, action text not null, entity text not null, entity_id text, detail_json text);
create table settings (key text primary key, value text not null);
```

`server/src/db.ts`:

```ts
import Database from 'better-sqlite3';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const MIG_DIR = process.env.SP_MIGRATIONS ?? join(dirname(fileURLToPath(import.meta.url)), '../migrations');
export function openDb(file: string) {
  const db = new Database(file);
  db.pragma('foreign_keys = ON');
  if (file !== ':memory:') db.pragma('journal_mode = WAL');
  db.exec('create table if not exists schema_migrations (name text primary key, applied_at text not null)');
  const done = new Set(db.prepare('select name from schema_migrations').all().map((r: any) => r.name));
  for (const f of readdirSync(MIG_DIR).filter((x) => x.endsWith('.sql')).sort()) {
    if (done.has(f)) continue;
    db.transaction(() => { db.exec(readFileSync(join(MIG_DIR, f), 'utf8')); db.prepare('insert into schema_migrations values (?,?)').run(f, new Date().toISOString()); })();
  }
  return db;
}
export type Db = Database.Database;
```

(빌드 후 `dist/server/src/db.js` 에서 `../migrations` 가 안 맞으므로 Dockerfile 에서 `SP_MIGRATIONS=/app/server/migrations` 를 준다.)

`server/src/util.ts`:

```ts
import { randomBytes } from 'node:crypto';
const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
export const newId = () => Array.from(randomBytes(12), (b) => B62[b % 62]).join('');
export const nowIso = (d = new Date()) => d.toISOString();
const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' });
export const kstDate = (d = new Date()) => fmt.format(d);
export const kstMonth = (d = new Date()) => kstDate(d).slice(0, 7);
export const addDays = (ymd: string, n: number) => { const t = new Date(ymd + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
export function maskName(name: string) {
  const c = [...name]; if (c.length < 2) return name; if (c.length === 2) return c[0] + '*';
  return c[0] + '*'.repeat(c.length - 2) + c[c.length - 1];
}
export function normalizePhone(s: unknown) {
  if (s === undefined || s === null) return '';
  let d = String(s).replace(/\D/g, '');
  if (d.startsWith('82')) d = '0' + d.slice(2);
  if (d.length === 10 && d.startsWith('10')) d = '0' + d;
  return d;
}
```

- [ ] **Step 5: 통과 확인**

Run: `cd server && npx vitest run` → PASS. 루트 `npm run build` → PASS.

- [ ] **Step 6: Commit** `git add -A && git commit -m "feat(server): scaffold, schema, shared schedule"`

---

### Task 2: QR 서명, 등급, 첫 기동 데이터

**Files:**
- Create: `server/src/qr.ts`, `server/src/domain/tiers.ts`, `server/src/domain/seed.ts`, `server/test/qr.test.ts`, `server/test/tiers.test.ts`, `server/test/seed.test.ts`

**Interfaces:**
- Consumes: `openDb`, `newId`, `buildSchedule`
- Produces: `getSecret(db): string` (settings.qr_secret, 없으면 32바이트 hex 생성·저장), `qrPayload(db, memberId): string`, `parseQr(db, text): string | null`
- Produces: `tierFor(db, memberId): { name: string; level: number; count: number; nextName: string | null; nextAt: number | null }` (level = 1부터, tiers.sort 순)
- Produces: `seedIfEmpty(db): boolean` — instructors 가 비었으면 시간표·강사·예시 상품 4종·등급 4종·studio_name 을 넣고 true

- [ ] **Step 1: 실패하는 테스트**

```ts
// server/test/qr.test.ts
import { it, expect } from 'vitest';
import { openDb } from '../src/db';
import { qrPayload, parseQr } from '../src/qr';
it('signs and verifies member QR', () => {
  const db = openDb(':memory:');
  const p = qrPayload(db, 'abc123XYZ000');
  expect(p).toMatch(/^AM2:abc123XYZ000:[0-9a-f]{16}$/);
  expect(parseQr(db, p)).toBe('abc123XYZ000');
  expect(parseQr(db, p.slice(0, -1) + (p.endsWith('0') ? '1' : '0'))).toBeNull();
  expect(parseQr(db, 'AM1:m_0099gm:abcdef')).toBeNull();
  expect(parseQr(openDb(':memory:'), p)).toBeNull(); // 다른 비밀키
});
```

```ts
// server/test/tiers.test.ts
import { it, expect } from 'vitest';
import { openDb } from '../src/db';
import { seedIfEmpty } from '../src/domain/seed';
import { tierFor } from '../src/domain/tiers';
it('tier follows active attendance count', () => {
  const db = openDb(':memory:'); seedIfEmpty(db);
  db.exec(`insert into members(id,member_no,name,phone,created_at) values('m','2026-0001','김서연','010','2026-01-01T00:00:00Z');
    insert into passes(id,member_id,product_id,kind,total_count,remaining,valid_from,valid_to,price,created_at) select 's','m',id,'COUNT',99,99,'2026-01-01','2026-12-31',0,'x' from products limit 1;`);
  const course = (db.prepare('select id, instructor_id from courses limit 1').get() as any);
  const add = (i: number, cancelled = false) => db.prepare('insert into attendances(id,member_id,pass_id,course_id,instructor_id,attended_on,attended_at,cancelled_at) values(?,?,?,?,?,?,?,?)').run('a' + i, 'm', 's', course.id, course.instructor_id, `2026-0${1 + Math.floor(i / 28)}-${String(1 + (i % 28)).padStart(2, '0')}`, 'x', cancelled ? 'x' : null);
  expect(tierFor(db, 'm')).toMatchObject({ name: 'DEPTH 1', level: 1, count: 0, nextAt: 10 });
  for (let i = 0; i < 10; i++) add(i);
  expect(tierFor(db, 'm')).toMatchObject({ name: 'DEPTH 2', level: 2, count: 10, nextAt: 30 });
  add(10, true);
  expect(tierFor(db, 'm').count).toBe(10);
  for (let i = 11; i < 71; i++) add(i);
  expect(tierFor(db, 'm')).toMatchObject({ level: 4, nextName: null, nextAt: null });
});
```

```ts
// server/test/seed.test.ts
import { it, expect } from 'vitest';
import { openDb } from '../src/db';
import { seedIfEmpty } from '../src/domain/seed';
it('seeds real schedule once', () => {
  const db = openDb(':memory:');
  expect(seedIfEmpty(db)).toBe(true);
  expect(seedIfEmpty(db)).toBe(false);
  const n = (t: string) => (db.prepare(`select count(*) n from ${t}`).get() as any).n;
  expect(n('courses')).toBe(28); expect(n('instructors')).toBe(17); expect(n('products')).toBe(4); expect(n('tiers')).toBe(4); expect(n('members')).toBe(0);
  expect((db.prepare("select value from settings where key='studio_name'").get() as any).value).toBe('THE DEPTH');
});
```

Run → FAIL.

- [ ] **Step 2: 구현**

```ts
// server/src/qr.ts
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Db } from './db';
export function getSecret(db: Db) {
  const r = db.prepare("select value from settings where key='qr_secret'").get() as { value: string } | undefined;
  if (r) return r.value;
  const v = randomBytes(32).toString('hex');
  db.prepare("insert into settings(key,value) values('qr_secret',?)").run(v);
  return v;
}
const sig = (secret: string, id: string) => createHmac('sha256', secret).update(id).digest('hex').slice(0, 16);
export const qrPayload = (db: Db, memberId: string) => `AM2:${memberId}:${sig(getSecret(db), memberId)}`;
export function parseQr(db: Db, text: string) {
  const m = /^AM2:([0-9A-Za-z_]+):([0-9a-f]{16})$/.exec(text.trim());
  if (!m) return null;
  const want = Buffer.from(sig(getSecret(db), m[1])); const got = Buffer.from(m[2]);
  return want.length === got.length && timingSafeEqual(want, got) ? m[1] : null;
}
```

```ts
// server/src/domain/tiers.ts
import type { Db } from '../db';
export function tierFor(db: Db, memberId: string) {
  const count = (db.prepare('select count(*) n from attendances where member_id=? and cancelled_at is null').get(memberId) as { n: number }).n;
  const tiers = db.prepare('select name, min_count from tiers order by sort').all() as { name: string; min_count: number }[];
  let idx = 0;
  tiers.forEach((t, i) => { if (count >= t.min_count) idx = i; });
  const next = tiers[idx + 1];
  return { name: tiers[idx]?.name ?? '', level: idx + 1, count, nextName: next?.name ?? null, nextAt: next?.min_count ?? null };
}
```

```ts
// server/src/domain/seed.ts
import type { Db } from '../db';
import { newId } from '../util';
import { buildSchedule } from '../../../shared/schedule';
export function seedIfEmpty(db: Db) {
  if ((db.prepare('select count(*) n from instructors').get() as { n: number }).n > 0) return false;
  const { instructors, courses } = buildSchedule();
  db.transaction(() => {
    const ins = db.prepare('insert into instructors(id,name,genres,settlement_type,ratio_instructor,per_session_fee) values(?,?,?,?,?,?)');
    for (const i of instructors) ins.run(i.id, i.name, i.crew, i.settlementType, i.ratioInstructor, i.perSessionFee);
    const cs = db.prepare('insert into courses(id,hall,name,instructor_id,kind,level,note,weekday,start_time,duration_min) values(?,?,?,?,?,?,?,?,?,?)');
    for (const c of courses) cs.run(c.id, c.hall, c.name, c.instructorId, c.kind, c.level ?? null, c.note ?? null, c.weekday[0], c.startTime, c.durationMin);
    const pr = db.prepare('insert into products(id,name,course_id,pass_kind,count,period_days,price) values(?,?,null,?,?,?,?)');
    pr.run('p_one', '정규 클래스 1회권', 'COUNT', 1, 7, 30000);
    pr.run('p_four', '정규 클래스 4회권', 'COUNT', 4, 30, 100000);
    pr.run('p_eight', '정규 클래스 8회권', 'COUNT', 8, 60, 180000);
    pr.run('p_pro', '전문반 월정액', 'PERIOD', 12, 30, 350000);
    const t = db.prepare('insert into tiers(id,name,min_count,sort) values(?,?,?,?)');
    [['DEPTH 1', 0], ['DEPTH 2', 10], ['DEPTH 3', 30], ['DEPTH 4', 60]].forEach(([n, m], i) => t.run(newId(), n, m, i));
    db.prepare("insert or replace into settings(key,value) values('studio_name','THE DEPTH'),('needs_real_prices','1')").run();
  })();
  return true;
}
```

- [ ] **Step 3: 통과 확인** `cd server && npx vitest run` → PASS
- [ ] **Step 4: Commit** `feat(server): qr signing, tiers, first-boot seed`

---

### Task 3: 출석 트랜잭션

**Files:**
- Create: `server/src/domain/attendance.ts`, `server/src/audit.ts`, `server/test/attendance.test.ts`, `server/test/fixtures.ts`

**Interfaces:**
- Consumes: `openDb`, `seedIfEmpty`, `newId`, `kstDate`, `nowIso`
- Produces: `audit(db, staffId: string | null, action: string, entity: string, entityId: string | null, detail?: unknown): void`
- Produces:
```ts
export type AttendFail = 'UNKNOWN_MEMBER' | 'UNKNOWN_COURSE' | 'ALREADY' | 'PRO_ONLY' | 'EMPTY' | 'EXPIRED' | 'NO_PASS';
export type AttendResult = { ok: true; attendanceId: string; memberId: string; passId: string; remaining: number; total: number; validTo: string } | { ok: false; reason: AttendFail; memberId?: string };
export function attend(db: Db, a: { memberId: string; courseId: string; staffId: string | null; now?: Date }): AttendResult;
export function cancelAttendance(db: Db, id: string, staffId: string | null): boolean; // 이미 취소면 false
export function pickPass(passes: PassRow[], course: { id: string; kind: 'GENERAL'|'PRO' }, today: string): PassRow | undefined;
```
- Produces (fixtures): `makeDb(): { db, member(name?, phone?) => id, pass(memberId, opts) => id, course(kind?) => {id, instructor_id} }`

- [ ] **Step 1: 테스트 픽스처**

```ts
// server/test/fixtures.ts
import { openDb } from '../src/db';
import { seedIfEmpty } from '../src/domain/seed';
let seq = 0;
export function makeDb() {
  const db = openDb(':memory:'); seedIfEmpty(db);
  const member = (name = '김서연', phone = '01011112222') => { const id = 'm' + ++seq; db.prepare('insert into members(id,member_no,name,phone,created_at) values(?,?,?,?,?)').run(id, '2026-' + String(seq).padStart(4, '0'), name, phone, '2026-10-01T00:00:00Z'); return id; };
  const course = (kind: 'GENERAL' | 'PRO' = 'GENERAL') => db.prepare('select id, instructor_id from courses where kind=? limit 1').get(kind) as { id: string; instructor_id: string };
  const pass = (memberId: string, o: { kind?: 'COUNT' | 'PERIOD'; remaining?: number; total?: number; from?: string; to?: string; courseId?: string | null; product?: string }) => {
    const id = 's' + ++seq;
    db.prepare('insert into passes(id,member_id,product_id,course_id,kind,total_count,remaining,valid_from,valid_to,price,created_at) values(?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, memberId, o.product ?? (o.kind === 'PERIOD' ? 'p_pro' : 'p_eight'), o.courseId ?? null, o.kind ?? 'COUNT', o.total ?? 8, o.remaining ?? 8, o.from ?? '2026-10-01', o.to ?? '2026-11-30', 180000, 'x');
    return id;
  };
  return { db, member, course, pass };
}
```

- [ ] **Step 2: 실패하는 테스트**

```ts
// server/test/attendance.test.ts
import { describe, it, expect } from 'vitest';
import { makeDb } from './fixtures';
import { attend, cancelAttendance } from '../src/domain/attendance';
const T = new Date('2026-10-19T10:30:00Z'); // KST 2026-10-19 19:30
const rem = (db: any, id: string) => (db.prepare('select remaining r from passes where id=?').get(id) as any).r;
describe('attend', () => {
  it('records attendance and decrements the pass once', () => {
    const { db, member, course, pass } = makeDb(); const m = member(); const s = pass(m, {}); const c = course();
    const r = attend(db, { memberId: m, courseId: c.id, staffId: null, now: T });
    expect(r).toMatchObject({ ok: true, passId: s, remaining: 7, total: 8 });
    expect(rem(db, s)).toBe(7);
  });
  it('rejects a second scan of the same course on the same KST day', () => {
    const { db, member, course, pass } = makeDb(); const m = member(); const s = pass(m, {}); const c = course();
    attend(db, { memberId: m, courseId: c.id, staffId: null, now: T });
    expect(attend(db, { memberId: m, courseId: c.id, staffId: null, now: new Date('2026-10-19T14:59:00Z') })).toMatchObject({ ok: false, reason: 'ALREADY' });
    expect(rem(db, s)).toBe(7);
  });
  it('uses KST date near midnight', () => {
    const { db, member, course, pass } = makeDb(); const m = member(); pass(m, { from: '2026-10-20', to: '2026-10-20' }); const c = course();
    expect(attend(db, { memberId: m, courseId: c.id, staffId: null, now: new Date('2026-10-19T15:10:00Z') })).toMatchObject({ ok: true }); // KST 10-20 00:10
  });
  it('picks course pass, then common count pass, then monthly pass, earliest expiry first', () => {
    const { db, member, course, pass } = makeDb(); const m = member(); const c = course();
    const monthly = pass(m, { kind: 'PERIOD', total: 12, remaining: 12 });
    const commonLate = pass(m, { to: '2026-12-31' }); const commonEarly = pass(m, { to: '2026-11-05' });
    const own = pass(m, { courseId: c.id, to: '2026-12-31' });
    expect(attend(db, { memberId: m, courseId: c.id, staffId: null, now: T })).toMatchObject({ passId: own });
    db.prepare('update passes set remaining=0 where id=?').run(own);
    expect(attend(db, { memberId: m, courseId: c.id, staffId: null, now: new Date('2026-10-20T10:30:00Z') })).toMatchObject({ passId: commonEarly });
    db.prepare('update passes set remaining=0 where id in (?,?)').run(commonEarly, commonLate);
    expect(attend(db, { memberId: m, courseId: c.id, staffId: null, now: new Date('2026-10-21T10:30:00Z') })).toMatchObject({ passId: monthly });
  });
  it('PRO class accepts only the monthly pass', () => {
    const { db, member, course, pass } = makeDb(); const m = member(); pass(m, {}); const pro = course('PRO');
    expect(attend(db, { memberId: m, courseId: pro.id, staffId: null, now: T })).toMatchObject({ ok: false, reason: 'PRO_ONLY' });
    pass(m, { kind: 'PERIOD', total: 12, remaining: 12 });
    expect(attend(db, { memberId: m, courseId: pro.id, staffId: null, now: T })).toMatchObject({ ok: true });
  });
  it('explains empty, expired and missing passes', () => {
    const { db, member, course, pass } = makeDb(); const c = course();
    const a = member('가', '01000000001'); pass(a, { remaining: 0 });
    const b = member('나', '01000000002'); pass(b, { to: '2026-10-18' });
    const d = member('다', '01000000003');
    expect(attend(db, { memberId: a, courseId: c.id, staffId: null, now: T })).toMatchObject({ reason: 'EMPTY' });
    expect(attend(db, { memberId: b, courseId: c.id, staffId: null, now: T })).toMatchObject({ reason: 'EXPIRED' });
    expect(attend(db, { memberId: d, courseId: c.id, staffId: null, now: T })).toMatchObject({ reason: 'NO_PASS' });
    expect(attend(db, { memberId: 'nope', courseId: c.id, staffId: null, now: T })).toMatchObject({ reason: 'UNKNOWN_MEMBER' });
  });
  it('cancel restores the count once and allows a new scan', () => {
    const { db, member, course, pass } = makeDb(); const m = member(); const s = pass(m, {}); const c = course();
    const r = attend(db, { memberId: m, courseId: c.id, staffId: 'st', now: T }) as any;
    expect(cancelAttendance(db, r.attendanceId, 'st')).toBe(true);
    expect(cancelAttendance(db, r.attendanceId, 'st')).toBe(false);
    expect(rem(db, s)).toBe(8);
    expect(attend(db, { memberId: m, courseId: c.id, staffId: null, now: T })).toMatchObject({ ok: true });
    expect((db.prepare("select count(*) n from audit_log where action='attendance.cancel'").get() as any).n).toBe(1);
  });
});
```

Run → FAIL.

- [ ] **Step 3: 구현**

```ts
// server/src/audit.ts
import type { Db } from './db';
import { newId, nowIso } from './util';
export function audit(db: Db, staffId: string | null, action: string, entity: string, entityId: string | null, detail?: unknown) {
  db.prepare('insert into audit_log(id,at,staff_id,action,entity,entity_id,detail_json) values(?,?,?,?,?,?,?)').run(newId(), nowIso(), staffId, action, entity, entityId, detail === undefined ? null : JSON.stringify(detail));
}
```

```ts
// server/src/domain/attendance.ts
import type { Db } from '../db';
import { newId, nowIso, kstDate } from '../util';
import { audit } from '../audit';
export type PassRow = { id: string; kind: 'COUNT' | 'PERIOD'; course_id: string | null; remaining: number; total_count: number; valid_from: string; valid_to: string };
export type AttendFail = 'UNKNOWN_MEMBER' | 'UNKNOWN_COURSE' | 'ALREADY' | 'PRO_ONLY' | 'EMPTY' | 'EXPIRED' | 'NO_PASS';
export type AttendResult = { ok: true; attendanceId: string; memberId: string; passId: string; remaining: number; total: number; validTo: string } | { ok: false; reason: AttendFail; memberId?: string };
const fits = (p: PassRow, c: { id: string; kind: string }) => (p.kind === 'PERIOD' ? true : c.kind === 'PRO' ? false : p.course_id ? p.course_id === c.id : true);
const rank = (p: PassRow) => (p.kind === 'PERIOD' ? 2 : p.course_id ? 0 : 1);
export function pickPass(passes: PassRow[], course: { id: string; kind: 'GENERAL' | 'PRO' }, today: string) {
  return passes.filter((p) => fits(p, course) && p.remaining > 0 && p.valid_from <= today && p.valid_to >= today)
    .sort((a, b) => rank(a) - rank(b) || a.valid_to.localeCompare(b.valid_to))[0];
}
export function attend(db: Db, a: { memberId: string; courseId: string; staffId: string | null; now?: Date }): AttendResult {
  const now = a.now ?? new Date(); const today = kstDate(now);
  return db.transaction((): AttendResult => {
    if (!db.prepare('select 1 from members where id=?').get(a.memberId)) return { ok: false, reason: 'UNKNOWN_MEMBER' };
    const course = db.prepare('select id, kind, instructor_id from courses where id=?').get(a.courseId) as { id: string; kind: 'GENERAL' | 'PRO'; instructor_id: string } | undefined;
    if (!course) return { ok: false, reason: 'UNKNOWN_COURSE', memberId: a.memberId };
    if (db.prepare('select 1 from attendances where member_id=? and course_id=? and attended_on=? and cancelled_at is null').get(a.memberId, course.id, today)) return { ok: false, reason: 'ALREADY', memberId: a.memberId };
    const passes = db.prepare('select id, kind, course_id, remaining, total_count, valid_from, valid_to from passes where member_id=?').all(a.memberId) as PassRow[];
    const p = pickPass(passes, course, today);
    if (!p) {
      const usable = passes.filter((x) => fits(x, course));
      if (course.kind === 'PRO' && !usable.length && passes.length) return { ok: false, reason: 'PRO_ONLY', memberId: a.memberId };
      if (!usable.length) return { ok: false, reason: 'NO_PASS', memberId: a.memberId };
      const latest = usable.sort((x, y) => y.valid_to.localeCompare(x.valid_to))[0];
      return { ok: false, reason: latest.valid_to < today || latest.valid_from > today ? 'EXPIRED' : 'EMPTY', memberId: a.memberId };
    }
    const id = newId();
    db.prepare('insert into attendances(id,member_id,pass_id,course_id,instructor_id,attended_on,attended_at,created_by) values(?,?,?,?,?,?,?,?)').run(id, a.memberId, p.id, course.id, course.instructor_id, today, nowIso(now), a.staffId);
    db.prepare('update passes set remaining = remaining - 1 where id=? and remaining > 0').run(p.id);
    return { ok: true, attendanceId: id, memberId: a.memberId, passId: p.id, remaining: p.remaining - 1, total: p.total_count, validTo: p.valid_to };
  })();
}
export function cancelAttendance(db: Db, id: string, staffId: string | null) {
  return db.transaction(() => {
    const r = db.prepare('select pass_id, cancelled_at from attendances where id=?').get(id) as { pass_id: string; cancelled_at: string | null } | undefined;
    if (!r || r.cancelled_at) return false;
    db.prepare('update attendances set cancelled_at=?, cancelled_by=? where id=?').run(nowIso(), staffId, id);
    db.prepare('update passes set remaining = remaining + 1 where id=?').run(r.pass_id);
    audit(db, staffId, 'attendance.cancel', 'attendance', id);
    return true;
  })();
}
```

Note: EMPTY vs EXPIRED 판정에서 "기간 안인데 횟수 0" 이면 EMPTY. 테스트 a(remaining 0, 기간 안)=EMPTY, b(기간 지남)=EXPIRED 확인.

- [ ] **Step 4: 통과 확인** → PASS
- [ ] **Step 5: Commit** `feat(server): attendance transaction with pass ranking`

---

### Task 4: 결제 적재·연결·취소

**Files:**
- Create: `server/src/domain/payments.ts`, `server/test/payments.test.ts`

**Interfaces:**
- Consumes: Task 1~3
- Produces:
```ts
export type PaymentInput = { source: 'KIOSK' | 'MANUAL'; externalId?: string | null; paidAt: string; amount: number; payerName?: string | null; payerPhone?: string | null; productName: string; status?: 'APPROVED' | 'CANCELLED'; raw?: unknown };
export function ingestPayments(db: Db, rows: PaymentInput[], staffId: string | null): { added: number; dup: number; matched: number };
export function assignPayment(db: Db, paymentId: string, memberId: string, staffId: string | null): { passId: string | null };
export class PassInUseError extends Error { constructor(public used: number) }
export function cancelPayment(db: Db, paymentId: string, staffId: string | null): void; // 출석에 쓰였으면 PassInUseError
export function findProduct(db: Db, productName: string): ProductRow | undefined; // 정확 일치 → 포함 관계
```

- [ ] **Step 1: 실패하는 테스트**

```ts
// server/test/payments.test.ts
import { describe, it, expect } from 'vitest';
import { makeDb } from './fixtures';
import { ingestPayments, assignPayment, cancelPayment, PassInUseError } from '../src/domain/payments';
import { attend } from '../src/domain/attendance';
const row = (o: any = {}) => ({ source: 'KIOSK' as const, externalId: '30000001', paidAt: '2026-10-19T09:12:00Z', amount: 180000, payerName: '김서연', payerPhone: '010-1111-2222', productName: '정규 클래스 8회권', ...o });
describe('payments', () => {
  it('dedupes by approval number, matches phone, creates pass from product', () => {
    const { db, member } = makeDb(); const m = member('김서연', '01011112222');
    expect(ingestPayments(db, [row(), row()], null)).toEqual({ added: 1, dup: 1, matched: 1 });
    expect(ingestPayments(db, [row()], null)).toEqual({ added: 0, dup: 1, matched: 0 });
    const p = db.prepare('select * from passes where member_id=?').get(m) as any;
    expect(p).toMatchObject({ kind: 'COUNT', total_count: 8, remaining: 8, valid_from: '2026-10-19', valid_to: '2026-12-18', price: 180000 });
  });
  it('dedupes rows without approval number by phone+time+amount', () => {
    const { db } = makeDb();
    expect(ingestPayments(db, [row({ externalId: null }), row({ externalId: null })], null)).toMatchObject({ added: 1, dup: 1 });
  });
  it('leaves unmatched payments for manual assignment', () => {
    const { db, member } = makeDb(); const m = member('신예은', '01099998888');
    ingestPayments(db, [row({ payerPhone: '' })], null);
    const pay = db.prepare('select id, member_id from payments').get() as any;
    expect(pay.member_id).toBeNull();
    expect(assignPayment(db, pay.id, m, 'st').passId).toBeTruthy();
    expect(assignPayment(db, pay.id, m, 'st').passId).toBeNull(); // 두 번째는 아무것도 안 만든다
    expect((db.prepare('select count(*) n from passes').get() as any).n).toBe(1);
  });
  it('unknown product name keeps payment but creates no pass', () => {
    const { db, member } = makeDb(); member();
    ingestPayments(db, [row({ productName: '음료' })], null);
    expect((db.prepare('select count(*) n from passes').get() as any).n).toBe(0);
    expect((db.prepare('select member_id from payments').get() as any).member_id).toBeTruthy();
  });
  it('refuses to cancel a payment whose pass was used', () => {
    const { db, member, course } = makeDb(); const m = member(); ingestPayments(db, [row()], null);
    const pay = db.prepare('select id from payments').get() as any;
    attend(db, { memberId: m, courseId: course().id, staffId: null, now: new Date('2026-10-19T10:30:00Z') });
    expect(() => cancelPayment(db, pay.id, 'st')).toThrow(PassInUseError);
    expect((db.prepare('select status from payments').get() as any).status).toBe('APPROVED');
  });
  it('cancels an unused payment and removes its pass', () => {
    const { db, member } = makeDb(); member(); ingestPayments(db, [row()], null);
    const pay = db.prepare('select id from payments').get() as any;
    cancelPayment(db, pay.id, 'st');
    expect((db.prepare('select status from payments').get() as any).status).toBe('CANCELLED');
    expect((db.prepare('select count(*) n from passes').get() as any).n).toBe(0);
  });
});
```

Run → FAIL.

- [ ] **Step 2: 구현**

```ts
// server/src/domain/payments.ts
import type { Db } from '../db';
import { newId, nowIso, kstDate, addDays, normalizePhone } from '../util';
import { audit } from '../audit';
export type PaymentInput = { source: 'KIOSK' | 'MANUAL'; externalId?: string | null; paidAt: string; amount: number; payerName?: string | null; payerPhone?: string | null; productName: string; status?: 'APPROVED' | 'CANCELLED'; raw?: unknown };
type ProductRow = { id: string; name: string; course_id: string | null; pass_kind: 'COUNT' | 'PERIOD'; count: number; period_days: number };
export class PassInUseError extends Error { constructor(public used: number) { super(`pass used ${used} times`); } }
export function findProduct(db: Db, name: string) {
  const all = db.prepare('select id,name,course_id,pass_kind,count,period_days from products where active=1').all() as ProductRow[];
  const n = name.trim();
  return all.find((p) => p.name.trim() === n) ?? all.find((p) => n.includes(p.name) || p.name.includes(n));
}
function createPass(db: Db, paymentId: string, memberId: string, productName: string, paidAt: string, amount: number) {
  const prod = findProduct(db, productName); if (!prod) return null;
  const from = kstDate(new Date(paidAt)); const id = newId();
  db.prepare('insert into passes(id,member_id,product_id,course_id,kind,total_count,remaining,valid_from,valid_to,payment_id,price,created_at) values(?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, memberId, prod.id, prod.course_id, prod.pass_kind, prod.count, prod.count, from, addDays(from, prod.period_days), paymentId, amount, nowIso());
  return id;
}
export function assignPayment(db: Db, paymentId: string, memberId: string, staffId: string | null) {
  return db.transaction(() => {
    const p = db.prepare('select * from payments where id=?').get(paymentId) as any;
    if (!p || p.pass_id || p.status !== 'APPROVED') return { passId: null };
    const passId = createPass(db, p.id, memberId, p.product_name, p.paid_at, p.amount);
    db.prepare('update payments set member_id=?, pass_id=? where id=?').run(memberId, passId, p.id);
    audit(db, staffId, 'payment.assign', 'payment', p.id, { memberId, passId });
    return { passId };
  })();
}
export function ingestPayments(db: Db, rows: PaymentInput[], staffId: string | null) {
  return db.transaction(() => {
    let added = 0, dup = 0, matched = 0;
    const seen = new Set<string>();
    for (const r of rows) {
      const phone = normalizePhone(r.payerPhone);
      const key = r.externalId ? 'x:' + r.externalId : `k:${phone}|${r.paidAt}|${r.amount}`;
      const exists = seen.has(key) || (r.externalId
        ? db.prepare('select 1 from payments where external_id=?').get(r.externalId)
        : db.prepare('select 1 from payments where external_id is null and payer_phone=? and paid_at=? and amount=?').get(phone, r.paidAt, r.amount));
      if (exists) { dup++; continue; }
      seen.add(key);
      const id = newId();
      db.prepare('insert into payments(id,source,external_id,paid_at,amount,payer_name,payer_phone,product_name,status,raw_json,created_by,created_at) values(?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, r.source, r.externalId ?? null, r.paidAt, Math.round(r.amount), r.payerName ?? null, phone, r.productName, r.status ?? 'APPROVED', r.raw === undefined ? null : JSON.stringify(r.raw), staffId, nowIso());
      added++;
      if ((r.status ?? 'APPROVED') !== 'APPROVED' || !phone) continue;
      const m = db.prepare('select id from members where phone=?').all(phone) as { id: string }[];
      if (m.length === 1) { assignPayment(db, id, m[0].id, staffId); matched++; }
    }
    return { added, dup, matched };
  })();
}
export function cancelPayment(db: Db, paymentId: string, staffId: string | null) {
  db.transaction(() => {
    const p = db.prepare('select id, pass_id from payments where id=?').get(paymentId) as { id: string; pass_id: string | null } | undefined;
    if (!p) return;
    if (p.pass_id) {
      const used = (db.prepare('select count(*) n from attendances where pass_id=? and cancelled_at is null').get(p.pass_id) as { n: number }).n;
      if (used > 0) throw new PassInUseError(used);
      db.prepare('delete from attendances where pass_id=?').run(p.pass_id);
      db.prepare('delete from passes where id=?').run(p.pass_id);
    }
    db.prepare("update payments set status='CANCELLED', pass_id=null where id=?").run(p.id);
    audit(db, staffId, 'payment.cancel', 'payment', p.id);
  })();
}
```

같은 전화번호 회원이 2명 이상이면 자동 연결하지 않는다(사람이 고른다) — 테스트 하나 추가:

```ts
  it('does not auto-assign when two members share the phone', () => {
    const { db, member } = makeDb(); member('가', '01011112222'); member('나', '01011112222');
    expect(ingestPayments(db, [row()], null).matched).toBe(0);
  });
```

- [ ] **Step 3: 통과 확인** → PASS
- [ ] **Step 4: Commit** `feat(server): payment ingest, assign, guarded cancel`

---

### Task 5: 정산

**Files:**
- Create: `server/src/domain/settlement.ts`, `server/test/settlement.test.ts`

**Interfaces:**
- Produces: `settle(db, month: 'YYYY-MM'): SettlementLine[]`, `SettlementLine = { instructorId, name, type: 'RATIO'|'PER_SESSION', ratioInstructor, perSessionFee, sessions, heads, revenue, instructorPay, academyPay, proTickets }` — 프로토타입 `src/lib/settlement.ts` 와 같은 규칙. 월 범위는 `attended_on like 'YYYY-MM-%'`.

- [ ] **Step 1: 실패하는 테스트**

```ts
import { it, expect } from 'vitest';
import { makeDb } from './fixtures';
import { attend } from '../src/domain/attendance';
import { settle } from '../src/domain/settlement';
it('ratio, per-session and monthly pass rules', () => {
  const { db, member, pass, course } = makeDb();
  const c = course(); const ins = c.instructor_id;
  const a = member('가', '01000000001'); pass(a, { total: 8, remaining: 8 }); // 180000/8 = 22500
  const b = member('나', '01000000002'); pass(b, { kind: 'PERIOD', total: 12, remaining: 12 });
  attend(db, { memberId: a, courseId: c.id, staffId: null, now: new Date('2026-10-19T10:30:00Z') });
  attend(db, { memberId: b, courseId: c.id, staffId: null, now: new Date('2026-10-19T10:31:00Z') });
  attend(db, { memberId: a, courseId: c.id, staffId: null, now: new Date('2026-11-02T10:30:00Z') }); // 다른 달
  let line = settle(db, '2026-10').find((l) => l.instructorId === ins)!;
  expect(line).toMatchObject({ sessions: 1, heads: 2, revenue: 22500, instructorPay: 11250, academyPay: 11250, proTickets: 1 });
  db.prepare("update instructors set settlement_type='PER_SESSION', per_session_fee=40000 where id=?").run(ins);
  line = settle(db, '2026-10').find((l) => l.instructorId === ins)!;
  expect(line).toMatchObject({ sessions: 1, instructorPay: 40000, academyPay: 22500 });
});
```

- [ ] **Step 2: 구현**

```ts
import type { Db } from '../db';
export type SettlementLine = { instructorId: string; name: string; type: 'RATIO' | 'PER_SESSION'; ratioInstructor: number; perSessionFee: number; sessions: number; heads: number; revenue: number; instructorPay: number; academyPay: number; proTickets: number };
export function settle(db: Db, month: string): SettlementLine[] {
  const ins = db.prepare('select id, name, settlement_type, ratio_instructor, per_session_fee from instructors').all() as any[];
  const att = db.prepare(`select a.instructor_id, a.course_id, a.attended_on, p.kind, p.price, p.total_count from attendances a join passes p on p.id=a.pass_id where a.cancelled_at is null and a.attended_on like ?`).all(month + '-%') as any[];
  return ins.map((i) => {
    const mine = att.filter((a) => a.instructor_id === i.id);
    const sessions = new Set(mine.map((a) => a.course_id + '@' + a.attended_on)).size;
    let revenue = 0, pro = 0;
    for (const a of mine) { if (a.kind === 'PERIOD') { pro++; continue; } revenue += a.total_count > 0 ? a.price / a.total_count : 0; }
    revenue = Math.round(revenue);
    const pay = i.settlement_type === 'RATIO' ? Math.round((revenue * i.ratio_instructor) / 100) : sessions * i.per_session_fee;
    return { instructorId: i.id, name: i.name, type: i.settlement_type, ratioInstructor: i.ratio_instructor, perSessionFee: i.per_session_fee, sessions, heads: mine.length, revenue, instructorPay: pay, academyPay: revenue - (i.settlement_type === 'RATIO' ? pay : 0), proTickets: pro };
  });
}
```

- [ ] **Step 3: 통과** / **Step 4: Commit** `feat(server): settlement`

---

### Task 6: 인증 (비밀번호, 세션, 로그인 제한, CLI)

**Files:**
- Create: `server/src/auth/password.ts`, `server/src/auth/sessions.ts`, `server/src/auth/rateLimit.ts`, `server/src/cli.ts`, `server/test/auth.test.ts`

**Interfaces:**
- Produces: `hashPassword(pw): Promise<string>` (형식 `scrypt$N$r$p$saltHex$hashHex`), `verifyPassword(pw, stored): Promise<boolean>`
- Produces: `createSession(db, staffId, now?): string` (평문 토큰 반환, 32바이트 base64url), `getSession(db, token, now?): { staffId, role, name, loginId } | null` (만료 검사, last_seen 갱신, 만료 30일 연장), `deleteSession(db, token)`
- Produces: `class LoginLimiter { constructor(max=5, windowMs=600000); hit(key, now=Date.now()): boolean /* true=허용 */; reset(key) }`
- Produces: `createStaff(db, {loginId, name, role, password}): Promise<string>`
- CLI: `npm run cli -- create-owner <loginId> <name>` (비밀번호는 stdin 또는 `SP_PASSWORD`), `reset-password <loginId>`, `create-desk <loginId> <name>`

- [ ] **Step 1: 실패하는 테스트**

```ts
import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db';
import { hashPassword, verifyPassword } from '../src/auth/password';
import { createSession, getSession, deleteSession, createStaff } from '../src/auth/sessions';
import { LoginLimiter } from '../src/auth/rateLimit';
describe('auth', () => {
  it('hashes and verifies', async () => {
    const h = await hashPassword('depth-2026!');
    expect(h.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('depth-2026!', h)).toBe(true);
    expect(await verifyPassword('wrong', h)).toBe(false);
  });
  it('session lifecycle with expiry', async () => {
    const db = openDb(':memory:');
    const id = await createStaff(db, { loginId: 'owner', name: '원장', role: 'OWNER', password: 'pw-123456' });
    const t = createSession(db, id, new Date('2026-10-01T00:00:00Z'));
    expect(getSession(db, t, new Date('2026-10-20T00:00:00Z'))).toMatchObject({ staffId: id, role: 'OWNER' });
    expect(getSession(db, t, new Date('2026-12-30T00:00:00Z'))).toBeNull();
    const t2 = createSession(db, id); deleteSession(db, t2); expect(getSession(db, t2)).toBeNull();
    expect((db.prepare('select token_hash from sessions limit 1').get() as any)?.token_hash ?? '').not.toBe(t);
  });
  it('inactive staff cannot use sessions', async () => {
    const db = openDb(':memory:');
    const id = await createStaff(db, { loginId: 'desk', name: '인포', role: 'DESK', password: 'pw-123456' });
    const t = createSession(db, id); db.prepare('update staff set active=0').run();
    expect(getSession(db, t)).toBeNull();
  });
  it('limits 5 tries per 10 minutes', () => {
    const l = new LoginLimiter(5, 600000);
    for (let i = 0; i < 5; i++) expect(l.hit('ip|owner', 1000)).toBe(true);
    expect(l.hit('ip|owner', 2000)).toBe(false);
    expect(l.hit('ip|owner', 1000 + 600001)).toBe(true);
  });
});
```

- [ ] **Step 2: 구현**

```ts
// server/src/auth/password.ts
import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto';
const N = 32768, R = 8, P = 1, LEN = 32;
const run = (pw: string, salt: Buffer, n: number, r: number, p: number) => new Promise<Buffer>((ok, no) => scrypt(pw, salt, LEN, { N: n, r, p, maxmem: 128 * n * r * 2 }, (e, k) => (e ? no(e) : ok(k))));
export async function hashPassword(pw: string) { const salt = randomBytes(16); const k = await run(pw, salt, N, R, P); return `scrypt$${N}$${R}$${P}$${salt.toString('hex')}$${k.toString('hex')}`; }
export async function verifyPassword(pw: string, stored: string) {
  const [alg, n, r, p, salt, hash] = stored.split('$'); if (alg !== 'scrypt') return false;
  const k = await run(pw, Buffer.from(salt, 'hex'), +n, +r, +p); const want = Buffer.from(hash, 'hex');
  return k.length === want.length && timingSafeEqual(k, want);
}
```

```ts
// server/src/auth/sessions.ts
import { randomBytes, createHash } from 'node:crypto';
import type { Db } from '../db';
import { newId, nowIso } from '../util';
import { hashPassword } from './password';
const DAY = 86400000, TTL = 30 * DAY;
const h = (t: string) => createHash('sha256').update(t).digest('hex');
export async function createStaff(db: Db, s: { loginId: string; name: string; role: 'OWNER' | 'DESK'; password: string }) {
  if (s.password.length < 8) throw new Error('password must be at least 8 characters');
  const id = newId();
  db.prepare('insert into staff(id,login_id,name,role,pw_hash,created_at) values(?,?,?,?,?,?)').run(id, s.loginId, s.name, s.role, await hashPassword(s.password), nowIso());
  return id;
}
export function createSession(db: Db, staffId: string, now = new Date()) {
  const t = randomBytes(32).toString('base64url');
  db.prepare('insert into sessions(token_hash,staff_id,created_at,expires_at,last_seen_at) values(?,?,?,?,?)').run(h(t), staffId, nowIso(now), new Date(now.getTime() + TTL).toISOString(), nowIso(now));
  return t;
}
export function getSession(db: Db, token: string | undefined, now = new Date()) {
  if (!token) return null;
  const r = db.prepare('select s.staff_id, s.expires_at, st.role, st.name, st.login_id, st.active from sessions s join staff st on st.id=s.staff_id where s.token_hash=?').get(h(token)) as any;
  if (!r || !r.active || r.expires_at <= nowIso(now)) return null;
  db.prepare('update sessions set last_seen_at=?, expires_at=? where token_hash=?').run(nowIso(now), new Date(now.getTime() + TTL).toISOString(), h(token));
  return { staffId: r.staff_id as string, role: r.role as 'OWNER' | 'DESK', name: r.name as string, loginId: r.login_id as string };
}
export const deleteSession = (db: Db, token: string) => { db.prepare('delete from sessions where token_hash=?').run(h(token)); };
```

```ts
// server/src/auth/rateLimit.ts
export class LoginLimiter {
  private m = new Map<string, number[]>();
  constructor(private max = 5, private windowMs = 600000) {}
  hit(key: string, now = Date.now()) { const a = (this.m.get(key) ?? []).filter((t) => now - t < this.windowMs); if (a.length >= this.max) { this.m.set(key, a); return false; } a.push(now); this.m.set(key, a); return true; }
  reset(key: string) { this.m.delete(key); }
}
```

`server/src/cli.ts`: argv 파싱, `openDb(process.env.SP_DB ?? 'data/studiopass.db')`, `seedIfEmpty`, 비밀번호는 `SP_PASSWORD` 또는 `readline` 숨김 없이 한 줄 입력(개인 서버 콘솔용). `reset-password` 는 `update staff set pw_hash=? where login_id=?` + 그 직원 세션 전부 삭제. 출력에 비밀번호를 찍지 않는다.

- [ ] **Step 3: 통과** / **Step 4: Commit** `feat(server): password, sessions, login limiter, staff cli`

---

### Task 7: HTTP API (권한·직렬화·회원 링크 포함)

**Files:**
- Create: `server/src/links.ts`, `server/src/serialize.ts`, `server/src/app.ts`, `server/src/main.ts`, `server/test/api.test.ts`

**Interfaces:**
- Consumes: Task 1~6 전부
- Produces: `issueLink(db, memberId, staffId): string` (평문 토큰 22자 base64url, sha256 저장, 덮어쓰기), `memberIdForToken(db, token): string | null`
- Produces: `createApp(deps: { db: Db; secureCookies: boolean; allowedOrigin: string | null; staticDir?: string; now?: () => Date }): Hono`
- Produces (응답 형태, 웹 Task 8 이 쓴다):
```ts
type Bootstrap = {
  me: { staffId: string; name: string; role: 'OWNER' | 'DESK' };
  studioName: string; needsRealPrices: boolean;
  members: { id; memberNo; name; phone; memo; createdAt; tier: { name; level; count } }[];
  instructors: { id; name; crew; settlementType; ratioInstructor?; perSessionFee? }[];   // DESK: 정산 조건 제외
  courses: { id; name; instructorId; kind; hall; level; note; weekday: number[]; startTime; durationMin; active }[];
  products: { id; name; courseId; passKind; count; periodDays; price?; active }[];       // DESK: price 제외
  passes: { id; memberId; productId; courseId; kind; totalCount; remaining; validFrom; validTo; paymentId; price? }[];
  payments: { id; source; externalId; paidAt; amount?; payerName; payerPhone; productName; status; memberId; passId }[]; // 최근 62일 + 미연결 전부
  attendances: { id; memberId; passId; courseId; instructorId; attendedAt; attendedOn; cancelledAt }[];              // 최근 62일
  tiers: { name; minCount }[];
};
```
필드명은 웹 `src/types.ts` 와 맞춘다(camelCase, `count`/`periodDays`/`passKind`, `totalCount`, `weekday` 는 배열).

라우트 (전부 `/api` 아래, JSON):
| 메서드 경로 | 역할 | 동작 |
|---|---|---|
| POST /auth/login | 공개 | 제한 `ip|loginId`, 실패 401 `{error:'INVALID'}`, 제한 429 `{error:'LIMIT'}`, 성공 시 쿠키 + me |
| POST /auth/logout | 로그인 | 세션 삭제, 쿠키 만료 |
| GET /auth/me | 로그인 | me |
| GET /bootstrap | 로그인 | 위 Bootstrap, 역할별 직렬화 |
| POST /members | 로그인 | {name, phone, memo} → 회원(member_no = 올해-연번), 같은 전화 미연결 결제 자동 연결 |
| PATCH /members/:id | 로그인 | name/phone/memo |
| POST /members/:id/link | 로그인 | 재발급 → `{ url: '<origin>/m/<token>' }` (origin = allowedOrigin 또는 요청 Origin) |
| POST /members/:id/messages | 로그인 | messages 기록 `{channel:'SMS_LINK', kind:'LINK'}` |
| POST /attendances | 로그인 | `{qr?: string, memberId?: string, courseId}` → qr 있으면 `parseQr`, 실패 시 `{ok:false, reason:'UNKNOWN_QR'}`. 결과에 `member:{id,name}` 붙임 |
| POST /attendances/:id/cancel | 로그인 | 200 `{ok}` |
| POST /payments/import | 로그인 | `{rows: PaymentInput[]}` 최대 2000행 → 결과 |
| POST /payments | 로그인 | 직접 입력 1건(source MANUAL) + memberId 있으면 연결 |
| POST /payments/:id/assign | 로그인 | `{memberId}` |
| POST /payments/:id/cancel | 로그인 | PassInUseError → 409 `{error:'PASS_IN_USE', used}` |
| GET /settlement?month= | OWNER | SettlementLine[] |
| PUT /instructors/:id, PUT /courses/:id, PUT /products/:id, PUT /tiers | OWNER | upsert, audit |
| POST /staff, PATCH /staff/:id | OWNER | DESK 계정 생성·비활성 |
| GET /public/m/:token | 공개 | `{ studioName, name: maskName, since: 'YYYY-MM-DD', attendCount, tier:{name,level,count,nextName,nextAt}, tiers:[{name,minCount}], passes:[{name, remaining, total, validTo, kind}], qr }` 활성(기간 안, remaining>0) 수강권만. 없는 토큰 404. `Cache-Control: no-store` |
| GET /healthz | 공개 | `{ok:true}` + DB `select 1` |

공통 미들웨어: 변경 메서드(POST/PUT/PATCH/DELETE)에서 `allowedOrigin` 이 있으면 `Origin` 헤더가 같아야 함, 아니면 403. 로그인 필요 라우트는 세션 없으면 401. OWNER 전용은 403 `{error:'OWNER_ONLY'}`. 정적 파일: `staticDir` 이 있으면 `/m/*` → `member.html`, 그 외 GET 404 → `index.html`.

- [ ] **Step 1: 실패하는 테스트** (`server/test/api.test.ts`)

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/db';
import { seedIfEmpty } from '../src/domain/seed';
import { createStaff } from '../src/auth/sessions';
import { createApp } from '../src/app';
const ORIGIN = 'https://studio.test';
let db: any, app: any;
const req = (path: string, init: any = {}, cookie?: string) => app.request('/api' + path, { ...init, headers: { 'content-type': 'application/json', origin: ORIGIN, ...(cookie ? { cookie } : {}), ...(init.headers ?? {}) }, body: init.body ? JSON.stringify(init.body) : undefined });
const login = async (id: string, pw = 'pw-12345678') => { const r = await req('/auth/login', { method: 'POST', body: { loginId: id, password: pw } }); return (r.headers.get('set-cookie') ?? '').split(';')[0]; };
beforeEach(async () => {
  db = openDb(':memory:'); seedIfEmpty(db);
  await createStaff(db, { loginId: 'owner', name: '원장', role: 'OWNER', password: 'pw-12345678' });
  await createStaff(db, { loginId: 'desk', name: '인포', role: 'DESK', password: 'pw-12345678' });
  app = createApp({ db, secureCookies: false, allowedOrigin: ORIGIN, now: () => new Date('2026-10-19T10:30:00Z') });
});
describe('api', () => {
  it('requires login', async () => { expect((await req('/bootstrap')).status).toBe(401); });
  it('rejects wrong password and limits retries', async () => {
    for (let i = 0; i < 5; i++) expect((await req('/auth/login', { method: 'POST', body: { loginId: 'owner', password: 'x' } })).status).toBe(401);
    expect((await req('/auth/login', { method: 'POST', body: { loginId: 'owner', password: 'pw-12345678' } })).status).toBe(429);
  });
  it('blocks cross-origin writes', async () => {
    const c = await login('owner');
    expect((await req('/members', { method: 'POST', body: { name: '가', phone: '01000000000' }, headers: { origin: 'https://evil.test' } }, c)).status).toBe(403);
  });
  it('desk gets no money fields and no settlement', async () => {
    const c = await login('desk');
    const b = await (await req('/bootstrap', {}, c)).json();
    expect(b.me.role).toBe('DESK');
    expect(b.products[0]).not.toHaveProperty('price');
    expect(b.instructors[0]).not.toHaveProperty('ratioInstructor');
    expect((await req('/settlement?month=2026-10', {}, c)).status).toBe(403);
    expect((await req('/products/p_one', { method: 'PUT', body: { name: 'x' } }, c)).status).toBe(403);
    const o = await login('owner');
    expect((await (await req('/bootstrap', {}, o)).json()).products[0]).toHaveProperty('price');
  });
  it('member, kiosk import, QR attendance, member page', async () => {
    const c = await login('desk');
    const m = await (await req('/members', { method: 'POST', body: { name: '김서연', phone: '010-1111-2222' } }, c)).json();
    const imp = await (await req('/payments/import', { method: 'POST', body: { rows: [{ source: 'KIOSK', externalId: '1', paidAt: '2026-10-19T09:00:00Z', amount: 180000, payerName: '김서연', payerPhone: '01011112222', productName: '정규 클래스 8회권' }] } }, c)).json();
    expect(imp).toMatchObject({ added: 1, matched: 1 });
    const { url } = await (await req(`/members/${m.id}/link`, { method: 'POST' }, c)).json();
    const token = url.split('/m/')[1];
    const page = await (await req('/public/m/' + token)).json();
    expect(page).toMatchObject({ name: '김*연', attendCount: 0, tier: { name: 'DEPTH 1' } });
    expect(JSON.stringify(page)).not.toMatch(/180000|01011112222/);
    const course = db.prepare("select id from courses where kind='GENERAL' limit 1").get();
    const r = await (await req('/attendances', { method: 'POST', body: { qr: page.qr, courseId: course.id } }, c)).json();
    expect(r).toMatchObject({ ok: true, remaining: 7, member: { name: '김서연' } });
    expect(await (await req('/attendances', { method: 'POST', body: { qr: page.qr, courseId: course.id } }, c)).json()).toMatchObject({ ok: false, reason: 'ALREADY' });
    expect(await (await req('/attendances', { method: 'POST', body: { qr: 'AM1:x:y', courseId: course.id } }, c)).json()).toMatchObject({ ok: false, reason: 'UNKNOWN_QR' });
    const again = await (await req(`/members/${m.id}/link`, { method: 'POST' }, c)).json();
    expect((await req('/public/m/' + token)).status).toBe(404);
    expect((await req('/public/m/' + again.url.split('/m/')[1])).status).toBe(200);
    expect((await req('/public/m/nonexistenttoken000000')).status).toBe(404);
  });
  it('payment cancel conflict is 409', async () => {
    const c = await login('owner');
    await req('/members', { method: 'POST', body: { name: '가', phone: '01000000001' } }, c);
    await req('/payments/import', { method: 'POST', body: { rows: [{ source: 'KIOSK', externalId: '9', paidAt: '2026-10-19T09:00:00Z', amount: 100000, payerName: '가', payerPhone: '01000000001', productName: '정규 클래스 4회권' }] } }, c);
    const b = await (await req('/bootstrap', {}, c)).json();
    const course = b.courses.find((x: any) => x.kind === 'GENERAL');
    await req('/attendances', { method: 'POST', body: { memberId: b.members[0].id, courseId: course.id } }, c);
    const r = await req(`/payments/${b.payments[0].id}/cancel`, { method: 'POST' }, c);
    expect(r.status).toBe(409); expect(await r.json()).toMatchObject({ error: 'PASS_IN_USE', used: 1 });
  });
});
```

- [ ] **Step 2: 구현 요지**

`server/src/links.ts`:

```ts
import { randomBytes, createHash } from 'node:crypto';
import type { Db } from './db';
import { nowIso } from './util';
import { audit } from './audit';
const h = (t: string) => createHash('sha256').update(t).digest('hex');
export function issueLink(db: Db, memberId: string, staffId: string | null) {
  const t = randomBytes(16).toString('base64url');
  db.prepare('insert into member_links(member_id,token_hash,issued_at,issued_by) values(?,?,?,?) on conflict(member_id) do update set token_hash=excluded.token_hash, issued_at=excluded.issued_at, issued_by=excluded.issued_by').run(memberId, h(t), nowIso(), staffId);
  audit(db, staffId, 'member.link', 'member', memberId);
  return t;
}
export const memberIdForToken = (db: Db, token: string) => (/^[A-Za-z0-9_-]{16,64}$/.test(token) ? ((db.prepare('select member_id from member_links where token_hash=?').get(h(token)) as { member_id: string } | undefined)?.member_id ?? null) : null);
```

`server/src/serialize.ts`: row→camelCase 매퍼 함수들(`toMember`, `toInstructor(role)`, `toProduct(role)`, `toPass(role)`, `toPayment(role)`, `toCourse`, `toAttendance`). DESK 이면 `price`, `amount`, `ratioInstructor`, `perSessionFee` 키 자체를 넣지 않는다. `courses.weekday` 는 `[row.weekday]` 로.

`server/src/app.ts`: Hono 앱. `getCookie/setCookie` 는 `hono/cookie`. 세션 미들웨어가 `c.set('me', session)`. 회원 번호 = `${year}-${(해당 연도 접두 회원 수 + 1) 4자리}`. `POST /members` 에서 같은 전화 미연결 승인 결제를 `assignPayment` 로 연결. 오류는 JSON `{error}`. `now` 주입은 `attend(..., now: deps.now?.())` 에만 쓴다.

`server/src/main.ts`:

```ts
import { serve } from '@hono/node-server';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { openDb } from './db';
import { seedIfEmpty } from './domain/seed';
import { createApp } from './app';
const file = process.env.SP_DB ?? 'data/studiopass.db';
mkdirSync(dirname(file), { recursive: true });
const db = openDb(file); seedIfEmpty(db);
db.prepare("delete from sessions where expires_at < ?").run(new Date().toISOString());
const app = createApp({ db, secureCookies: process.env.NODE_ENV === 'production', allowedOrigin: process.env.SP_ORIGIN ?? null, staticDir: process.env.SP_STATIC });
serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 8787), hostname: '0.0.0.0' });
console.log('studiopass api listening');
```

정적 서빙은 `@hono/node-server/serve-static` 의 `serveStatic({ root: staticDir })`, SPA 폴백은 `readFileSync(join(staticDir,'index.html'))`.

- [ ] **Step 3: 통과 확인** `cd server && npx vitest run` → 전부 PASS, `npm run build` → PASS
- [ ] **Step 4: Commit** `feat(server): http api with roles, member links, public member page`

---

### Task 8: 웹 앱을 서버에 연결 (로그인·권한·오프라인)

**Files:**
- Create: `src/api/client.ts`, `src/store/demo.ts`, `src/store/remote.ts`, `src/pages/Login.tsx`, `src/components/OfflineBar.tsx`, `.env.demo`
- Modify: `src/store.ts`, `src/App.tsx`, `src/pages/Today.tsx`, `src/pages/Scan.tsx`, `src/pages/Members.tsx`, `src/pages/Payments.tsx`, `src/pages/Settlement.tsx`, `src/pages/Settings.tsx`, `src/types.ts`, `vite.config.ts`, `package.json`, `.github/workflows/*` (Pages 는 demo 빌드)

**Interfaces:**
- Consumes: Task 7 의 라우트와 Bootstrap 형태
- Produces: `useStore` 는 지금 상태 필드 + `me: {name, role} | null`, `ready: boolean`, `online: boolean` 를 가진다. 액션은 전부 Promise 를 반환한다:
```ts
load(): Promise<void>
login(loginId, password): Promise<{ ok: boolean; error?: 'INVALID' | 'LIMIT' }>
logout(): Promise<void>
addMember(m): Promise<Member>
updateMember(id, patch): Promise<void>
issueLink(memberId): Promise<string>            // URL
recordMessage(memberId): Promise<void>
attend(input: { qr?: string; memberId?: string; courseId: string }): Promise<ScanResult>
cancelAttendance(id): Promise<void>
importPayments(rows): Promise<{ added; dup; matched }>
addPayment(p): Promise<void>
assignPayment(paymentId, memberId): Promise<void>
cancelPayment(paymentId): Promise<{ ok: true } | { ok: false; used: number }>
upsertInstructor(i) / upsertCourse(c) / upsertProduct(p): Promise<void>
settlement(month): Promise<SettlementLine[]>
reset(): Promise<void>                           // demo 전용
```
- `ScanResult` 의 실패 사유는 서버 코드(`ALREADY` 등)를 화면 문구로 바꾸는 표를 `src/lib/reasons.ts` 에 둔다: UNKNOWN_QR "이 스튜디오의 QR 이 아니에요", UNKNOWN_MEMBER "등록되지 않은 회원이에요", ALREADY "오늘 이 수업은 이미 출석했어요", PRO_ONLY "전문반 수업이에요. 전문반 수강권이 필요해요", EMPTY "남은 횟수가 없어요. 결제가 필요해요", EXPIRED "수강권 기간이 지났어요", NO_PASS "이 수업에 쓸 수강권이 없어요".

모드: `import.meta.env.VITE_MODE === 'demo'` → `demo.ts`(지금 `store.ts` 로직을 옮기고 각 액션을 `async` 로 감싼 것, QR 은 AM1 그대로, 로그인 없음, me = {name:'데모', role:'OWNER'}). 그 외 → `remote.ts`.

- [ ] **Step 1:** 지금 `src/store.ts` 를 `src/store/demo.ts` 로 옮기고 액션을 async 로. `src/store.ts` 는 모드에 따라 하나를 export. `npm run build` 통과 확인 후 커밋 `refactor(web): async store actions, demo implementation`.
- [ ] **Step 2:** `src/api/client.ts`:
```ts
export class ApiError extends Error { constructor(public status: number, public body: any) { super(body?.error ?? String(status)); } }
export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const r = await fetch('/api' + path, { method: init.method ?? 'GET', credentials: 'same-origin', headers: init.body ? { 'content-type': 'application/json' } : undefined, body: init.body ? JSON.stringify(init.body) : undefined });
  const body = r.headers.get('content-type')?.includes('json') ? await r.json() : null;
  if (!r.ok) throw new ApiError(r.status, body);
  return body as T;
}
```
`src/store/remote.ts`: `load()` = `/auth/me` → 401 이면 `me=null, ready=true`; 아니면 `/bootstrap` 으로 상태 채움. 변경 액션은 API 호출 후 `load()` 를 다시 부른다(학원 규모라 단순하게). `attend` 는 응답만 쓰고 `load()` 는 뒤에서. 네트워크 오류(`TypeError`) 시 `online=false`.
- [ ] **Step 3:** `src/pages/Login.tsx`: THE DEPTH 디자인(주황 바탕, 로고, 큰 SATURDAY 대신 "로그인"), 아이디·비밀번호 입력 2개(`id="login-id"`, `id="login-pw"`), "로그인" 버튼. 실패 문구: INVALID "아이디나 비밀번호가 맞지 않아요", LIMIT "여러 번 틀려서 10분 동안 막혔어요". `App.tsx` 는 `ready` 전에는 빈 화면, `me` 없으면 Login.
- [ ] **Step 4:** 역할: DESK 면 `TABS` 에서 `settle` 제외, 설정 탭(`settings`)도 제외, 금액 표시 칸(`won(...)`)은 값이 없으면 렌더하지 않는다(Members 수강권 가격, Payments 금액, Today 없음). 헤더에 이름 + "로그아웃" 버튼.
- [ ] **Step 5:** `OfflineBar`: `online` 이 false 이거나 `navigator.onLine` 이 false 면 화면 위 검정 띠 "인터넷 연결이 끊겼어요. 다시 연결되면 이름으로 출석을 넣어주세요". `online`/`offline` 이벤트 구독. Scan 화면은 오프라인일 때 카메라 스캔 결과를 처리하지 않고 같은 문구를 스포트라이트로 보여준다.
- [ ] **Step 6:** Scan: 카메라 결과 텍스트를 그대로 `attend({ qr: text, courseId })` 로 보낸다(remote). 이름 검색은 `attend({ memberId, courseId })`. demo 는 지금처럼 `parseQr` 로 id 를 얻어 처리.
- [ ] **Step 7:** Members 상세: QR 티켓의 QR 은 remote 에서 서버가 준 문자열을 써야 하므로 "링크 문자 보내기" 버튼을 추가한다. 누르면 `issueLink` → URL. 폰(`/Android|iPhone/i.test(navigator.userAgent)`)이면 `location.href = 'sms:' + phone + '?body=' + encodeURIComponent('[THE DEPTH] ' + name + '님 회원 페이지예요. 출석할 때 이 화면의 QR 을 보여주세요.\n' + url)`, PC 면 클립보드 복사 후 토스트 "링크를 복사했어요". 둘 다 `recordMessage`. 기존 "QR 보내기"(PNG) 버튼은 demo 에서만 보인다. remote 에서 관리자 화면의 QR 미리보기는 숨긴다(회원 페이지가 QR 의 유일한 출처).
- [ ] **Step 8:** Payments: 엑셀 파싱은 그대로, 결과 rows 를 `importPayments` 로. 취소 실패 `{ok:false, used}` → 토스트 "이 수강권으로 출석 n회가 있어서 취소할 수 없어요. 출석을 먼저 취소해 주세요".
- [ ] **Step 9:** Settlement: `settlement(month)` 결과로 렌더(remote), demo 는 지금 `settle()`. Settings: 저장 버튼이 upsert 액션 호출. `needsRealPrices` 면 설정 맨 위에 검정 띠 "수강권 가격과 강사 정산 조건이 아직 예시값이에요. 실제 값으로 바꿔주세요".
- [ ] **Step 10:** `vite.config.ts`: `server.proxy = { '/api': 'http://localhost:8787' }`, 다중 진입 `build.rollupOptions.input = { main: 'index.html', member: 'member.html' }` (Task 9 에서 member.html 생성, 이 태스크에서는 index 만), `base` 는 demo 모드면 `'./'`, 아니면 `'/'`. `package.json` scripts: `"build:demo": "tsc -b && vite build --mode demo"`, `.env.demo` 에 `VITE_MODE=demo`. Pages 워크플로는 `npm run build:demo`.
- [ ] **Step 11: 검증** `npm run lint && npm run build && npm run build:demo` 통과. 서버(`cd server && SP_DB=/tmp/sp.db npm run cli -- create-owner owner 원장` with `SP_PASSWORD`) + `npm run dev` 로 헤드리스 Chrome 확인은 Task 11 에서 한 번에 한다.
- [ ] **Step 12: Commit** `feat(web): login, roles, server-backed store, offline bar`

---

### Task 9: 회원 페이지 (`/m/:token`)

**Files:**
- Create: `member.html`, `src/member/main.tsx`, `src/member/MemberPage.tsx`, `src/member/member.css`, `public/member-manifest.webmanifest`
- Modify: `vite.config.ts` (member 진입 추가)

**Interfaces:**
- Consumes: `GET /api/public/m/:token` 응답(Task 7)
- Produces: 정적 `member.html` (서버가 `/m/*` 에 돌려준다)

디자인은 `docs/mockups/member-page.html` 확정안 그대로: 검정 화면(#0d0d0d), 왼쪽 위 로고(반전), 오른쪽 위 DEPTH 줄 4개(켜진 수 = tier.level, 폭 46/38/30/22px, 높이 5px, 켜짐 #ec6f1b, 꺼짐 rgba(240,240,240,.18)) + 등급 이름, 이름 32px 900, "YYYY.MM.DD 등록 · 출석 N회째", 흰 바탕 QR(`qrcode` 패키지 `toCanvas`, margin 0), "데스크에서 이 QR 을 보여주세요", 아래 수강권 목록(각 행: 이름, "M.D까지", 남은 횟수 큰 숫자 주황 + "회 남음"). 수강권이 없으면 "지금 쓸 수 있는 수강권이 없어요. 데스크에 문의해 주세요". 다음 등급까지 남은 횟수 한 줄("DEPTH 3 까지 7회"), 최고 등급이면 생략.

- [ ] **Step 1:** `member.html` (`<meta name="theme-color" content="#0d0d0d">`, `apple-mobile-web-app-capable`, manifest 링크, Pretendard + Archivo 폰트 링크는 `index.html` 과 같게).
- [ ] **Step 2:** `MemberPage.tsx`: `location.pathname` 의 `/m/<token>` 에서 토큰을 꺼내 fetch. 로딩 중엔 검정 화면에 로고만. 404 면 "이 링크는 더 이상 쓸 수 없어요. 데스크에서 새 링크를 받아주세요". 네트워크 오류면 "인터넷에 연결되면 다시 열어주세요" + 마지막 성공 응답을 `localStorage['sp-member-'+token]` 에서 꺼내 QR 만 보여준다(try/catch). 화면 켜짐 유지: `navigator.wakeLock?.request('screen')` 실패 무시.
- [ ] **Step 3:** 브라우저 30초마다 재조회(화면이 보일 때만, `visibilitychange`), 출석 후 남은 횟수 갱신용.
- [ ] **Step 4: 검증** `npm run build` 후 `dist/member.html` 존재. 
- [ ] **Step 5: Commit** `feat(web): member page`

---

### Task 10: 컨테이너, 백업, 배포 스크립트, 런북

**Files:**
- Create: `deploy/Dockerfile`, `deploy/docker-compose.yml`, `deploy/Caddyfile`, `deploy/backup.sh`, `deploy/healthcheck.sh`, `deploy/crontab`, `scripts/deploy.sh`, `scripts/provision.sh`, `docs/RUNBOOK.md`, `.dockerignore`

**Interfaces:**
- Consumes: `server` 빌드(`npm run build`), 웹 빌드 `dist/`
- Produces: 이미지 `studiopass:<git sha>`, compose 서비스 `api`(포트 8787 내부), `caddy`(80/443)

- [ ] **Step 1: Dockerfile** (multi-stage)
```dockerfile
FROM node:22-bookworm-slim AS web
WORKDIR /w
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS srv
WORKDIR /w/server
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY server/package.json server/package-lock.json ./
RUN npm ci
COPY server ./
COPY shared ../shared
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends sqlite3 ca-certificates curl gzip && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=srv /w/server/node_modules server/node_modules
COPY --from=srv /w/server/dist server/dist
COPY --from=srv /w/server/migrations server/migrations
COPY --from=srv /w/server/package.json server/package.json
COPY --from=web /w/dist web
ENV NODE_ENV=production SP_DB=/data/studiopass.db SP_STATIC=/app/web SP_MIGRATIONS=/app/server/migrations PORT=8787
USER node
CMD ["node", "server/dist/server/src/main.js"]
```
- [ ] **Step 2: compose + Caddyfile**
```yaml
services:
  api:
    image: studiopass:${TAG}
    restart: unless-stopped
    environment: [ "SP_ORIGIN=https://${DOMAIN}" ]
    volumes: [ "/srv/studiopass/data:/data" ]
  caddy:
    image: caddy:2.8
    restart: unless-stopped
    ports: [ "80:80", "443:443" ]
    environment: [ "DOMAIN=${DOMAIN}" ]
    volumes: [ "./Caddyfile:/etc/caddy/Caddyfile:ro", "caddy_data:/data", "caddy_config:/config" ]
volumes: { caddy_data: {}, caddy_config: {} }
```
```
{$DOMAIN} {
  encode gzip
  header { Strict-Transport-Security "max-age=31536000" X-Content-Type-Options nosniff Referrer-Policy same-origin X-Frame-Options DENY }
  reverse_proxy api:8787
}
```
`/srv/studiopass/data` 는 uid 1000(node) 소유로 만든다.
- [ ] **Step 3: backup.sh** (호스트 cron, root): `sqlite3 /srv/studiopass/data/studiopass.db ".backup /tmp/sp.db"` → `gzip` → `aws s3 cp` 로 Lightsail 버킷 `s3://$BUCKET/daily/YYYY-MM-DD.db.gz` (버킷 전용 키, `/etc/studiopass/backup.env`, 600). 실패 시 `curl -d "studiopass 백업 실패" https://ntfy.sh/$NTFY_TOPIC`. 30일 지난 객체 삭제(`aws s3 ls` + 날짜 비교). 성공 여부를 `/var/log/studiopass-backup.log` 에.
- [ ] **Step 4: healthcheck.sh** (5분마다): `curl -fsS --max-time 10 https://$DOMAIN/api/healthz` 실패 2회 연속이면 ntfy "studiopass 응답 없음", 회복하면 "studiopass 응답 회복" (상태 파일 `/var/lib/studiopass/health`).
- [ ] **Step 5: scripts/deploy.sh** (맥에서): `TAG=$(git rev-parse --short HEAD)`, `docker buildx build --platform linux/amd64 -t studiopass:$TAG -f deploy/Dockerfile --load .`, `docker save | gzip | ssh $HOST 'gunzip | docker load'`, 서버에서 배포 전 백업(`backup.sh pre-deploy`) → 이전 TAG 를 `/srv/studiopass/PREV_TAG` 에 기록 → `TAG=$TAG docker compose up -d` → `curl healthz` 확인, 실패하면 자동으로 이전 TAG 로 되돌림. `--rollback` 은 PREV_TAG 로 compose up (데이터는 건드리지 않음), `--restore <날짜>` 는 별도 확인 프롬프트 후 백업 복원.
- [ ] **Step 6: scripts/provision.sh** (한 번만, `personal-ops` 프로파일): Lightsail 인스턴스(`studiopass-1`, `ubuntu_24_04`, `small` 아닌 1GB 번들 id 를 `get-bundles` 에서 ramSizeInGb==1 로 고름, ap-northeast-2a), 고정 IP 할당·연결, 포트 22/80/443 열기, 버킷 `studiopass-backup-<랜덤6>` + 버킷 액세스 키 생성(출력은 파일로만), 키페어 다운로드를 `~/.ssh/studiopass.pem`(600). 도메인 레코드는 `--domain` 을 받으면 Route53 호스팅 영역 A 레코드 upsert. 각 단계는 이미 있으면 건너뛴다(재실행 안전). 비용이 드는 생성 단계 전에 `read -p "계속할까요? (y/N)"`.
- [ ] **Step 7: 서버 초기화** `deploy/bootstrap-host.sh`(서버에서 1회): docker 설치, ufw 22/80/443, `PasswordAuthentication no`, unattended-upgrades, aws cli, `/srv/studiopass` 준비, crontab 설치(`30 18 * * *` UTC = 03:30 KST backup, `*/5 * * * *` healthcheck).
- [ ] **Step 8: RUNBOOK.md**: 첫 배포 순서, 원장 계정 만들기(`docker compose exec api node server/dist/server/src/cli.js create-owner ...`), 배포·롤백·복원 명령, 백업 확인법, 비용, 롤백 발동 조건("문제가 이번 배포 때문일 때만").
- [ ] **Step 9: 검증** 로컬에서 `docker buildx build ... --load` 성공, `docker run -e SP_ORIGIN=http://localhost:8080 -p 8080:8787 -v /tmp/spdata:/data studiopass:$TAG` 후 `curl localhost:8080/api/healthz` → `{"ok":true}`, `curl localhost:8080/` → index.html, `curl localhost:8080/m/x` → member.html. `bash -n` 으로 모든 셸 스크립트 문법 확인.
- [ ] **Step 10: Commit** `feat(deploy): container, backups, health alerts, deploy and provision scripts, runbook`

---

### Task 11: 끝에서 끝까지 확인 (로컬)

**Files:**
- Create: `scripts/e2e-local.sh`
- Modify: 발견된 결함이 있는 파일

- [ ] **Step 1:** 컨테이너를 로컬에서 띄우고(Task 10 Step 9), CLI 로 원장·인포 계정 생성.
- [ ] **Step 2:** 헤드리스 Chrome(`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --headless=new`)과 `curl` 로: 원장 로그인 → 회원 등록 → 결제 1건 직접 입력 → 회원 링크 발급 → 회원 페이지 스크린샷(DEPTH 1, 남은 8회) → 그 QR 문자열로 `POST /api/attendances` → 회원 페이지 남은 7회 확인 → 인포 로그인 후 bootstrap 에 금액 필드 없음 확인, 정산 403 확인.
- [ ] **Step 3:** 스크린샷: 로그인, 오늘, 출석, 회원 상세, 회원 페이지(폰 500px). 디자인이 THE DEPTH 토큰을 따르는지 눈으로 확인.
- [ ] **Step 4:** `cd server && npx vitest run`, 루트 `npm run lint && npm run build && npm run build:demo` 전부 통과.
- [ ] **Step 5: Commit** `test: local end-to-end script`

---

### Task 12: 카카오 알림톡 발송 (꺼진 상태로 넣고, 승인 후 켠다)

**Files:**
- Create: `server/src/notify/alimtalk.ts`, `server/src/notify/templates.ts`, `server/test/alimtalk.test.ts`, `docs/ALIMTALK.md`
- Modify: `server/src/app.ts` (`POST /members/:id/messages` 가 `channel` 을 받음), `server/src/domain/payments.ts` 호출부(수강권 생성 시 발송 훅), `src/pages/Members.tsx` (알림톡 켜져 있으면 "알림톡으로 보내기" 버튼)

**Interfaces:**
- Produces: `type AlimtalkConfig = { enabled: boolean; apiKey: string; apiSecret: string; pfId: string; sender: string; templates: Record<TemplateKey, string> }` — 환경변수 `SP_ALIMTALK_*` 에서 읽고 하나라도 비면 `enabled=false`
- Produces: `type TemplateKey = 'LINK' | 'REMAINING' | 'EXPIRING' | 'PRO_RENEW'`
- Produces: `sendAlimtalk(cfg, to: string, key: TemplateKey, vars: Record<string,string>, fetchImpl = fetch): Promise<{ ok: boolean; id?: string; error?: string }>` — Solapi `POST https://api.solapi.com/messages/v4/send` 에 `Authorization: HMAC-SHA256 apiKey=<k>, date=<ISO>, salt=<hex>, signature=<hex(HMAC-SHA256(secret, date+salt))>` 와 `{ message: { to, from: sender, kakaoOptions: { pfId, templateId, variables: { '#{이름}': ... }, disableSms: false } } }`. 구현 시 Solapi 문서(https://developers.solapi.com)로 필드명을 한 번 확인한다.
- Produces: `notifyMember(db, cfg, memberId, key, vars, staffId)` — 꺼져 있으면 아무것도 안 하고 `{ skipped: true }`, 켜져 있으면 발송 후 `messages` 에 `channel='ALIMTALK'`, `kind=key` 기록(실패도 기록, 응답 본문은 저장하지 않음)

템플릿 4종(카카오 검수용 원문, `docs/ALIMTALK.md` 에 그대로): 등록 완료(링크), 잔여 N회, 만료 D-3, 전문반 갱신. 변수 `#{이름}`, `#{수강권}`, `#{남은횟수}`, `#{기한}`, `#{링크}`.

- [ ] **Step 1: 실패하는 테스트** — `fetchImpl` 가짜로 서명 헤더 형식(`/^HMAC-SHA256 apiKey=\S+, date=\S+, salt=[0-9a-f]+, signature=[0-9a-f]{64}$/`)과 본문의 `kakaoOptions.templateId`, `to` 숫자만 확인. 꺼진 설정이면 fetch 가 한 번도 안 불리는지 확인. 실패 응답(HTTP 400)이면 `{ok:false}` 이고 `messages` 에 실패 기록 1건.
- [ ] **Step 2: 구현** (위 인터페이스대로, `node:crypto` 만 사용)
- [ ] **Step 3: 훅** — 수강권이 새로 생기면(`assignPayment` 성공) `LINK` 템플릿을 보낸다. 발송 실패가 결제 적재를 막지 않게 트랜잭션 밖에서 `queueMicrotask` 로 부른다.
- [ ] **Step 4: 화면** — bootstrap 에 `alimtalkEnabled: boolean`. 켜져 있으면 회원 상세 버튼이 "알림톡으로 링크 보내기", 꺼져 있으면 지금의 문자 앱 열기.
- [ ] **Step 5: docs/ALIMTALK.md** — 켜는 순서: ① 카카오톡 채널 개설(학원 이름) ② 채널 비즈니스 인증(사업자등록증) ③ Solapi 가입·발신번호 등록 ④ Solapi 에서 채널 연동(발신 프로필 pfId) ⑤ 템플릿 4종 검수 신청(보통 1~3 영업일) ⑥ 승인된 templateId 를 서버 `/etc/studiopass/alimtalk.env` 에 넣고 재시작. 비용 건당 약 8~13원, 실패 시 문자 대체 발송 요금 별도.
- [ ] **Step 6: Commit** `feat(server): kakao alimtalk sender behind a switch`

---

## 배포 (계획 밖, 사용자 확인 후)

도메인 구매 승인 → `scripts/provision.sh --domain <도메인>` → `deploy/bootstrap-host.sh` → `scripts/deploy.sh` → 원장 계정 생성 → 실제 도메인에서 Task 11 Step 2 반복. 이 단계는 돈이 들고 외부에 공개되므로 사용자에게 확인받고 진행한다.
