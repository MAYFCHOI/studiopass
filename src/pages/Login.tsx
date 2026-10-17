import { useState } from 'react';
import { useStore } from '../store';
import logoMark from '../assets/logo-mark.png';

const ERR = { INVALID: '아이디나 비밀번호가 맞지 않아요', LIMIT: '여러 번 틀려서 10분 동안 막혔어요', BUSY: '로그인이 몰려 있어요. 잠시 후 다시 시도해 주세요', OFFLINE: '서버에 연결하지 못했어요. 잠시 후 다시 시도해 주세요' } as const;

export default function Login() {
  const login = useStore((s) => s.login);
  const [id, setId] = useState('');
  const [pw, setPw] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true); setErr(null);
    const r = await login(id.trim(), pw);
    setBusy(false);
    if (!r.ok) {
      setErr(ERR[r.error ?? 'OFFLINE']);
      if (r.error === 'INVALID') setPw(''); // 연결 문제면 비밀번호는 그대로 두고 다시 누르게
    }
  };
  return (
    <div className="login">
      <div className="brand"><img src={logoMark} alt="" /><span>THE DEPTH<small>DANCE STUDIO</small></span></div>
      <header className="hero">
        <p className="hero-date">studiopass</p>
        <h1 className="hero-day">로그인</h1>
      </header>
      <form onSubmit={(e) => { e.preventDefault(); if (id.trim() && pw && !busy) void submit(); }}>
        <div className="field"><label htmlFor="login-id">아이디</label><input id="login-id" className="input" autoComplete="username" autoCapitalize="none" autoFocus value={id} onChange={(e) => setId(e.target.value)} /></div>
        <div className="field"><label htmlFor="login-pw">비밀번호</label><input id="login-pw" className="input" type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} /></div>
        {err && <p className="login-err" role="alert">{err}</p>}
        <button className="btn primary wide" type="submit" disabled={!id.trim() || !pw || busy}>로그인</button>
      </form>
    </div>
  );
}
