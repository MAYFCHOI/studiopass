import * as XLSX from 'xlsx';
import dayjs from 'dayjs';
import type { Payment } from '../types';
import { normalizePhone } from './util';

export type Row = Record<string, unknown>;
export interface Mapping { paidAt?: string; amount?: string; payerName?: string; payerPhone?: string; productName?: string; externalId?: string; status?: string }

export async function readSheet(file: File): Promise<{ headers: string[]; rows: Row[] }> {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array', cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<Row>(ws, { defval: '' });
  const headers = rows.length ? Object.keys(rows[0]) : [];
  return { headers, rows };
}

/** 헤더 이름으로 컬럼 추정. 업체 포맷이 바뀌어도 사용자가 UI 에서 고칠 수 있다. */
export function guessMapping(headers: string[]): Mapping {
  const pick = (...keys: string[]) => headers.find((h) => keys.some((k) => h.replace(/\s/g, '').toLowerCase().includes(k)));
  return {
    paidAt: pick('결제일', '승인일', '거래일', '일시', 'date', 'time'),
    amount: pick('금액', 'amount', '결제액', '승인금액'),
    payerName: pick('결제자', '고객명', '이름', '성명', 'name'),
    payerPhone: pick('휴대폰', '전화', '연락처', 'phone', 'hp', '번호'),
    productName: pick('상품', '메뉴', '품목', '수강권', 'product', 'item'),
    externalId: pick('승인번호', '거래번호', '주문번호', 'approval', 'tid', 'id'),
    status: pick('상태', '구분', '취소', 'status', 'type'),
  };
}

/** 읽을 수 없는 날짜는 null. 지금 시각으로 채우면 엉뚱한 달 정산에 들어가므로 그 행은 건너뛴다. */
const toIso = (v: unknown): string | null => {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (typeof v === 'number') { const d = XLSX.SSF.parse_date_code(v); if (d) return new Date(d.y, d.m - 1, d.d, d.H, d.M, d.S).toISOString(); return null; }
  const s = String(v ?? '').trim();
  if (!s) return null;
  const d = dayjs(s.replace(/\./g, '-').replace(/-$/, ''));
  return d.isValid() ? d.toISOString() : null;
};
const toNum = (v: unknown) => Number(String(v ?? '').replace(/[^\d.-]/g, '')) || 0;

/** rows 는 보낼 결제, badDate 는 결제 일시를 읽지 못해 뺀 행 수(사용자에게 알린다). */
export function toPayments(rows: Row[], m: Mapping): { rows: Omit<Payment, 'id'>[]; badDate: number } {
  let badDate = 0;
  const out = rows.map((r) => {
    const st = String(m.status ? r[m.status] : '').trim();
    const amount = toNum(m.amount ? r[m.amount] : 0);
    const cancelled = /취소|cancel|환불|refund/i.test(st) || amount < 0;
    const paidAt = toIso(m.paidAt ? r[m.paidAt] : undefined);
    return {
      source: 'KIOSK' as const,
      externalId: m.externalId ? String(r[m.externalId] ?? '').trim() || undefined : undefined,
      paidAt: paidAt ?? '',
      amount: Math.abs(amount),
      payerName: m.payerName ? String(r[m.payerName] ?? '').trim().slice(0, 50) : undefined, // 서버 한도
      payerPhone: m.payerPhone ? normalizePhone(r[m.payerPhone] as string) : '',
      productName: m.productName ? String(r[m.productName] ?? '').trim().slice(0, 100) : '',
      status: (cancelled ? 'CANCELLED' : 'APPROVED') as Payment['status'],
      raw: r,
    };
  }).filter((p) => p.amount > 0 || p.productName).filter((p) => (p.paidAt ? true : (badDate++, false)));
  return { rows: out, badDate };
}

export function downloadXlsx(name: string, sheets: { name: string; rows: Record<string, unknown>[] }[]) {
  const wb = XLSX.utils.book_new();
  for (const s of sheets) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(s.rows), s.name.slice(0, 31));
  XLSX.writeFile(wb, name);
}

export function sampleCsv(): string {
  const d = dayjs();
  return ['결제일시,결제자명,휴대폰번호,상품명,결제금액,승인번호,상태',
    `${d.subtract(2, 'hour').format('YYYY-MM-DD HH:mm:ss')},김서연,010-2000-3100,힙합 기초 8회,160000,30123456,승인`,
    `${d.subtract(1, 'day').format('YYYY-MM-DD HH:mm:ss')},이도윤,010-2137-3311,하우스 기초 8회,160000,30123457,승인`,
    `${d.subtract(1, 'day').format('YYYY-MM-DD HH:mm:ss')},박새로이,010-9999-0001,하우스 오픈 4회,100000,30123458,승인`,
    `${d.subtract(3, 'day').format('YYYY-MM-DD HH:mm:ss')},정민준,010-2548-3944,힙합 전문반 월정액,350000,30123459,승인`,
    `${d.subtract(3, 'day').format('YYYY-MM-DD HH:mm:ss')},정민준,010-2548-3944,힙합 전문반 월정액,-350000,30123459,취소`,
  ].join('\n');
}
