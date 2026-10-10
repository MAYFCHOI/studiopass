import { useEffect, useState } from 'react';
import dayjs from 'dayjs';
import 'dayjs/locale/ko';
import Today from './pages/Today';
import Scan from './pages/Scan';
import Members from './pages/Members';
import Payments from './pages/Payments';
import Settlement from './pages/Settlement';
import Settings from './pages/Settings';
import { Icon } from './components/Icon';
import { ToastHost } from './components/Toast';

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

export default function App() {
  const [route, setRoute] = useState(readHash);
  useEffect(() => {
    const h = () => setRoute(readHash());
    window.addEventListener('hashchange', h);
    return () => window.removeEventListener('hashchange', h);
  }, []);
  const go = (tab: Tab, arg?: string) => { location.hash = '/' + tab + (arg ? '/' + arg : ''); };

  return (
    <div className="app">
      <header className="topbar">
        <button className="brand" onClick={() => go('today')}>studio<i>pass</i></button>
        <div className="date">{dayjs().format('M월 D일 dddd')}</div>
        <nav className="rail" aria-label="주 메뉴">
          {TABS.map((t) => (
            <button key={t.id} onClick={() => go(t.id)} aria-current={route.tab === t.id ? 'page' : undefined}><Icon name={t.icon} />{t.label}</button>
          ))}
          <button onClick={() => go('settings')} aria-current={route.tab === 'settings' ? 'page' : undefined}><Icon name="settings" />설정</button>
        </nav>
      </header>
      <main className="screen" key={route.tab}>
        <div className="page">
        {route.tab === 'today' && <Today go={go} />}
        {route.tab === 'scan' && <Scan go={go} />}
        {route.tab === 'members' && <Members go={go} memberId={route.arg} />}
        {route.tab === 'payments' && <Payments go={go} />}
        {route.tab === 'settle' && <Settlement />}
        {route.tab === 'settings' && <Settings />}
        </div>
      </main>
      <nav className="tabbar" aria-label="하단 메뉴">
        {TABS.map((t) => (
          <button key={t.id} onClick={() => go(t.id)} aria-current={route.tab === t.id ? 'page' : undefined}>
            <Icon name={t.icon} />{t.label}
          </button>
        ))}
      </nav>
      <ToastHost />
    </div>
  );
}
