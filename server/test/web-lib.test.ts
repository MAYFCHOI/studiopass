// Pure web helpers (src/lib), run here because the web app has no test runner of its own.
import { describe, it, expect } from 'vitest';
import { matchMember, samePhoneMembers } from '../../src/lib/search';
import { guessMapping, detectHeaderRow, sheetAt, toIso, toPayments, decodeCsv } from '../../src/lib/excel';

const M = [
  { id: 'a', name: '회원A', phone: '01011112222', memberNo: '2026-0001' },
  { id: 'b', name: '회원B', phone: '01033334444', memberNo: '2026-0002' },
  { id: 'c', name: '김서연', phone: '01055556666', memberNo: '2026-0003' },
];
const search = (q: string) => M.filter((m) => matchMember(m, q)).map((m) => m.name);

describe('H1 matchMember', () => {
  it('a name without digits matches only that name', () => {
    expect(search('김서연')).toEqual(['김서연']);
    expect(search('ㄱ')).toEqual([]);
    expect(search('서연')).toEqual(['김서연']);
  });
  it('digits match phone tails and member numbers', () => {
    expect(search('4444')).toEqual(['회원B']);
    expect(search('010-5555')).toEqual(['김서연']);
    expect(search('2026-0001')).toEqual(['회원A']);
  });
  it('empty query matches everyone (the page decides whether to list)', () => {
    expect(search('  ')).toHaveLength(3);
  });
});

describe('M1 samePhoneMembers', () => {
  it('finds other live members with the same number', () => {
    const ms = [...M, { id: 'd', name: '김서연2', phone: '01055556666', memberNo: '2026-0004' }, { id: 'e', name: '삭제', phone: '01055556666', memberNo: 'x', erased: true }];
    expect(samePhoneMembers(ms, '010-5555-6666').map((m) => m.id)).toEqual(['c', 'd']);
    expect(samePhoneMembers(ms, '01055556666', 'c').map((m) => m.id)).toEqual(['d']);
    expect(samePhoneMembers(ms, '')).toEqual([]);
  });
});

describe('H5 guessMapping on POS-style headers', () => {
  it('OKPOS-like order: amount is 결제금액, phone is 고객휴대폰, id is 승인번호', () => {
    const h = ['No', '영업일자', '승인일시', '승인번호', '결제구분', '상품명', '할인금액', '결제금액', '취소금액', '고객휴대폰'];
    expect(guessMapping(h)).toMatchObject({ paidAt: '승인일시', amount: '결제금액', payerPhone: '고객휴대폰', externalId: '승인번호', productName: '상품명' });
  });
  it('never picks 할인금액/공급가액/부가세 for amount when a real total exists', () => {
    expect(guessMapping(['공급가액', '부가세', '할인금액', '합계']).amount).toBe('합계');
    expect(guessMapping(['판매금액', '공급가액', '부가세액']).amount).toBe('판매금액');
    expect(guessMapping(['할인금액', '승인금액']).amount).toBe('승인금액');
    expect(guessMapping(['할인금액', '공급가액']).amount).toBeUndefined();
  });
  it('phone never picks 승인번호/주문번호/카드번호; id never picks 사업자번호', () => {
    const g = guessMapping(['주문번호', '카드번호', '승인번호', '사업자번호', '연락처']);
    expect(g.payerPhone).toBe('연락처');
    expect(g.externalId).toBe('승인번호');
    expect(guessMapping(['사업자번호', '카드번호', '주문번호']).externalId).toBe('주문번호');
    expect(guessMapping(['주문번호', '카드번호']).payerPhone).toBeUndefined();
  });
  it('the app sample header still maps', () => {
    expect(guessMapping(['결제일시', '결제자명', '휴대폰번호', '상품명', '결제금액', '승인번호', '상태'])).toEqual({ paidAt: '결제일시', payerName: '결제자명', payerPhone: '휴대폰번호', productName: '상품명', amount: '결제금액', externalId: '승인번호', status: '상태' });
  });
  it('승인구분 beats 결제구분 for status', () => {
    expect(guessMapping(['결제구분', '승인구분']).status).toBe('승인구분');
  });
});

describe('M3 header row', () => {
  const aoa = [
    ['매출 상세 조회 (2026-10-01 ~ 2026-10-17)', '', ''],
    ['', '', ''],
    ['승인일시', '상품명', '결제금액', '휴대폰'],
    ['2026-10-17 14:03:21', '정규 클래스 8회권', '180,000', '010-1111-2222'],
    ['', '', '', ''],
    ['2026-10-17 오후 3:10', '정규 클래스 4회권', 100000, '01033334444'],
  ];
  it('skips title rows and keeps sheet line numbers', () => {
    const i = detectHeaderRow(aoa);
    expect(i).toBe(2);
    const t = sheetAt(aoa, i, 1);
    expect(t.headers).toEqual(['승인일시', '상품명', '결제금액', '휴대폰']);
    expect(t.rows).toHaveLength(2);
    expect(t.lines).toEqual([4, 6]);
    const { rows } = toPayments(t.rows, guessMapping(t.headers), t.lines);
    expect(rows.map((r) => [r.line, r.amount, r.payerPhone])).toEqual([[4, 180000, '01011112222'], [6, 100000, '01033334444']]);
  });
  it('empty and duplicate headers get names', () => {
    expect(sheetAt([['금액', '', '금액'], [1, 2, 3]], 0).headers).toEqual(['금액', '열2', '금액 (2)']);
  });
});

describe('L8 dates', () => {
  it('reads 오전/오후 and dotted dates', () => {
    const local = (s: string) => new Date(s).toISOString();
    expect(toIso('2026-10-17 오후 2:03:21')).toBe(local('2026-10-17T14:03:21'));
    expect(toIso('2026-10-17 오전 12:05')).toBe(local('2026-10-17T00:05:00'));
    expect(toIso('2026.10.17 14:00')).toBe(local('2026-10-17T14:00:00'));
    expect(toIso('2026. 10. 17. 14:00')).toBe(local('2026-10-17T14:00:00'));
    expect(toIso('합계')).toBeNull();
  });
});

describe('CSV encoding', () => {
  it('reads UTF-8 (with or without BOM) and EUC-KR', () => {
    expect(decodeCsv(new TextEncoder().encode('\uFEFF승인번호,결제금액'))).toBe('승인번호,결제금액');
    expect(decodeCsv(new TextEncoder().encode('승인번호'))).toBe('승인번호');
    // "승인" in EUC-KR
    expect(decodeCsv(new Uint8Array([0xbd, 0xc2, 0xc0, 0xce]))).toBe('승인');
  });
});
