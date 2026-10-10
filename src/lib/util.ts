import dayjs from 'dayjs';

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

export const normalizePhone = (s: string | number | undefined | null): string => {
  if (s === undefined || s === null) return '';
  let d = String(s).replace(/\D/g, '');
  if (d.startsWith('82')) d = '0' + d.slice(2);
  if (d.length === 10 && d.startsWith('10')) d = '0' + d; // excel dropped leading 0
  return d;
};

export const fmtPhone = (d: string) =>
  d.length === 11 ? `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}` : d;

export const won = (n: number) => n.toLocaleString('ko-KR') + '원';

export const today = () => dayjs().format('YYYY-MM-DD');
export const ym = (d: string | Date = new Date()) => dayjs(d).format('YYYY-MM');

export const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

// QR payload: AM1:<memberId>:<sig>. Signature is a short hash so a hand-typed id does not scan.
export const qrSig = (memberId: string) => {
  let h = 5381;
  const s = memberId + '|studiopass';
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36).slice(0, 6);
};
export const qrPayload = (memberId: string) => `AM1:${memberId}:${qrSig(memberId)}`;
export const parseQr = (text: string): string | null => {
  const m = /^AM1:([a-z0-9]+):([a-z0-9]+)$/i.exec(text.trim());
  if (!m) return null;
  return qrSig(m[1]) === m[2] ? m[1] : null;
};
