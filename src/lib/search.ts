import type { Member } from '../types';

/**
 * 이름·전화번호·회원번호 검색. 숫자가 없는 검색어로 전화번호를 찾으면 빈 문자열이 모든 번호에 맞으므로,
 * 숫자가 없을 때는 전화번호 비교를 건너뛴다.
 */
export function matchMember(m: Pick<Member, 'name' | 'phone' | 'memberNo'>, q: string): boolean {
  const t = q.trim();
  if (!t) return true;
  const digits = t.replace(/\D/g, '');
  return m.name.includes(t) || (digits.length > 0 && m.phone.includes(digits)) || m.memberNo.includes(t);
}

/** 같은 전화번호를 쓰는 회원(삭제된 회원 제외). 둘 이상이면 키오스크 결제가 자동으로 연결되지 않는다. */
export function samePhoneMembers<T extends Pick<Member, 'id' | 'phone' | 'erased'>>(members: T[], phone: string | undefined, exceptId?: string): T[] {
  const d = (phone ?? '').replace(/\D/g, '');
  if (d.length < 9) return [];
  return members.filter((m) => !m.erased && m.id !== exceptId && m.phone === d);
}
