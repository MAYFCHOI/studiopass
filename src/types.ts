export type SettlementType = 'RATIO' | 'PER_SESSION';
export type CourseKind = 'GENERAL' | 'PRO';
export type PassKind = 'COUNT' | 'PERIOD';
export type PaymentStatus = 'APPROVED' | 'CANCELLED';
export type PaymentSource = 'KIOSK' | 'MANUAL';
/** 직접 입력한 결제의 수단. 키오스크 결제는 없음. */
export type PayMethod = 'CASH' | 'TRANSFER' | 'OTHER';
export type Hall = 'HUB' | 'LAB';

export interface Member {
  id: string;
  memberNo: string; // e.g. 2026-0001
  name: string;
  phone: string; // digits only
  createdAt: string; // ISO
  memo?: string;
  tier?: { name: string; level: number; count: number; manual?: boolean }; // 서버가 계산. manual = 원장이 올린 등급
  tierFloor?: number; // 원장이 정한 최소 등급(1부터)
  since?: string; // 처음 다니기 시작한 날(YYYY-MM-DD). 없으면 등록일. 등급 기간 조건에 쓴다
  erased?: boolean; // 개인정보 파기됨(이름 '삭제된 회원', 전화·메모 없음). 출석·결제 기록만 남는다
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
  deleted?: boolean; // 지운 수업(목록·시간표에서 빠짐, 지난 기록용)
  // 수업별 정산 조건. 없으면 강사 기본(한 강사가 비율제·타임제 수업을 같이 할 때). DESK 에게는 없음
  settlementType?: SettlementType;
  ratioInstructor?: number;
  perSessionFee?: number;
}

export interface Product {
  id: string;
  name: string; // kiosk product name (matching key)
  courseId?: string; // undefined => 정규 수업 아무거나(COUNT) / 전부(PERIOD)
  passKind: PassKind;
  count: number; // sessions or tickets per period
  periodDays: number; // validity days (COUNT: e.g. 60, PERIOD: 30)
  dropIn?: boolean; // 원데이: 회원 없이 결제만. 확인 필요에 회원 연결을 요구하지 않고 이름만 적는다
  price?: number; // DESK 에게는 없음
  active?: boolean;
  attendBonus?: number; // 출석 1회당 강사 추가 페이(전문반 프리 티켓 등). DESK 에게는 없음
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
  dropIn?: boolean; // 적재 당시 원데이 상품이었던 결제
  method?: PayMethod;
  courseId?: string; // 원데이 결제의 수업(상품에 수업이 없을 때 사람이 고름). 정산은 이 수업 강사 몫
  discountPct?: number; // 강사 할인 등으로 깎아 받은 비율(%)
  passId?: string; // pass created
  /** 확인 필요 표시. REFUND_IN_USE: 환불됐지만 출석 기록이 있어 승인으로 남음, REFUND_UNMATCHED: 원 결제를 못 찾은 환불 행,
   *  REFUND_SUGGESTED: 원 결제 후보가 하나(refundSuggestedOf). 승인번호가 다른 환불은 사람이 확정할 때만 원 결제를 취소한다 */
  review?: 'REFUND_IN_USE' | 'REFUND_UNMATCHED' | 'REFUND_SUGGESTED';
  refundOf?: string; // 환불 행이 가리키는 원 결제(확정됨)
  refundSuggestedOf?: string; // 환불 행의 원 결제 후보(확정 전)
  importBatchId?: string; // 엑셀 업로드 묶음(되돌리기용)
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
  extendedDays?: number; // 유효기간 연장(수강권당 1번). validTo 는 이미 늘어난 날
  extendedAt?: string;
  adjustedUsed?: number; // 앱 쓰기 전에 쓴 횟수(남은 횟수 맞추기). 출석 기록은 없다
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
  backfilled?: boolean; // 지난 출석 넣기로 만든 출석
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
  instructorDiscountPct?: number; // 강사 특전 할인율(%), 기본 50
}

export type Role = 'OWNER' | 'DESK';
export interface Me { name: string; role: Role; staffId?: string }
/** minYears: 다닌 기간 조건(년). 출석 횟수와 같이 채워야 그 등급 */
export interface Tier { name: string; minCount: number; minYears?: number }

/** 서버 출석 실패 코드 + 화면에서만 생기는 코드(NO_COURSE, OFFLINE, ERROR). 문구는 lib/reasons.ts */
export type ScanFail = 'UNKNOWN_QR' | 'UNKNOWN_MEMBER' | 'UNKNOWN_COURSE' | 'INACTIVE_COURSE' | 'ALREADY' | 'PRO_ONLY' | 'EMPTY' | 'EXPIRED' | 'NO_PASS' | 'NO_COURSE' | 'OFFLINE' | 'ERROR';
export type ScanResult =
  | { ok: true; member: { id: string; name: string }; pass: Pass; course: Course; attendedAt: string }
  | { ok: false; reason: ScanFail; member?: { id: string; name: string }; remaining?: number; total?: number; validTo?: string };

export interface SettlementLine {
  instructor: Instructor;
  type: SettlementType;
  sessions: number; // 수업 횟수(타임)
  heads: number; // 출석 인원 합
  revenue: number; // 출석 기반 매출(회차 환산)
  instructorPay: number;
  bonus?: number; // 그중 상품의 출석당 추가 페이 합
  academyPay: number;
  proTickets: number; // 전문반 자유수강 출석(기록만)
  courses: SettlementCourse[]; // 수업별 계산. 합이 위 숫자
}

/** 강사 한 명의 수업 하나. custom: 수업에 따로 정한 조건(아니면 강사 기본) */
export interface SettlementCourse {
  courseId: string; name: string; weekday: number; startTime: string;
  type: SettlementType; ratioInstructor: number; perSessionFee: number; custom: boolean; sub?: boolean; extra?: boolean;
  sessions: number; heads: number; revenue: number; instructorPay: number; bonus?: number; proTickets: number; dropIns: number;
  days: { date: string; heads: number; revenue: number; sub?: boolean; fee?: number; people: { name: string; value: number; kind: PassKind | 'DROP_IN'; bonus?: number; paidOn?: string }[] }[];
}

export type ImportResult = {
  added: number; dup: number; matched: number; cancelled: number; cancelFailed: number;
  refundUnmatched: number; refundSuggested: number;
  /** 서버가 받지 않은 행. line = 엑셀 행 번호(알 때) */
  rejected: { line?: number; reason: string }[]; rejectedCount: number;
  batchId?: string;
  /** 중복으로 센 행이 예전에 어느 업로드로 들어왔는지(잘못 올린 업로드 되돌리기용) */
  dupBatches: { batchId: string; count: number }[];
};
/** 엑셀에서 읽은 결제 한 행. line 은 엑셀 행 번호(서버에는 보내지 않는다). */
export type ImportRow = Omit<Payment, 'id'> & { line?: number };
export type AssignResult = { ok: true; passId?: string; moved?: boolean } | { ok: false; error: 'PASS_IN_USE' | 'PAYMENT_CANCELLED' | 'ERASED'; used?: number };
export interface MemberHistory { attendances: Attendance[]; payments: Payment[]; passes: Pass[] }
/** 정산 엑셀 상세(서버가 그 달 전체를 준다. bootstrap 의 62일 창과 무관). */
export interface SettlementDetail {
  attendances: { attendedAt: string; member: string | null; course: string | null; instructor: string | null; passKind: PassKind; value: number }[];
  payments: { paidAt: string; member: string | null; payerName: string | null; productName: string; amount: number; status: Payment['status']; source: Payment['source']; externalId: string | null }[];
}

/** 대강: 그 날 그 수업을 다른 강사가 맡음. 그 날 출석·원데이 매출과 1타임이 대강 강사 몫이 된다 */
export interface Substitution { id: string; courseId: string; date: string; instructorId: string; fee?: number }
/** 추가 페이: 시간표 수업이 아닌 일(웜업 등). 정산에서 그 강사에게 금액을 더한다 */
export interface ExtraPay { id: string; date: string; instructorId: string; fee: number; memo: string }
export interface PaymentPatch { productName?: string; amount?: number; method?: PayMethod | null; paidAt?: string; courseId?: string | null; payerName?: string }

/** 직접 입력. memberId 가 없으면 원데이 손님(이름만). */
export interface NewPayment { memberId?: string; productName: string; amount: number; payerName?: string; payerPhone?: string; paidAt?: string; method?: PayMethod; courseId?: string; discountPct?: number }

export interface Actions {
  load(): Promise<void>;
  login(loginId: string, password: string): Promise<{ ok: boolean; error?: 'INVALID' | 'LIMIT' | 'BUSY' | 'OFFLINE' }>;
  logout(): Promise<void>;
  /** idempotencyKey: 폼마다 하나. 같은 키로 다시 보내면 서버가 처음 만든 회원을 돌려준다(두 번 누름 방지). */
  addMember(m: { name: string; phone: string; memo?: string }, opts?: { idempotencyKey?: string }): Promise<Member>;
  updateMember(id: string, patch: Partial<Member>): Promise<void>;
  /** 원장 전용: 회원 개인정보 파기(이름·전화·메모·링크·결제자 정보). 출석·수강권·결제 금액은 남는다. 되돌릴 수 없다 */
  eraseMember(id: string): Promise<void>;
  /** 원장 전용: 회원과 연결되지 않은 결제의 결제자 이름·전화 파기 */
  erasePayer(paymentId: string): Promise<void>;
  /** 원데이 손님 이름만 적기(회원 등록 없이) */
  setPayerName(paymentId: string, name: string): Promise<void>;
  /** 원데이 결제의 수업 고르기(null 이면 지움) */
  setPaymentCourse(paymentId: string, courseId: string | null): Promise<void>;
  /** 회원 페이지 링크 발급(재발급하면 예전 링크는 막힌다). URL 을 돌려준다. */
  issueLink(memberId: string): Promise<string>;
  recordMessage(memberId: string): Promise<void>;
  /** 서버가 새 링크를 발급해 알림톡으로 바로 보낸다(alimtalkEnabled 일 때만). */
  sendAlimtalkLink(memberId: string): Promise<{ ok: boolean; error?: string }>;
  attend(input: { qr?: string; memberId?: string; courseId: string }): Promise<ScanResult>;
  cancelAttendance(id: string): Promise<void>;
  /** 결제 적재. externalId 또는 (전화+시각+금액) 으로 중복 제거. 전화 매칭되면 회원 배정 + 수강권 생성.
   *  같은 승인번호의 취소 행은 저장된 승인 결제를 취소(cancelled), 출석에 쓰인 수강권이면 그대로 두고 cancelFailed. */
  importPayments(rows: ImportRow[], opts?: { batchId?: string }): Promise<ImportResult>;
  /** 원장 전용: 잘못 올린 업로드 묶음 되돌리기(출석에 쓰인 수강권의 결제는 남긴다) */
  revertImport(batchId: string): Promise<{ ok: true; removed: number; kept: number } | { ok: false; error: 'REFUND_LINKED' | 'HAS_CANCELLED'; count: number }>;
  addPayment(p: NewPayment, opts?: { idempotencyKey?: string }): Promise<void>;
  /** 결제를 회원에게 연결. 이미 다른 회원에게 연결된 결제는 수강권을 옮긴다(출석에 쓰였으면 PASS_IN_USE). */
  assignPayment(paymentId: string, memberId: string): Promise<AssignResult>;
  /** 원 결제를 찾지 못한 환불 행에 원 결제를 고른다(원 결제가 취소된다) */
  linkRefund(refundId: string, originalId: string): Promise<{ ok: true } | { ok: false; error: string; used: number }>;
  /** 확인 필요 표시를 지운다(사람이 확인함) */
  clearReview(paymentId: string): Promise<void>;
  /** 유효기간 연장(수강권당 1번, 1~90일). 이미 연장했으면 ALREADY_EXTENDED */
  extendPass(passId: string, days: number): Promise<{ ok: true } | { ok: false; error: string }>;
  /** 원장만: 연장 되돌리기(끝나는 날 원래대로, 다시 1번 가능) */
  undoExtendPass(passId: string): Promise<void>;
  /** 시작일 바꾸기(입금일과 실제 시작일이 다를 때). 끝나는 날도 같이 옮긴다. 출석한 날보다 뒤면 ATTENDED_BEFORE */
  setPassStart(passId: string, from: string): Promise<{ ok: true } | { ok: false; error: string }>;
  /** 횟수권 남은 횟수 맞추기(앱 쓰기 전에 쓴 횟수). 0 ~ remaining + adjustedUsed. 출석 기록은 만들지 않는다 */
  adjustPass(passId: string, remaining: number): Promise<{ ok: true } | { ok: false; error: string }>;
  /** 지난 출석 넣기(최근 62일, 그 요일 수업). 빼 둔 횟수가 있으면 그걸, 없으면 남은 횟수를 쓴다. 실패는 error 코드 */
  backfillAttendance(input: { memberId: string; passId: string; courseId: string; date: string }): Promise<{ ok: true } | { ok: false; error: string }>;
  /** 원장만: 등급 직접 올리기(1부터, null = 출석 기준) */
  setMemberTier(memberId: string, level: number | null): Promise<void>;
  /** 원장만: 등급 기준 전체 바꾸기(첫 등급은 0회) */
  saveTiers(tiers: Tier[]): Promise<void>;
  /** 회원 상세용 전체 기록(서버: bootstrap 의 62일 창 밖까지) */
  memberHistory(memberId: string): Promise<MemberHistory>;
  cancelPayment(paymentId: string): Promise<{ ok: true } | { ok: false; used: number }>;
  /** 원장만: 직접 넣은 결제(현금·이체) 고치기. 상품·받은 날이 바뀌면 수강권을 다시 만든다(출석했으면 PASS_IN_USE) */
  editPayment(paymentId: string, patch: PaymentPatch): Promise<{ ok: true } | { ok: false; error: string; used: number }>;
  /** 원장만: 그 달(KST) 승인 결제 합계 */
  paymentsTotal(month: string): Promise<number>;
  /** 원장만: 그 달 대강 목록 */
  substitutions(month: string): Promise<Substitution[]>;
  addSubstitution(s: Omit<Substitution, 'id'>): Promise<{ ok: true } | { ok: false; error: string }>;
  removeSubstitution(id: string): Promise<void>;
  /** 원장만: 그 달 추가 페이(웜업 등) */
  extraPays(month: string): Promise<ExtraPay[]>;
  addExtraPay(x: Omit<ExtraPay, 'id'>): Promise<void>;
  removeExtraPay(id: string): Promise<void>;
  /** 원장만: 수업 지우기(목록·시간표에서 사라진다. 지난 출석·정산 기록은 남는다). 이 수업에 묶인 상품이 있으면 PRODUCTS */
  deleteCourse(id: string): Promise<{ ok: true } | { ok: false; error: string; used: number }>;
  /** 원장만: 강사 할인율(%) 저장 */
  saveInstructorDiscount(pct: number): Promise<void>;
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
