import { useState } from 'react';
import dayjs from 'dayjs';
import { useStore } from '../store';
import type { Tab } from '../App';
import { WEEKDAYS } from '../lib/util';
import { ClassCard } from '../components/ClassCard';
import { passName, courseTitle } from '../lib/labels';
import type { Course } from '../types';

export default function Today({ go }: { go: (t: Tab, arg?: string) => void }) {
  const s = useStore();
  const t = dayjs().format('YYYY-MM-DD');
  const todayAtt = s.attendances.filter((a) => !a.cancelledAt && dayjs(a.attendedAt).format('YYYY-MM-DD') === t);
  const unassigned = s.payments.filter((p) => p.status === 'APPROVED' && !p.memberId);
  const wd = dayjs().day();
  const classes = s.courses.filter((c) => c.weekday.includes(wd)).sort((a, b) => a.startTime.localeCompare(b.startTime));
  const expiring = s.passes.filter((p) => p.remaining > 0 && p.validTo >= t && dayjs(p.validTo).diff(dayjs(), 'day') <= 7);
  const monthAtt = s.attendances.filter((a) => !a.cancelledAt && dayjs(a.attendedAt).format('YYYY-MM') === dayjs().format('YYYY-MM'));
  const name = (id: string) => s.members.find((m) => m.id === id)?.name ?? '?';
  const course = (id: string) => s.courses.find((c) => c.id === id);

  const [welcome, setWelcome] = useState(() => { try { return !localStorage.getItem('sp-welcome'); } catch { return true; } });
  const closeWelcome = () => { setWelcome(false); try { localStorage.setItem('sp-welcome', '1'); } catch { /* noop */ } };

  return (
    <>
      {welcome && (
        <div className="welcome">
          <div><b>연습용 데이터가 들어 있어요</b>회원·결제·출석이 전부 가짜예요. 마음껏 눌러보고, 처음으로 되돌리려면 설정 맨 아래 "데모 데이터로 초기화"를 누르면 돼요.</div>
          <button onClick={closeWelcome} aria-label="닫기">✕</button>
        </div>
      )}
      <div className="dash">
      <section className="dash-main">
      <h1><small>{WEEKDAYS[wd]}요일, 수업 {classes.length}개</small>오늘 출석<br />{todayAtt.length}명</h1>
      <div className="stats">
        <div className="stat"><b className="num">{s.members.length}</b><span>회원</span></div>
        <div className="stat"><b className="num">{monthAtt.length}</b><span>이달 출석</span></div>
        <button className={'stat' + (unassigned.length ? ' hot' : '')} onClick={() => go('payments')}><b className="num">{unassigned.length}</b><span>확인 필요 결제</span></button>
      </div>
      <div className="btn-row">
        <button className="btn primary wide" onClick={() => go('scan')}>QR 출석 체크</button>
      </div>

      {classes.length > 0 ? (<>
        <h2>오늘 수업</h2>
        <ClassGrid list={classes} counts={(c) => todayAtt.filter((a) => a.courseId === c.id).length} />
      </>) : (() => {
        const next = [1, 2, 3, 4, 5, 6, 7].map((d) => (wd + d) % 7).find((d) => s.courses.some((c) => c.weekday.includes(d)));
        const nl = next === undefined ? [] : s.courses.filter((c) => c.weekday.includes(next)).sort((a, b) => a.startTime.localeCompare(b.startTime));
        return (<>
          <h2>오늘은 수업이 없어요</h2>
          {next !== undefined && <><p className="sub">다음 수업 · {next === (wd + 1) % 7 ? '내일' : ''} {WEEKDAYS[next]}요일</p><ClassGrid list={nl} /></>}
        </>);
      })()}

      </section>
      <aside className="dash-side">
      {expiring.length > 0 && (<div className="panel">
        <h2>이번 주 만료</h2>
        <div className="list">
          {expiring.map((p) => (
            <button className="row" key={p.id} onClick={() => go('members', p.memberId)}>
              <div className="main"><div className="t">{name(p.memberId)}</div><div className="d">{passName(s, p)} · {dayjs(p.validTo).format('M/D')}까지</div></div>
              <div className="right"><b className="num">{p.remaining}</b>남음</div>
            </button>
          ))}
        </div>
      </div>)}

      <div className="panel">
      <h2>최근 출석</h2>
      {todayAtt.length === 0 ? <p className="sub">아직 출석이 없어요. QR 을 찍으면 여기에 쌓여요.</p> : (
        <div className="list">
          {[...todayAtt].reverse().slice(0, 12).map((a) => (
            <button className="row" key={a.id} onClick={() => go('members', a.memberId)}>
              <div className="avatar">{name(a.memberId).slice(-2)}</div>
              <div className="main"><div className="t">{name(a.memberId)}</div><div className="d">{(() => { const c = course(a.courseId); return c ? courseTitle(s, c) : ''; })()}</div></div>
              <div className="right num">{dayjs(a.attendedAt).format('HH:mm')}</div>
            </button>
          ))}
        </div>
      )}
      </div>
      </aside>
      </div>
    </>
  );
}

function ClassGrid({ list, counts }: { list: Course[]; counts?: (c: Course) => number }) {
  return <div className="cc-grid">{list.map((c) => <ClassCard key={c.id} c={c} count={counts?.(c)} dim={c.hall} range />)}</div>;
}
