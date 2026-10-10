import { useEffect, useState } from 'react';
let push: ((m: string) => void) | null = null;
export const toast = (m: string) => push?.(m);
export function ToastHost() {
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    push = (m) => { setMsg(m); setTimeout(() => setMsg(null), 1800); };
    return () => { push = null; };
  }, []);
  return msg ? <div className="toast" role="status">{msg}</div> : null;
}
