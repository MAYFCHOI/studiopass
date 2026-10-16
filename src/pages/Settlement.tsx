import { useState } from 'react';
import dayjs from 'dayjs';
import { useStore } from '../store';
import { settle, type SettlementLine } from '../lib/settlement';
import { won } from '../lib/util';
import { downloadXlsx } from '../lib/excel';
import { Icon } from '../components/Icon';
import { toast } from '../components/Toast';

export default function Settlement() {
  const s = useStore();
  const [month, setMonth] = useState(dayjs().format('YYYY-MM'));
  const [sort, setSort] = useState<'pay' | 'name'>('pay');
  const lines = settle(s, month).sort((a, b) => (sort === 'pay' ? b.instructorPay - a.instructorPay : a.instructor.name.localeCompare(b.instructor.name, 'ko')));
  const total = lines.reduce((n, l) => n + l.instructorPay, 0);
  const revenue = lines.reduce((n, l) => n + l.revenue, 0);
  const label = dayjs(month + '-01');

  const exportXlsx = () => {
    const att = s.attendances.filter((a) => !a.cancelledAt && dayjs(a.attendedAt).format('YYYY-MM') === month);
    downloadXlsx(`정산_${month}.xlsx`, [
      { name: '강사별 정산', rows: lines.map((l) => ({ 강사: l.instructor.name, 정산방식: l.type === 'RATIO' ? `비율제 ${l.instructor.ratioInstructor}%` : `타임제 ${won(l.instructor.perSessionFee)}`, 수업횟수: l.sessions, 출석인원: l.heads, 출석매출: l.revenue, 강사정산액: l.instructorPay, 학원몫: l.academyPay, 전문반출석: l.proTickets })) },
      { name: '출석 상세', rows: att.map((a) => { const p = s.passes.find((x) => x.id === a.passId); return { 일시: dayjs(a.attendedAt).format('YYYY-MM-DD HH:mm'), 회원: s.members.find((m) => m.id === a.memberId)?.name, 수업: s.courses.find((c) => c.id === a.courseId)?.name, 강사: s.instructors.find((i) => i.id === a.instructorId)?.name, 수강권: p?.kind === 'PERIOD' ? '전문반 월정액' : '회차권', 회당금액: p && p.kind === 'COUNT' ? Math.round(p.price / p.totalCount) : 0 }; }) },
      { name: '결제', rows: s.payments.filter((p) => dayjs(p.paidAt).format('YYYY-MM') === month).map((p) => ({ 일시: dayjs(p.paidAt).format('YYYY-MM-DD HH:mm'), 회원: s.members.find((m) => m.id === p.memberId)?.name ?? '연결 안 됨', 결제자: p.payerName, 상품: p.productName, 금액: p.amount, 상태: p.status === 'APPROVED' ? '승인' : '취소', 출처: p.source === 'KIOSK' ? '키오스크' : '수동', 승인번호: p.externalId })) },
    ]);
    toast('엑셀을 저장했어요');
  };

  const academy = revenue - lines.filter((l) => l.type === 'RATIO').reduce((n, l) => n + l.instructorPay, 0);
  const sessions = lines.reduce((n, l) => n + l.sessions, 0);
  const shown = lines.filter((l) => l.sessions > 0 || l.proTickets > 0);
  const idle = lines.length - shown.length;
  const term = (l: SettlementLine) => (l.type === 'RATIO' ? `비율제 ${100 - l.instructor.ratioInstructor}:${l.instructor.ratioInstructor}` : `타임제 ${won(l.instructor.perSessionFee)}`);

  return (
    <div className="settle-page">
      <div className="month">
        <button onClick={() => setMonth(label.subtract(1, 'month').format('YYYY-MM'))} aria-label="이전 달">‹</button>
        <b>{label.format('YYYY년 M월')}</b>
        <button onClick={() => setMonth(label.add(1, 'month').format('YYYY-MM'))} aria-label="다음 달">›</button>
      </div>
      <header className="hero">
        <p className="hero-date">강사에게 줄 돈</p>
        <h1 className="settle-total num">{won(total)}</h1>
      </header>
      <div className="figures">
        <div className="fig"><b className="num">{won(revenue)}</b><span>출석 기준 매출</span></div>
        <div className="fig"><b className="num">{won(academy)}</b><span>학원 몫</span></div>
        <div className="fig"><b className="num">{sessions}</b><span>수업 횟수</span></div>
      </div>

      <div className="ledger-tools">
        <div className="seg"><button aria-pressed={sort === 'pay'} onClick={() => setSort('pay')}>금액순</button><button aria-pressed={sort === 'name'} onClick={() => setSort('name')}>이름순</button></div>
        <button className="btn ghost sm" onClick={exportXlsx}><Icon name="download" size={16} />엑셀로 받기</button>
      </div>

      <div className="ledger" role="table" aria-label="강사별 정산">
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
      </div>

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
