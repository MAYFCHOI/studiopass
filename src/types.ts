export type SettlementType = 'RATIO' | 'PER_SESSION';
export type CourseKind = 'GENERAL' | 'PRO';
export type PassKind = 'COUNT' | 'PERIOD';
export type PaymentStatus = 'APPROVED' | 'CANCELLED';
export type PaymentSource = 'KIOSK' | 'MANUAL';
export type Hall = 'HUB' | 'LAB';

export interface Member {
  id: string;
  memberNo: string; // e.g. 2026-0001
  name: string;
  phone: string; // digits only
  createdAt: string; // ISO
  memo?: string;
  tier?: { name: string; level: number; count: number }; // 서버가 계산
}

export interface Instructor {
  id: string;
  name: string;
  crew?: string;
  settlementType: SettlementType;
  // DESK 에게는 서버가 정산 조건을 주지 않는다 (undefined)
  ratioInstructor?: number; // 0..100 (%), used when RATIO
  perSessionFee?: number; // KRW, used when PER_SESSION
  active?: boolean;
}

export interface Course {
  id: string;
  name: string; // 장르, e.g. HIPHOP
  instructorId: string;
  kind: CourseKind;
  hall: Hall;
  level?: string; // 0..4 | ALL, 시간표의 LV 표기
  note?: string; // 시간표 띠 문구, e.g. WarmUp Training
  weekday: number[]; // 0=Sun..6=Sat
  startTime: string; // "19:00"
  durationMin: number;
  color?: string;
  active?: boolean;
}

export interface Product {
  id: string;
  name: string; // kiosk product name (matching key)
  courseId?: string; // undefined => 정규 수업 아무거나(COUNT) / 전부(PERIOD)
  passKind: PassKind;
  count: number; // sessions or tickets per period
  periodDays: number; // validity days (COUNT: e.g. 60, PERIOD: 30)
  price?: number; // DESK 에게는 없음
  active?: boolean;
}

export interface Payment {
  id: string;
  source: PaymentSource;
  externalId?: string; // approval no
  paidAt: string;
  amount?: number; // DESK 에게는 없음
  payerName?: string;
  payerPhone?: string; // digits only
  productName: string;
  status: PaymentStatus;
  memberId?: string; // assigned member
  passId?: string; // pass created
  raw?: Record<string, unknown>;
}

export interface Pass {
  id: string;
  memberId: string;
  productId: string;
  courseId?: string; // undefined => 정규 아무 수업(COUNT) 또는 전문반 자유수강(PERIOD)
  kind: PassKind;
  totalCount: number;
  remaining: number;
  validFrom: string; // YYYY-MM-DD
  validTo: string; // YYYY-MM-DD
  paymentId?: string;
  price?: number; // DESK 에게는 없음
}

export interface Attendance {
  id: string;
  memberId: string;
  passId: string;
  courseId: string;
  instructorId: string;
  attendedAt: string; // ISO
  attendedOn?: string; // KST YYYY-MM-DD (서버)
  cancelledAt?: string;
}

export interface State {
  studioName: string;
  members: Member[];
  instructors: Instructor[];
  courses: Course[];
  products: Product[];
  payments: Payment[];
  passes: Pass[];
  attendances: Attendance[];
  needsRealPrices: boolean;
  alimtalkEnabled?: boolean; // 없으면 false
  tiers?: Tier[];
}

export type Role = 'OWNER' | 'DESK';
export interface Me { name: string; role: Role; staffId?: string }
export interface Tier { name: string; minCount: number }

/** 서버 출석 실패 코드 + 화면에서만 생기는 코드(NO_COURSE, OFFLINE, ERROR). 문구는 lib/reasons.ts */
export type ScanFail = 'UNKNOWN_QR' | 'UNKNOWN_MEMBER' | 'UNKNOWN_COURSE' | 'ALREADY' | 'PRO_ONLY' | 'EMPTY' | 'EXPIRED' | 'NO_PASS' | 'NO_COURSE' | 'OFFLINE' | 'ERROR';
export type ScanResult =
  | { ok: true; member: { id: string; name: string }; pass: Pass; course: Course; attendedAt: string }
  | { ok: false; reason: ScanFail; member?: { id: string; name: string } };

export interface SettlementLine {
  instructor: Instructor;
  type: SettlementType;
  sessions: number; // 수업 횟수(타임)
  heads: number; // 출석 인원 합
  revenue: number; // 출석 기반 매출(회차 환산)
  instructorPay: number;
  academyPay: number;
  proTickets: number; // 전문반 자유수강 출석(기록만)
}

export type ImportResult = { added: number; dup: number; matched: number; cancelled: number; cancelFailed: number };
/** 정산 엑셀 상세(서버가 그 달 전체를 준다. bootstrap 의 62일 창과 무관). */
export interface SettlementDetail {
  attendances: { attendedAt: string; member: string | null; course: string | null; instructor: string | null; passKind: PassKind; value: number }[];
  payments: { paidAt: string; member: string | null; payerName: string | null; productName: string; amount: number; status: Payment['status']; source: Payment['source']; externalId: string | null }[];
}

export interface NewPayment { memberId: string; productName: string; amount: number; payerName?: string; payerPhone?: string; paidAt?: string }

export interface Actions {
  load(): Promise<void>;
  login(loginId: string, password: string): Promise<{ ok: boolean; error?: 'INVALID' | 'LIMIT' }>;
  logout(): Promise<void>;
  addMember(m: { name: string; phone: string; memo?: string }): Promise<Member>;
  updateMember(id: string, patch: Partial<Member>): Promise<void>;
  /** 회원 페이지 링크 발급(재발급하면 예전 링크는 막힌다). URL 을 돌려준다. */
  issueLink(memberId: string): Promise<string>;
  recordMessage(memberId: string): Promise<void>;
  /** 서버가 새 링크를 발급해 알림톡으로 바로 보낸다(alimtalkEnabled 일 때만). */
  sendAlimtalkLink(memberId: string): Promise<{ ok: boolean; error?: string }>;
  attend(input: { qr?: string; memberId?: string; courseId: string }): Promise<ScanResult>;
  cancelAttendance(id: string): Promise<void>;
  /** 결제 적재. externalId 또는 (전화+시각+금액) 으로 중복 제거. 전화 매칭되면 회원 배정 + 수강권 생성.
   *  같은 승인번호의 취소 행은 저장된 승인 결제를 취소(cancelled), 출석에 쓰인 수강권이면 그대로 두고 cancelFailed. */
  importPayments(rows: Omit<Payment, 'id'>[]): Promise<ImportResult>;
  addPayment(p: NewPayment): Promise<void>;
  assignPayment(paymentId: string, memberId: string): Promise<void>;
  cancelPayment(paymentId: string): Promise<{ ok: true } | { ok: false; used: number }>;
  upsertInstructor(i: Instructor): Promise<void>;
  upsertCourse(c: Course): Promise<void>;
  upsertProduct(p: Product): Promise<void>;
  settlement(month: string): Promise<SettlementLine[]>;
  /** 서버 모드: 그 달 엑셀 상세. 데모는 null(화면이 브라우저 데이터로 만든다). */
  settlementDetail(month: string): Promise<SettlementDetail | null>;
  /** 데모 전용 */
  reset(): Promise<void>;
  /** 화면용 계산(동기): 지금 쓸 수 있는 수강권, 만료 임박 순 */
  activePasses(memberId: string): Pass[];
}

export type Store = State & Actions & { me: Me | null; ready: boolean; online: boolean };
