import { describe, it, expect } from 'vitest';
import { kstDate, maskName, normalizePhone, newId } from '../src/util.js';
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
