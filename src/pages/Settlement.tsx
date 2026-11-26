import { useEffect, useState } from 'react';
import dayjs from 'dayjs';
import { useStore } from '../store';
import type { SettlementLine, SettlementDetail, SettlementCourse, Substitution, ExtraPay } from '../types';
import { won } from '../lib/util';
import { downloadXlsx } from '../lib/excel';
import { Icon } from '../components/Icon';
import { toast } from '../components/Toast';
import { Sheet } from '../components/Sheet';

export default function Settlement() {
  const s = useStore();
  const [month, setMonth] = useState(dayjs().format('YYYY-MM'));
  const [sort, setSort] = useState<'pay' | 'name'>('pay');
  const [open, setOpen] = useState<SettlementLine | null>(null);
  // 데모는 브라우저 안에서 계산, 서버 모드는 /settlement 결과. 출석·강사가 바뀌면 다시 받는다.
  const [raw, setRaw] = useState<SettlementLine[]>([]);
  // 못 받았으면 0원 대신 안내를 보이고 엑셀도 막는다. 달을 바꾸거나 다시 시도하면 다시 받는다.
  const [attempt, setAttempt] = useState(0);
  const key = `${month}#${attempt}`;
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const [subs, setSubs] = useState<Substitution[]>([]);
  const [subsKey, setSubsKey] = useState(0); // 대강을 넣거나 지우면 올려서 정산·목록을 다시 받는다
  const [extras, setExtras] = useState<ExtraPay[]>([]);
  useEffect(() => { let live = true; useStore.getState().substitutions(month).then((x) => { if (live) setSubs(x); }, () => {}); useStore.getState().extraPays(month).then((x) => { if (live) setExtras(x); }, () => {}); return () => { live = false; }; }, [month, subsKey]);
  const [subOpen, setSubOpen] = useState(false);
  const failed = failedKey === key;
  useEffect(() => {
    let live = true;
    useStore.getState().settlement(month).then((l) => { if (live) { setRaw(l); setFailedKey(null); } }, () => {
      if (!live) return;
      setRaw([]); setFailedKey(`${month}#${attempt}`);
      toast('정산을 불러오지 못했어요. 다시 시도해 주세요');
    });
    return () => { live = false; };
  }, [month, attempt, s.attendances, s.instructors, s.passes, subsKey]);
  // 그 달 결제 합계(결제 화면에서 옮겨 옴), 그 달 대강 목록
  const [paid, setPaid] = useState<number | null>(null);
  useEffect(() => { let live = true; useStore.getState().paymentsTotal(month).then((n) => { if (live) setPaid(n); }, () => {}); return () => { live = false; }; }, [month, s.payments]);
  const lines = [...raw].sort((a, b) => (sort === 'pay' ? b.instructorPay - a.instructorPay : a.instructor.name.localeCompare(b.instructor.name, 'ko')));
  const total = lines.reduce((n, l) => n + l.instructorPay, 0);
  const revenue = lines.reduce((n, l) => n + l.revenue, 0);
  const label = dayjs(month + '-01');

  /** 데모는 브라우저 데이터로, 서버 모드는 그 달 전체 상세를 서버에서 받는다(화면 데이터는 최근 62일뿐이라 지난달 이전이 빠진다). */
  const localDetail = (): SettlementDetail => ({
    attendances: s.attendances.filter((a) => !a.cancelledAt && dayjs(a.attendedAt).format('YYYY-MM') === month).map((a) => {
      const p = s.passes.find((x) => x.id === a.passId);
      return { attendedAt: a.attendedAt, member: s.members.find((m) => m.id === a.memberId)?.name ?? null, course: s.courses.find((c) => c.id === a.courseId)?.name ?? null, instructor: s.instructors.find((i) => i.id === a.instructorId)?.name ?? null, passKind: p?.kind ?? 'COUNT', value: p && p.kind === 'COUNT' ? Math.round((p.price ?? 0) / p.totalCount) : 0 };
    }),
    payments: s.payments.filter((p) => dayjs(p.paidAt).format('YYYY-MM') === month).map((p) => ({ paidAt: p.paidAt, member: s.members.find((m) => m.id === p.memberId)?.name ?? null, payerName: p.payerName ?? null, productName: p.productName, amount: p.amount ?? 0, status: p.status, source: p.source, externalId: p.externalId ?? null })),
  });
  const exportXlsx = async () => {
    let d: SettlementDetail;
    try { d = (await s.settlementDetail(month)) ?? localDetail(); } catch { toast('상세 내역을 불러오지 못했어요. 다시 시도해 주세요'); return; }
    downloadXlsx(`정산_${month}.xlsx`, [
      { name: '강사별 정산', rows: lines.map((l) => ({ 강사: l.instructor.name, 정산방식: term(l), 수업횟수: l.sessions, 출석인원: l.heads, 출석매출: l.revenue, 강사정산액: l.instructorPay, 학원몫: l.academyPay, 전문반출석: l.proTickets })) },
      { name: '수업별 정산', rows: lines.flatMap((l) => l.courses.map((c) => ({ 강사: l.instructor.name, 수업: courseLabel(c), 정산방식: courseTerm(c), 수업횟수: c.sessions, 출석인원: c.heads, 출석매출: c.revenue, 강사정산액: c.instructorPay, 계산: formula(c) }))) },
      { name: '출석 상세', rows: d.attendances.map((a) => ({ 일시: dayjs(a.attendedAt).format('YYYY-MM-DD HH:mm'), 회원: a.member ?? '', 수업: a.course ?? '', 강사: a.instructor ?? '', 수강권: a.passKind === 'PERIOD' ? '전문반 월정액' : '회차권', 회당금액: a.value })) },
      { name: '결제', rows: d.payments.map((p) => ({ 일시: dayjs(p.paidAt).format('YYYY-MM-DD HH:mm'), 회원: p.member ?? '연결 안 됨', 결제자: p.payerName ?? '', 상품: p.productName, 금액: p.amount, 상태: p.status === 'APPROVED' ? '승인' : '취소', 출처: p.source === 'KIOSK' ? '키오스크' : '수동', 승인번호: p.externalId ?? '' })) },
    ]);
    toast('엑셀을 저장했어요');
  };

  const academy = lines.reduce((n, l) => n + l.academyPay, 0);
  const sessions = lines.reduce((n, l) => n + l.sessions, 0);
  const shown = lines.filter((l) => l.sessions > 0 || l.proTickets > 0);
  const idle = lines.length - shown.length;
  const term = (l: SettlementLine) => {
    // 수업마다 조건이 다르면 한 줄로 못 적는다. 상세에서 수업별로 본다
    const kinds = new Set(l.courses.map(courseTerm));
    if (kinds.size > 1) return '수업별로 다름';
    if (kinds.size === 1) return [...kinds][0];
    return l.type === 'RATIO' ? `비율제 ${100 - (l.instructor.ratioInstructor ?? 0)}:${l.instructor.ratioInstructor ?? 0}` : `타임제 ${won(l.instructor.perSessionFee ?? 0)}`;
  };

  return (
    <div className="settle-page">
      <div className="month">
        <button onClick={() => setMonth(label.subtract(1, 'month').format('YYYY-MM'))} aria-label="이전 달">‹</button>
        <b>{label.format('YYYY년 M월')}</b>
        <button onClick={() => setMonth(label.add(1, 'month').format('YYYY-MM'))} aria-label="다음 달">›</button>
      </div>
      {failed ? (
        <div className="empty"><b>정산을 불러오지 못했어요</b>인터넷 연결을 확인하고 다시 시도해 주세요.<div style={{ marginTop: 14 }}><button className="btn sm" onClick={() => setAttempt((n) => n + 1)}>다시 시도</button></div></div>
      ) : <>
      <header className="hero">
        <p className="hero-date">강사에게 줄 돈</p>
        <h1 className="settle-total num">{won(total)}</h1>
      </header>
      <div className="figures">
        <div className="fig"><b className="num">{paid === null ? '…' : won(paid)}</b><span>이달 결제</span></div>
        <div className="fig"><b className="num">{won(revenue)}</b><span>출석 기준 매출</span></div>
        <div className="fig"><b className="num">{won(academy)}</b><span>학원 몫</span></div>
        <div className="fig"><b className="num">{sessions}</b><span>수업 횟수</span></div>
      </div>
      </>}

      <div className="ledger-tools">
        <div className="seg"><button aria-pressed={sort === 'pay'} onClick={() => setSort('pay')}>금액순</button><button aria-pressed={sort === 'name'} onClick={() => setSort('name')}>이름순</button></div>
        <button className="btn ghost sm" disabled={failed} onClick={() => { void exportXlsx(); }}><Icon name="download" size={16} />엑셀로 받기</button>
      </div>

      {!failed && <div className="ledger" role="table" aria-label="강사별 정산">
        <div className="lg-row lg-head" role="row">
          <span role="columnheader">강사</span><span role="columnheader">정산 방식</span><span role="columnheader">수업</span><span role="columnheader">출석</span><span role="columnheader">매출</span><span role="columnheader">학원 몫</span><span role="columnheader">강사 지급</span>
        </div>
        {shown.map((l) => (
          <div className="lg-row lg-open" role="row" key={l.instructor.id} tabIndex={0} aria-label={`${l.instructor.name} 상세 보기`} onClick={() => setOpen(l)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(l); } }}>
            <span className="lg-name" role="cell">{l.instructor.name}{l.proTickets > 0 && <small>전문반 {l.proTickets}회는 정산 제외</small>}</span>
            <span className="lg-term" role="cell">{term(l)}</span>
            <span className="num" role="cell" data-k="수업">{l.sessions}타임</span>
            <span className="num" role="cell" data-k="출석">{l.heads}명</span>
            <span className="num" role="cell" data-k="매출">{won(l.revenue)}</span>
            <span className="num" role="cell" data-k="학원 몫">{won(l.academyPay)}</span>
            <span className="lg-pay num" role="cell">{won(l.instructorPay)}</span>
          </div>
        ))}
        {idle > 0 && <p className="sub lg-idle">이달 출석이 없는 강사 {idle}명은 뺐어요.</p>}
        {shown.length > 0 && <p className="sub lg-idle">강사 줄을 누르면 수업별·날짜별 계산이 나와요.</p>}
      </div>}

      <section className="block">
        <div className="ledger-tools" style={{ marginTop: 8 }}><h2 style={{ margin: 0 }}>대강 · 추가 페이</h2><button className="btn sm" onClick={() => setSubOpen(true)}>넣기</button></div>
        {subs.length === 0 && extras.length === 0 ? <p className="sub">이달 대강·추가 페이가 없어요. 다른 강사가 수업을 맡은 날이나, 웜업처럼 시간표에 없는 일에 줄 페이를 넣으면 그 강사 정산에 더해져요.</p> : (
          <div className="list">
            {subs.map((x) => { const c = s.courses.find((y) => y.id === x.courseId); const who = s.instructors.find((i) => i.id === x.instructorId)?.name ?? '?'; const orig = s.instructors.find((i) => i.id === c?.instructorId)?.name;
              return (
                <div className="row" key={x.id}>
                  <div className="main"><div className="t">{dayjs(x.date).format('M/D (dd)')} {c ? `${c.startTime} ${c.name}` : '지운 수업'}</div><div className="d">{orig ? `${orig} → ` : ''}{who}{x.fee != null ? ` · 1타임 ${won(x.fee)}` : ''}</div></div>
                  <div className="right"><button className="chip" onClick={() => { if (confirm('이 대강을 지울까요? 그 날은 원래 강사 정산으로 돌아가요.')) void s.removeSubstitution(x.id).then(() => { setSubsKey((n) => n + 1); toast('지웠어요'); }, () => {}); }}>지우기</button></div>
                </div>
              ); })}
            {extras.map((x) => { const who = s.instructors.find((i) => i.id === x.instructorId)?.name ?? '?';
              return (
                <div className="row" key={x.id}>
                  <div className="main"><div className="t">{dayjs(x.date).format('M/D (dd)')} {x.memo || '추가 페이'}</div><div className="d">{who} · {won(x.fee)}</div></div>
                  <div className="right"><button className="chip" onClick={() => { if (confirm('이 추가 페이를 지울까요?')) void s.removeExtraPay(x.id).then(() => { setSubsKey((n) => n + 1); toast('지웠어요'); }, () => {}); }}>지우기</button></div>
                </div>
              ); })}
          </div>
        )}
      </section>

      <div className="note">정산 계산 기준
        <ul>
          <li>비율제: 출석 1회 가치 = 수강권 가격 ÷ 총 회차. 이달 출석분만 더해 강사 비율로 나눠요.</li>
          <li>타임제: 출석이 1명 이상 있던 수업 1회 = 1타임. 수강권 매출은 전액 학원.</li>
          <li>전문반 월정액 출석은 금액으로 바꾸지 않고 강사별 횟수만 세요.</li>
          <li>수업에 정산 방식을 따로 정하면(설정 → 수업) 그 수업만 그 방식으로 계산하고 강사별로 더해요.</li>
          <li>대강한 날은 그 날 출석·원데이와 1타임이 대강 강사 몫이에요. 1타임 금액을 적으면 그 금액, 비우면 수업(없으면 대강 강사) 정산 방식을 따라요.</li>
          <li>타임제 수업에 인원 인센티브를 정하면(설정 → 수업) 그 날 정한 인원부터 1명당 금액을 1타임에 더해요.</li>
          <li>추가 페이(웜업 등 시간표에 없는 일)는 적은 금액 그대로 그 강사 지급에 더해요. 매출과 학원 몫에는 들어가지 않아요.</li>
        </ul>
      </div>
      {open && <InstructorDetail line={open} month={label.format('YYYY년 M월')} onClose={() => setOpen(null)} />}
      {subOpen && <SubSheet month={month} onClose={() => setSubOpen(false)} onSaved={() => { setSubOpen(false); setSubsKey((n) => n + 1); }} />}
    </div>
  );
}

const DAY = '일월화수목금토';
const courseLabel = (c: SettlementCourse) => (c.extra ? `${c.name} (추가 페이)` : `${DAY[c.weekday]} ${c.startTime} ${c.name}${c.sub ? ' (대강)' : ''}`);
const courseTerm = (c: SettlementCourse) => (c.extra ? '추가 페이' : c.type === 'RATIO' ? `비율제 ${c.ratioInstructor}%` : `타임제 ${won(c.perSessionFee)}`);
const formula = (c: SettlementCourse) => {
  if (c.extra) return c.perSessionFee ? `${c.sessions}회 × ${won(c.perSessionFee)} = ${won(c.instructorPay)}` : `${c.days.map((d) => `${dayjs(d.date).format('M/D')} ${won(d.fee ?? 0)}`).join(' + ')} = ${won(c.instructorPay)}`;
  const b = c.bonus ?? 0; const base = c.instructorPay - b;
  const plus = b ? ` + 출석 추가 페이 ${won(b)} = ${won(c.instructorPay)}` : '';
  const hb = c.headBonus ?? 0;
  const head = c.bonusFrom ? ` + 인원 추가 ${hb / (c.bonusPerHead || 1)}명 × ${won(c.bonusPerHead ?? 0)}` : '';
  return c.type === 'RATIO'
    ? `매출 ${won(c.revenue)} × ${c.ratioInstructor}% = ${won(base)}${plus}`
    : head ? `${c.sessions}타임 × ${won(c.perSessionFee)}${head}${b ? ` + 출석 추가 페이 ${won(b)}` : ''} = ${won(c.instructorPay)}` : `${c.sessions}타임 × ${won(c.perSessionFee)} = ${won(base)}${plus}`;
};

/** 강사 한 명의 그 달 계산: 수업별 조건과 식, 날짜별 출석한 사람과 1회 금액. 합계가 정산 화면의 강사 지급과 같다 */
function InstructorDetail({ line, month, onClose }: { line: SettlementLine; month: string; onClose: () => void }) {
  const kind = (k: string) => (k === 'PERIOD' ? '전문반' : k === 'DROP_IN' ? '원데이' : '');
  return (
    <Sheet onClose={onClose} title={`${line.instructor.name} · ${month}`}>
      <div className="sd-total"><span>강사 지급</span><b className="num">{won(line.instructorPay)}</b></div>
      <p className="sub" style={{ margin: '0 0 12px' }}>수업 {line.sessions}타임 · 출석 {line.heads}명 · 매출 {won(line.revenue)}</p>
      {line.courses.length === 0 && <p className="sub">이달 출석이 없어요.</p>}
      {line.courses.map((c) => (
        <section className="sd-course" key={c.courseId + (c.sub ? '#sub' : '')}>
          <div className="sd-head"><b>{courseLabel(c)}</b><span>{courseTerm(c)}{c.sub ? ' · 대강' : c.custom && !c.extra ? ' · 이 수업만' : ''}</span></div>
          <div className="sd-formula num">{formula(c)}</div>
          {c.proTickets > 0 && <p className="sub" style={{ margin: '0 0 6px' }}>전문반 출석 {c.proTickets}회는 매출 0원으로 셌어요{c.bonus ? '. 출석 추가 페이는 강사 몫에 따로 더했어요' : ''}.</p>}
          <div className="sd-days">
            {c.days.map((d) => (
              <div className="sd-day" key={d.date}>
                <div className="sd-date"><b>{dayjs(d.date).format('M/D')}</b><span>{c.extra ? won(d.fee ?? 0) : `${d.heads}명 · ${won(d.revenue)}${d.over ? ` · 인원 추가 ${d.over}명` : ''}`}</span></div>
                <div className="sd-people">{d.people.length === 0 && !c.extra && <span>출석 기록 없음</span>}{d.people.map((p, i) => <span key={i}>{p.name || '이름 없음'}{kind(p.kind) && <em>{kind(p.kind)}</em>}{p.paidOn && <em>{dayjs(p.paidOn).format('M/D')} 결제</em>} <span className="num">{won(p.value)}{p.bonus ? ` +${won(p.bonus)}` : ''}</span></span>)}</div>
              </div>
            ))}
          </div>
        </section>
      ))}
    </Sheet>
  );
}

const EXTRA = '__extra';
/** 대강 넣기: 수업·날짜(그 수업 요일)·맡은 강사, 1타임 금액(선택). 수업 대신 '시간표에 없는 일'을 고르면 추가 페이(날짜·강사·금액·메모) */
function SubSheet({ month, onClose, onSaved }: { month: string; onClose: () => void; onSaved: () => void }) {
  const s = useStore();
  const [courseId, setCourseId] = useState('');
  const course = s.courses.find((c) => c.id === courseId);
  const extra = courseId === EXTRA;
  const [memo, setMemo] = useState('웜업');
  const days = course ? Array.from({ length: dayjs(month + '-01').daysInMonth() }, (_, i) => dayjs(month + '-01').add(i, 'day')).filter((d) => d.day() === course.weekday[0]).map((d) => d.format('YYYY-MM-DD')) : [];
  const [date, setDate] = useState('');
  const [ins, setIns] = useState('');
  const [fee, setFee] = useState('');
  const [busy, setBusy] = useState(false);
  const courses = s.courses.filter((c) => !c.deleted && c.kind === 'GENERAL').sort((a, b) => a.weekday[0] - b.weekday[0] || a.startTime.localeCompare(b.startTime));
  const save = async () => {
    setBusy(true);
    try {
      const n = Number(fee.replace(/\D/g, ''));
      if (extra) { await s.addExtraPay({ date, instructorId: ins, fee: n, memo: memo.trim() }); toast('추가 페이를 넣었어요'); onSaved(); return; }
      const r = await s.addSubstitution({ courseId, date, instructorId: ins, ...(fee.trim() ? { fee: n } : {}) });
      if (r.ok) { toast('대강을 넣었어요'); onSaved(); } else toast(r.error === 'SAME_INSTRUCTOR' ? '원래 강사와 같아요. 다른 강사를 골라 주세요' : r.error === 'WRONG_DAY' ? '그 수업 요일이 아니에요' : '넣지 못했어요');
    } catch { /* 스토어가 알린다 */ } finally { setBusy(false); }
  };
  return (
    <Sheet onClose={onClose} title="대강 · 추가 페이 넣기">
      <p className="sub">{extra ? '웜업처럼 시간표에 없는 일에 줄 페이예요. 적은 금액이 그 강사 정산에 그대로 더해져요.' : '다른 강사가 수업을 맡은 날을 넣으면 그 날 출석·원데이와 1타임이 대강 강사에게 정산돼요. 출석이 없어도 1타임으로 세요.'}</p>
      <div className="field"><label>수업</label><select className="input" value={courseId} onChange={(e) => { setCourseId(e.target.value); setDate(''); }}>
        <option value="">고르기</option><option value={EXTRA}>시간표에 없는 일 (웜업 등)</option>{courses.map((c) => <option key={c.id} value={c.id}>{DAY[c.weekday[0]]} {c.startTime} {c.name}{c.note ? ` · ${c.note}` : ''} · {s.instructors.find((i) => i.id === c.instructorId)?.name ?? ''}{c.active === false ? ' · 쉬는 중' : ''}</option>)}
      </select></div>
      {extra && <>
        <div className="field"><label>무슨 일</label><input className="input" maxLength={40} value={memo} onChange={(e) => setMemo(e.target.value)} /></div>
        <div className="field"><label>날짜</label><input className="input" type="date" min={`${month}-01`} max={dayjs(month + '-01').endOf('month').format('YYYY-MM-DD')} value={date} onChange={(e) => setDate(e.target.value)} /></div>
      </>}
      {course && <div className="field"><label>날짜</label><div className="seg" style={{ flexWrap: 'wrap' }}>{days.map((d) => <button key={d} aria-pressed={date === d} onClick={() => setDate(d)}>{dayjs(d).format('M/D')}</button>)}</div></div>}
      <div className="field"><label>{extra ? '강사' : '맡은 강사'}</label><select className="input" value={ins} onChange={(e) => setIns(e.target.value)}><option value="">고르기</option>{s.instructors.filter((i) => i.active !== false && i.id !== course?.instructorId).map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</select></div>
      <div className="field"><label>{extra ? '금액' : '그 날 1타임 금액 (비우면 수업 정산 방식대로)'}</label><input className="input" inputMode="numeric" placeholder={course?.settlementType === 'PER_SESSION' ? `수업 기준 ${won(course.perSessionFee ?? 0)}` : '예: 50000'} value={fee} onChange={(e) => setFee(e.target.value)} /></div>
      <button className="btn primary wide" disabled={busy || !courseId || !date || !ins || (extra && !(Number(fee.replace(/\D/g, '')) > 0))} onClick={() => { void save(); }}>{busy ? '저장 중…' : extra ? '추가 페이 넣기' : '대강 넣기'}</button>
    </Sheet>
  );
}
