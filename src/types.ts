export type SettlementType = 'RATIO' | 'PER_SESSION';
export type CourseKind = 'GENERAL' | 'PRO';
export type PassKind = 'COUNT' | 'PERIOD';
export type PaymentStatus = 'APPROVED' | 'CANCELLED';
export type PaymentSource = 'KIOSK' | 'MANUAL';

export interface Member {
  id: string;
  memberNo: string; // e.g. 2026-0001
  name: string;
  phone: string; // digits only
  createdAt: string; // ISO
  memo?: string;
}

export interface Instructor {
  id: string;
  name: string;
  crew?: string;
  settlementType: SettlementType;
  ratioInstructor: number; // 0..100 (%), used when RATIO
  perSessionFee: number; // KRW, used when PER_SESSION
}

export interface Course {
  id: string;
  name: string; // e.g. "힙합 베이직"
  instructorId: string;
  kind: CourseKind;
  weekday: number[]; // 0=Sun..6=Sat
  startTime: string; // "19:00"
  durationMin: number;
  color?: string;
}

export interface Product {
  id: string;
  name: string; // kiosk product name (matching key)
  courseId?: string; // undefined for PRO (any course)
  passKind: PassKind;
  count: number; // sessions or tickets per period
  periodDays: number; // validity days (COUNT: e.g. 60, PERIOD: 30)
  price: number;
}

export interface Payment {
  id: string;
  source: PaymentSource;
  externalId?: string; // approval no
  paidAt: string;
  amount: number;
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
  courseId?: string; // undefined => PRO free pass
  kind: PassKind;
  totalCount: number;
  remaining: number;
  validFrom: string; // YYYY-MM-DD
  validTo: string; // YYYY-MM-DD
  paymentId?: string;
  price: number;
}

export interface Attendance {
  id: string;
  memberId: string;
  passId: string;
  courseId: string;
  instructorId: string;
  attendedAt: string; // ISO
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
}
