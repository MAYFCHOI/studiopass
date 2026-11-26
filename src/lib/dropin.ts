import dayjs from 'dayjs';
import type { State, Payment, Product, Course } from '../types';

const squash = (x?: string) => (x ?? '').replace(/\s+/g, '').toLowerCase();

/** 서버 findProduct 와 같은 규칙: 띄어쓰기·대소문자 무시, 같은 이름 → 가장 긴 포함 이름. */
export function productByName(products: Product[], name: string): Product | undefined {
  const n = squash(name); if (!n) return undefined;
  const live = products.filter((p) => p.active !== false);
  return live.find((p) => squash(p.name) === n) ?? live.filter((p) => squash(p.name) && n.includes(squash(p.name))).sort((a, b) => squash(b.name).length - squash(a.name).length)[0];
}

/** 수강권을 만들지 않는 결제(서버 passless 와 같다): 수업 없는 원데이 상품(웜업)만으로 된 결제. 회원에게 연결돼도 수강권이 없는 게 맞다. */
export const passlessPayment = (s: Pick<State, 'products'>, name: string) => {
  const parts = name.split('+').map((x) => x.trim()).filter(Boolean);
  return (parts.length > 1 ? parts : [name]).every((x) => { const p = productByName(s.products, x); return !!p && !!p.dropIn && !p.courseId; });
};

/** 원데이 결제인데 상품에 수업이 없어(웜업처럼 요일마다 강사가 다름) 사람이 수업을 골라야 정산에 들어가는 결제.
 *  묶음 결제("A + B")는 조각 중 하나라도 수업이 없으면(못 찾은 상품 포함) 고른다. 고른 수업은 그 조각에만 쓰인다(서버 정산과 같다). */
export const needsCourse = (s: Pick<State, 'products'>, p: Pick<Payment, 'dropIn' | 'memberId' | 'productName' | 'status'>) => {
  if (!p.dropIn || p.memberId || p.status !== 'APPROVED') return false;
  const parts = p.productName.split('+').map((x) => x.trim()).filter(Boolean);
  return (parts.length > 1 ? parts : [p.productName]).some((x) => !productByName(s.products, x)?.courseId);
};

/** 결제한 날(요일)의 수업. 상품 이름과 수업 이름·띠 문구가 맞는 수업(WARM UP TRAINING ↔ WarmUp Training)을 먼저 둔다. */
export function coursesFor(s: Pick<State, 'courses'>, productName: string, at: string): Course[] {
  const wd = dayjs(at).day(); const n = squash(productName);
  const hit = (c: Course) => { const a = squash(c.note), b = squash(c.name); return (!!a && (n.includes(a) || a.includes(n))) || (!!b && n.includes(b)); };
  return s.courses.filter((c) => c.active !== false && c.kind === 'GENERAL' && c.weekday.includes(wd))
    .sort((x, y) => Number(hit(y)) - Number(hit(x)) || x.startTime.localeCompare(y.startTime));
}

/** 미리 골라 둘 수업: 이름이 맞는 수업, 없으면 결제 시각 뒤 가장 가까운 수업. */
export function guessCourse(s: Pick<State, 'courses'>, productName: string, at: string): Course | undefined {
  const list = coursesFor(s, productName, at); const n = squash(productName);
  const named = list.find((c) => { const a = squash(c.note), b = squash(c.name); return (!!a && (n.includes(a) || a.includes(n))) || (!!b && n.includes(b)); });
  if (named) return named;
  const t = dayjs(at).format('HH:mm');
  return list.find((c) => c.startTime >= t) ?? list[list.length - 1];
}
