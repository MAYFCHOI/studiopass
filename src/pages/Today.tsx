import { useState } from 'react';
import dayjs from 'dayjs';
import { useStore } from '../store';
import type { Tab } from '../App';
import { WEEKDAYS } from '../lib/util';
import { ClassCard } from '../components/ClassCard';
import { passName, courseTitle } from '../lib/labels';
import type { Course, Hall } from '../types';
import { HALL_NAME } from '../lib/labels';

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

  const DAY_EN = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
  const nextWd = classes.length ? wd : [1, 2, 3, 4, 5, 6, 7].map((d) => (wd + d) % 7).find((d) => s.courses.some((c) => c.weekday.includes(d)));
  const shown = classes.length ? classes : nextWd === undefined ? [] : s.courses.filter((c) => c.weekday.includes(nextWd)).sort((a, b) => a.startTime.localeCompare(b.startTime));
  const count = (c: Course) => todayAtt.filter((a) => a.courseId === c.id).length;

  return (
    <div className="today">
      {welcome && (
        <div className="welcome">
          <div><b>연습용 데이터가 들어 있어요.</b> 회원·결제·출석은 가짜예요. 설정 맨 아래에서 처음 상태로 되돌릴 수 있어요.</div>
          <button onClick={closeWelcome} aria-label="안내 닫기">✕</button>
        </div>
      )}

      <header className="hero">
        <p className="hero-date num">{dayjs().format('YYYY. M. D')}</p>
        <h1 className="hero-day">{DAY_EN[wd]}</h1>
      </header>

      <div className="figures">
        <div className="fig"><b className="num">{todayAtt.length}</b><span>오늘 출석</span></div>
        <div className="fig"><b className="num">{monthAtt.length}</b><span>이달 출석</span></div>
        <div className="fig"><b className="num">{s.members.length}</b><span>회원</span></div>
        <button className="btn primary fig-cta" onClick={() => go('scan')}>QR 출석 체크</button>
      </div>

      {unassigned.length > 0 && (
        <button className="alert" onClick={() => go('payments')}>
          <span>회원과 연결되지 않은 결제가 <b className="num">{unassigned.length}건</b> 있어요</span>
          <span className="alert-go">결제 확인하기</span>
        </button>
      )}

      <section className="block">
        <h2>{classes.length ? '오늘 수업' : nextWd === (wd + 1) % 7 ? `오늘은 수업이 없어요. 내일(${WEEKDAYS[nextWd]}) 수업` : nextWd !== undefined ? `오늘은 수업이 없어요. ${WEEKDAYS[nextWd]}요일 수업` : '등록된 수업이 없어요'}</h2>
        {(['HUB', 'LAB'] as Hall[]).map((h) => {
          const list = shown.filter((c) => c.hall === h);
          if (!list.length) return null;
          return (
            <div className={`hall-row hall-${h.toLowerCase()}`} key={h}>
              <div className="hall-name">{HALL_NAME[h]}</div>
              <div className="hall-cards">{list.map((c) => <ClassCard key={c.id} c={c} range count={classes.length ? count(c) : undefined} />)}</div>
            </div>
          );
        })}
      </section>

      {expiring.length > 0 && (
        <section className="block">
          <h2>이번 주에 끝나는 수강권</h2>
          <div className="list">
            {expiring.map((p) => (
              <button className="row" key={p.id} onClick={() => go('members', p.memberId)}>
                <div className="main"><div className="t">{name(p.memberId)}</div><div className="d">{passName(s, p)}, {dayjs(p.validTo).format('M월 D일')}까지</div></div>
                <div className="right"><b className="num">{p.remaining}</b>회 남음</div>
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="block">
        <h2>오늘 출석한 회원</h2>
        {todayAtt.length === 0 ? <p className="sub">아직 없어요. QR 을 찍으면 여기에 쌓여요.</p> : (
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
      </section>
    </div>
  );
}
