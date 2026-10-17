import { useEffect, useState } from 'react';
let push: ((m: string) => void) | null = null;
export const toast = (m: string) => push?.(m);
/** 읽을 시간: 최소 2.5초, 글자당 60ms, 최대 8초. 새 토스트는 이전 타이머를 지운다(앞 타이머가 새 글을 일찍 지우지 않게). */
const toastMs = (m: string) => Math.min(8000, Math.max(2500, m.length * 60));
export function ToastHost() {
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    push = (m) => { if (t) clearTimeout(t); setMsg(m); t = setTimeout(() => setMsg(null), toastMs(m)); };
    return () => { push = null; if (t) clearTimeout(t); };
  }, []);
  return msg ? <div className="toast" role="status">{msg}</div> : null;
}
