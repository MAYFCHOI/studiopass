import { useEffect, useState } from 'react';
import dayjs from 'dayjs';
import 'dayjs/locale/ko';
import Today from './pages/Today';
import Scan from './pages/Scan';
import Members from './pages/Members';
import Payments from './pages/Payments';
import Settlement from './pages/Settlement';
import Settings from './pages/Settings';
import Login from './pages/Login';
import { OfflineBar } from './components/OfflineBar';
import { useStore } from './store';
import { IS_DEMO } from './lib/mode';
import { Icon } from './components/Icon';
import { ToastHost } from './components/Toast';
import { ErrorBoundary } from './components/ErrorBoundary';
import logoMark from './assets/logo-mark.png';

dayjs.locale('ko');

export type Tab = 'today' | 'scan' | 'members' | 'payments' | 'settle' | 'settings';
const TABS: { id: Tab; label: string; icon: Parameters<typeof Icon>[0]['name'] }[] = [
  { id: 'today', label: '오늘', icon: 'today' },
  { id: 'scan', label: '출석', icon: 'scan' },
  { id: 'members', label: '회원', icon: 'members' },
  { id: 'payments', label: '결제', icon: 'pay' },
  { id: 'settle', label: '정산', icon: 'settle' },
];

const readHash = (): { tab: Tab; arg?: string } => {
  const [t, arg] = location.hash.replace(/^#\/?/, '').split('/');
  const tab = (['today', 'scan', 'members', 'payments', 'settle', 'settings'] as Tab[]).includes(t as Tab) ? (t as Tab) : 'today';
  return { tab, arg };
};

// DESK(인포) 는 정산·설정을 보지 않는다. 금액은 서버가 아예 주지 않는다.
const OWNER_ONLY: Tab[] = ['settle', 'settings'];

export default function App() {
  const [hashRoute, setRoute] = useState(readHash);
  const me = useStore((s) => s.me);
  const ready = useStore((s) => s.ready);
  const logout = useStore((s) => s.logout);
  useEffect(() => {
    const h = () => setRoute(readHash());
    window.addEventListener('hashchange', h);
    return () => window.removeEventListener('hashchange', h);
  }, []);
  useEffect(() => { void useStore.getState().load(); }, []);
  const go = (tab: Tab, arg?: string) => { location.hash = '/' + tab + (arg ? '/' + arg : ''); };

  if (!ready) return <div className="app" />;
  if (!me) return <>{!IS_DEMO && <OfflineBar />}<Login /></>;
  const owner = me.role === 'OWNER';
  const tabs = owner ? TABS : TABS.filter((t) => !OWNER_ONLY.includes(t.id));
  const route: { tab: Tab; arg?: string } = !owner && OWNER_ONLY.includes(hashRoute.tab) ? { tab: 'today' } : hashRoute;

  return (
    <div className="app">
      {!IS_DEMO && <OfflineBar />}
      <header className={IS_DEMO ? 'topbar' : 'topbar has-account'}>
        <button className="brand" onClick={() => go('today')} aria-label="THE DEPTH DANCE STUDIO 홈"><img src={logoMark} alt="" /><span>THE DEPTH<small>DANCE STUDIO</small></span></button>
        <div className="date">{route.tab !== 'today' && dayjs().format('M월 D일 dddd')}</div>
        {!IS_DEMO && <div className="account"><span>{me.name}</span><button onClick={() => { void logout(); }}>로그아웃</button></div>}
        {owner && <button className="gear" aria-label="설정" onClick={() => go('settings')} aria-current={route.tab === 'settings' ? 'page' : undefined}><Icon name="settings" /></button>}
        <nav className="rail" aria-label="주 메뉴">
          {tabs.map((t) => (
            <button key={t.id} onClick={() => go(t.id)} aria-current={route.tab === t.id ? 'page' : undefined}><Icon name={t.icon} />{t.label}</button>
          ))}
          {owner && <button onClick={() => go('settings')} aria-current={route.tab === 'settings' ? 'page' : undefined}><Icon name="settings" />설정</button>}
        </nav>
      </header>
      <main className="screen" key={route.tab}>
        <div className="page">
        <ErrorBoundary resetKey={route.tab + (route.arg ?? '')}>
        {route.tab === 'today' && <Today go={go} />}
        {route.tab === 'scan' && <Scan go={go} />}
        {route.tab === 'members' && <Members go={go} memberId={route.arg} />}
        {route.tab === 'payments' && <Payments go={go} />}
        {route.tab === 'settle' && <Settlement />}
        {route.tab === 'settings' && <Settings />}
        </ErrorBoundary>
        </div>
      </main>
      <nav className="tabbar" aria-label="하단 메뉴" style={{ gridTemplateColumns: `repeat(${tabs.length}, 1fr)` }}>
        {tabs.map((t) => (
          <button key={t.id} onClick={() => go(t.id)} aria-current={route.tab === t.id ? 'page' : undefined}>
            <Icon name={t.icon} />{t.label}
          </button>
        ))}
      </nav>
      <ToastHost />
    </div>
  );
}
