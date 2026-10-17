import { useCallback, useRef, useState } from 'react';

/** 버튼 두 번 누름 방지: run 이 끝나기 전의 다음 run 은 무시한다. busy 는 버튼 disabled 와 문구에 쓴다. */
export function useBusy(): [boolean, (f: () => Promise<unknown>) => Promise<void>] {
  const [busy, setBusy] = useState(false);
  const ref = useRef(false);
  const run = useCallback(async (f: () => Promise<unknown>) => {
    if (ref.current) return;
    ref.current = true; setBusy(true);
    try { await f(); } catch { /* 화면이 이미 알렸다 */ } finally { ref.current = false; setBusy(false); }
  }, []);
  return [busy, run];
}

/** 폼 하나에 하나씩 쓰는 요청 키(같은 폼을 다시 보내면 서버가 처음 결과를 돌려준다). */
export const newRequestKey = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
