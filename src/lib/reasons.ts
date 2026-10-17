import type { ScanFail } from '../types';

/** 출석 실패 코드 → 화면 문구 */
export const REASONS: Record<ScanFail, string> = {
  UNKNOWN_QR: '이 스튜디오의 QR 이 아니에요',
  UNKNOWN_MEMBER: '등록되지 않은 회원이에요',
  ALREADY: '오늘 이 수업은 이미 출석했어요',
  PRO_ONLY: '전문반 수업이에요. 전문반 수강권이 필요해요',
  EMPTY: '남은 횟수가 없어요. 결제가 필요해요',
  EXPIRED: '수강권 기간이 지났어요',
  NO_PASS: '이 수업에 쓸 수강권이 없어요',
  UNKNOWN_COURSE: '수업을 선택해 주세요',
  NO_COURSE: '먼저 수업을 선택해 주세요',
  OFFLINE: '인터넷 연결이 끊겼어요. 다시 연결되면 이름으로 출석을 넣어주세요',
  ERROR: '출석을 넣지 못했어요. 다시 시도해 주세요',
};
export const reasonText = (r: string) => REASONS[r as ScanFail] ?? r;
