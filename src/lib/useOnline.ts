import { useEffect, useState } from 'react';
import { useStore } from '../store';

/** 서버 요청이 끊겼거나 브라우저가 오프라인이면 false */
export function useOnline() {
  const online = useStore((s) => s.online);
  const [nav, setNav] = useState(() => navigator.onLine);
  useEffect(() => {
    const on = () => setNav(true);
    const off = () => setNav(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);
  return online && nav;
}
