import { useEffect } from 'react';
import { useStore } from '../store';
import { useOnline } from '../lib/useOnline';
import { REASONS } from '../lib/reasons';

/** 화면 위 검정 띠. 끊긴 동안 10초마다, 그리고 다시 연결되는 순간 서버에 다시 붙어 본다. */
export function OfflineBar() {
  const ok = useOnline();
  useEffect(() => {
    const retry = () => { void useStore.getState().load(); };
    window.addEventListener('online', retry);
    const t = ok ? undefined : setInterval(retry, 10000);
    return () => { window.removeEventListener('online', retry); if (t) clearInterval(t); };
  }, [ok]);
  return ok ? null : <div className="offline-bar" role="status">{REASONS.OFFLINE}</div>;
}
