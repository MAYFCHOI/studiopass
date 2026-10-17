import * as XLSX from 'xlsx';
import dayjs from 'dayjs';
import type { Payment, ImportRow } from '../types';
import { normalizePhone } from './util';

export type Row = Record<string, unknown>;
export interface Mapping { paidAt?: string; amount?: string; payerName?: string; payerPhone?: string; productName?: string; externalId?: string; status?: string }

/** 시트 원본(행 배열). firstLine = 첫 행의 엑셀 행 번호. 헤더 행은 detectHeaderRow 로 고르고 화면에서 바꿀 수 있다. */
export async function readSheet(file: File): Promise<{ aoa: unknown[][]; firstLine: number }> {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array', cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: '', blankrows: true });
  const firstLine = ws?.['!ref'] ? XLSX.utils.decode_range(ws['!ref']).s.r + 1 : 1;
  return { aoa, firstLine };
}

const cellText = (v: unknown) => (v instanceof Date ? '' : String(v ?? '').trim());
/** 헤더 행 아래를 객체 행으로. 빈 헤더는 "열N", 같은 이름은 " (2)" 를 붙인다. 빈 행은 건너뛴다. lines = 엑셀 행 번호. */
export function sheetAt(aoa: unknown[][], headerIdx: number, firstLine = 1): { headers: string[]; rows: Row[]; lines: number[] } {
  const raw = aoa[headerIdx] ?? [];
  const width = Math.max(raw.length, ...aoa.slice(headerIdx + 1).map((r) => r.length));
  const used = new Map<string, number>();
  const headers = Array.from({ length: width }, (_, i) => {
    const base = cellText(raw[i]) || `열${i + 1}`;
    const n = (used.get(base) ?? 0) + 1; used.set(base, n);
    return n === 1 ? base : `${base} (${n})`;
  });
  const rows: Row[] = []; const lines: number[] = [];
  aoa.slice(headerIdx + 1).forEach((r, j) => {
    if (!r.some((v) => cellText(v) || v instanceof Date)) return;
    rows.push(Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ''])));
    lines.push(firstLine + headerIdx + 1 + j);
  });
  return { headers, rows, lines };
}

/** 표 위에 제목 행이 있는 파일: 아는 컬럼 이름이 2개 이상 잡히는 첫 행(앞 20행 안)을 헤더로 본다. */
export function detectHeaderRow(aoa: unknown[][]): number {
  for (let i = 0; i < Math.min(aoa.length, 20); i++) {
    const cells = (aoa[i] ?? []).map(cellText).filter(Boolean);
    if (cells.length < 2) continue;
    const g = guessMapping(cells);
    if (Object.values(g).filter(Boolean).length >= 2) return i;
  }
  const first = aoa.findIndex((r) => (r ?? []).map(cellText).filter(Boolean).length >= 2);
  return first < 0 ? 0 : first;
}

type Rule = { keys: [string, number][]; not?: RegExp; exact?: string[] };
/** 필드별 후보 이름과 점수. 더 구체적인 이름이 이기고, not 에 걸리는 헤더(할인금액·승인번호 같은 엉뚱한 칸)는 아예 고르지 않는다. */
const RULES: Record<keyof Mapping, Rule> = {
  paidAt: { keys: [['결제일시', 6], ['승인일시', 6], ['거래일시', 6], ['판매일시', 6], ['결제일', 4], ['승인일', 4], ['거래일', 4], ['판매일', 4], ['일시', 3], ['datetime', 3], ['date', 2], ['time', 1], ['영업일', 1], ['일자', 1]], not: /취소|환불|등록|수정|출력|생년/ },
  amount: { keys: [['결제금액', 6], ['승인금액', 6], ['판매금액', 6], ['실결제', 6], ['받을금액', 5], ['합계금액', 5], ['총금액', 5], ['매출액', 4], ['결제액', 4], ['합계', 3], ['금액', 2], ['amount', 2], ['total', 1]], not: /할인|공급|부가|세액|면세|과세|봉사|포인트|미수|취소|단가|수량|잔액|거스름/ },
  payerName: { keys: [['결제자', 5], ['고객명', 5], ['회원명', 5], ['구매자', 5], ['성명', 4], ['이름', 3], ['name', 1]], not: /상품|메뉴|가맹|카드|매장|직원|담당|점포|품목/ },
  payerPhone: { keys: [['휴대폰', 6], ['핸드폰', 6], ['휴대전화', 6], ['연락처', 5], ['전화', 4], ['phone', 4], ['mobile', 4], ['hp', 2], ['번호', 1]], not: /승인|주문|카드|사업자|거래|영수증|가맹|단말|회원번호|상품|매장|대표|^no\.?$/ },
  productName: { keys: [['상품명', 6], ['메뉴명', 6], ['품목명', 6], ['수강권', 5], ['상품', 4], ['메뉴', 4], ['품목', 4], ['product', 3], ['item', 2]], not: /코드|code|분류|구분|수량|단가|금액|할인/ },
  externalId: { keys: [['승인번호', 6], ['거래번호', 5], ['영수증번호', 5], ['주문번호', 4], ['거래id', 4], ['approval', 4], ['tid', 3]], not: /사업자|카드번호|가맹|단말|회원|원승인|휴대|전화/, exact: ['id', 'no'] },
  status: { keys: [['승인구분', 6], ['거래구분', 6], ['취소여부', 6], ['거래상태', 6], ['상태', 4], ['status', 4], ['승인/취소', 6], ['구분', 2], ['type', 1]], not: /결제수단|카드사|상품/ },
};
/** 헤더 이름으로 컬럼 추정. 업체 포맷이 바뀌어도 사용자가 UI 에서 고칠 수 있다. */
export function guessMapping(headers: string[]): Mapping {
  const norm = (h: string) => h.replace(/\s/g, '').toLowerCase();
  const score = (h: string, r: Rule) => {
    const n = norm(h);
    if (!n || r.not?.test(n)) return 0;
    if (r.exact?.includes(n)) return 3;
    let best = 0;
    for (const [k, v] of r.keys) if (n.includes(k)) best = Math.max(best, v + (n === k ? 2 : 0));
    return best;
  };
  const out: Mapping = {};
  for (const f of Object.keys(RULES) as (keyof Mapping)[]) {
    let best: string | undefined; let bs = 0;
    for (const h of headers) { const v = score(h, RULES[f]); if (v > bs) { bs = v; best = h; } }
    if (best) out[f] = best;
  }
  return out;
}

/** 읽을 수 없는 날짜는 null. 지금 시각으로 채우면 엉뚱한 달 정산에 들어가므로 그 행은 건너뛴다. */
export const toIso = (v: unknown): string | null => {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (typeof v === 'number') { const d = XLSX.SSF.parse_date_code(v); if (d) return new Date(d.y, d.m - 1, d.d, d.H, d.M, d.S).toISOString(); return null; }
  let s = String(v ?? '').trim();
  if (!s) return null;
  // "2026-10-17 오후 2:03:21" 같은 한국어 시각 → 24시간
  s = s.replace(/(오전|오후)\s*(\d{1,2}):(\d{2})(?::(\d{2}))?/, (_m, ap: string, h: string, mi: string, se?: string) => {
    let hh = Number(h) % 12; if (ap === '오후') hh += 12;
    return `${String(hh).padStart(2, '0')}:${mi}:${se ?? '00'}`;
  });
  const d = dayjs(s.replace(/\.\s*/g, '-').replace(/-(\d{1,2}:)/, ' $1').replace(/-$/, ''));
  return d.isValid() ? d.toISOString() : null;
};
const toNum = (v: unknown) => Number(String(v ?? '').replace(/[^\d.-]/g, '')) || 0;

/** rows 는 보낼 결제, badDate 는 결제 일시를 읽지 못해 뺀 행 수(사용자에게 알린다). */
export function toPayments(rows: Row[], m: Mapping, lines?: number[]): { rows: ImportRow[]; badDate: number } {
  let badDate = 0;
  const out = rows.map((r, i) => {
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
      line: lines?.[i],
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
