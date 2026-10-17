import { useEffect, useState } from 'react';
import dayjs from 'dayjs';
import { useStore } from '../store';
import type { SettlementLine, SettlementDetail } from '../types';
import { won } from '../lib/util';
import { downloadXlsx } from '../lib/excel';
import { Icon } from '../components/Icon';
import { toast } from '../components/Toast';

export default function Settlement() {
  const s = useStore();
  const [month, setMonth] = useState(dayjs().format('YYYY-MM'));
  const [sort, setSort] = useState<'pay' | 'name'>('pay');
  // 데모는 브라우저 안에서 계산, 서버 모드는 /settlement 결과. 출석·강사가 바뀌면 다시 받는다.
  const [raw, setRaw] = useState<SettlementLine[]>([]);
  // 못 받았으면 0원 대신 안내를 보이고 엑셀도 막는다. 달을 바꾸거나 다시 시도하면 다시 받는다.
  const [attempt, setAttempt] = useState(0);
  const key = `${month}#${attempt}`;
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const failed = failedKey === key;
  useEffect(() => {
    let live = true;
    useStore.getState().settlement(month).then((l) => { if (live) { setRaw(l); setFailedKey(null); } }, () => {
      if (!live) return;
      setRaw([]); setFailedKey(`${month}#${attempt}`);
      toast('정산을 불러오지 못했어요. 다시 시도해 주세요');
    });
    return () => { live = false; };
  }, [month, attempt, s.attendances, s.instructors, s.passes]);
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
      { name: '강사별 정산', rows: lines.map((l) => ({ 강사: l.instructor.name, 정산방식: l.type === 'RATIO' ? `비율제 ${l.instructor.ratioInstructor ?? 0}%` : `타임제 ${won(l.instructor.perSessionFee ?? 0)}`, 수업횟수: l.sessions, 출석인원: l.heads, 출석매출: l.revenue, 강사정산액: l.instructorPay, 학원몫: l.academyPay, 전문반출석: l.proTickets })) },
      { name: '출석 상세', rows: d.attendances.map((a) => ({ 일시: dayjs(a.attendedAt).format('YYYY-MM-DD HH:mm'), 회원: a.member ?? '', 수업: a.course ?? '', 강사: a.instructor ?? '', 수강권: a.passKind === 'PERIOD' ? '전문반 월정액' : '회차권', 회당금액: a.value })) },
      { name: '결제', rows: d.payments.map((p) => ({ 일시: dayjs(p.paidAt).format('YYYY-MM-DD HH:mm'), 회원: p.member ?? '연결 안 됨', 결제자: p.payerName ?? '', 상품: p.productName, 금액: p.amount, 상태: p.status === 'APPROVED' ? '승인' : '취소', 출처: p.source === 'KIOSK' ? '키오스크' : '수동', 승인번호: p.externalId ?? '' })) },
    ]);
    toast('엑셀을 저장했어요');
  };

  const academy = revenue - lines.filter((l) => l.type === 'RATIO').reduce((n, l) => n + l.instructorPay, 0);
  const sessions = lines.reduce((n, l) => n + l.sessions, 0);
  const shown = lines.filter((l) => l.sessions > 0 || l.proTickets > 0);
  const idle = lines.length - shown.length;
  const term = (l: SettlementLine) => (l.type === 'RATIO' ? `비율제 ${100 - (l.instructor.ratioInstructor ?? 0)}:${l.instructor.ratioInstructor ?? 0}` : `타임제 ${won(l.instructor.perSessionFee ?? 0)}`);

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
          <div className="lg-row" role="row" key={l.instructor.id}>
            <span className="lg-name" role="cell">{l.instructor.name}{l.proTickets > 0 && <small>전문반 {l.proTickets}회는 정산 제외</small>}</span>
            <span className="lg-term" role="cell">{term(l)}</span>
            <span className="num" role="cell" data-k="수업">{l.sessions}타임</span>
            <span className="num" role="cell" data-k="출석">{l.heads}명</span>
            <span className="num" role="cell" data-k="매출">{won(l.revenue)}</span>
            <span className="num" role="cell" data-k="학원 몫">{l.type === 'RATIO' ? won(l.academyPay) : won(l.revenue)}</span>
            <span className="lg-pay num" role="cell">{won(l.instructorPay)}</span>
          </div>
        ))}
        {idle > 0 && <p className="sub lg-idle">이달 출석이 없는 강사 {idle}명은 뺐어요.</p>}
      </div>}

      <div className="note">정산 계산 기준
        <ul>
          <li>비율제: 출석 1회 가치 = 수강권 가격 ÷ 총 회차. 이달 출석분만 더해 강사 비율로 나눠요.</li>
          <li>타임제: 출석이 1명 이상 있던 수업 1회 = 1타임. 수강권 매출은 전액 학원.</li>
          <li>전문반 월정액 출석은 금액으로 바꾸지 않고 강사별 횟수만 세요.</li>
        </ul>
      </div>
    </div>
  );
}
