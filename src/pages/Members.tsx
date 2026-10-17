import { useEffect, useRef, useState } from 'react';
import dayjs from 'dayjs';
import QRCode from 'qrcode';
import { useStore } from '../store';
import type { Tab } from '../App';
import { fmtPhone, qrPayload, maybeWon } from '../lib/util';
import { Sheet } from '../components/Sheet';
import { Icon } from '../components/Icon';
import { passName, courseTitle } from '../lib/labels';
import logoMark from '../assets/logo-mark.png';
import { toast } from '../components/Toast';
import { IS_DEMO } from '../lib/mode';

function QR({ text }: { text: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => { if (ref.current) QRCode.toCanvas(ref.current, text, { margin: 0, width: 216, color: { dark: '#000000', light: '#ffffff' } }); }, [text]);
  return <canvas ref={ref} aria-label="회원 QR" />;
}

export default function Members({ go, memberId }: { go: (t: Tab, arg?: string) => void; memberId?: string }) {
  const s = useStore();
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: '', phone: '', memo: '' });
  const [talkBusy, setTalkBusy] = useState(false);

  if (memberId) {
    const m = s.members.find((x) => x.id === memberId);
    if (!m) return <div className="empty"><b>회원을 찾을 수 없어요</b><button className="btn sm" onClick={() => go('members')}>목록으로</button></div>;
    const passes = s.passes.filter((p) => p.memberId === m.id).sort((a, b) => b.validFrom.localeCompare(a.validFrom));
    const att = s.attendances.filter((a) => a.memberId === m.id).sort((a, b) => b.attendedAt.localeCompare(a.attendedAt));
    const pays = s.payments.filter((p) => p.memberId === m.id).sort((a, b) => b.paidAt.localeCompare(a.paidAt));
    const course = (id: string) => { const c = s.courses.find((x) => x.id === id); return c ? courseTitle(s, c) : '삭제된 수업'; };
    const t = dayjs().format('YYYY-MM-DD');
    const share = async () => {
      const canvas = document.querySelector<HTMLCanvasElement>('.pass canvas');
      if (!canvas) return;
      const blob: Blob | null = await new Promise((r) => canvas.toBlob(r, 'image/png'));
      if (!blob) return;
      const file = new File([blob], `${m.name}-qr.png`, { type: 'image/png' });
      if (navigator.share && navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file], title: `${m.name} 회원 QR` }).catch(() => {}); return; }
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = file.name; a.click();
      toast('QR 이미지를 저장했어요');
    };
    // 서버 모드: QR 은 서버가 서명(AM2)해서 회원 페이지에만 보인다. 관리자 화면은 그 페이지 링크를 보낸다.
    const sendLink = async () => {
      const url = await s.issueLink(m.id).catch(() => null);
      if (!url) { toast('링크를 만들지 못했어요. 다시 시도해 주세요'); return; }
      const text = '[THE DEPTH] ' + m.name + '님 회원 페이지예요. 출석할 때 이 화면의 QR 을 보여주세요.\n' + url;
      if (/Android|iPhone/i.test(navigator.userAgent)) {
        await s.recordMessage(m.id).catch(() => {});
        window.location.assign('sms:' + m.phone + '?body=' + encodeURIComponent(text));
        return;
      }
      const copied = await navigator.clipboard?.writeText(text).then(() => true, () => false);
      if (!copied) { window.prompt('아래 내용을 복사해 문자로 보내 주세요', text); } else toast('링크를 복사했어요');
      await s.recordMessage(m.id).catch(() => {});
    };
    const sendTalk = async () => {
      if (talkBusy) return;
      setTalkBusy(true);
      const r = await s.sendAlimtalkLink(m.id).catch(() => null);
      setTalkBusy(false);
      if (r?.ok) toast('알림톡으로 링크를 보냈어요');
      else if (r?.error === 'NO_PHONE') toast('전화번호가 없어서 보낼 수 없어요');
      else toast('알림톡을 보내지 못했어요. 링크 문자로 보내 주세요');
    };
    return (
      <>
        <button className="btn sm ghost" style={{ marginTop: 14 }} onClick={() => go('members')}><Icon name="back" size={16} />회원 목록</button>
        <div className="pass">
          <div className="band"><img className="band-mark" src={logoMark} alt="" /><span>THE DEPTH<small>DANCE STUDIO</small></span><span className="no">{m.memberNo}</span></div>
          <div className="body">
            <div><div className="name">{m.name}</div><div className="phone">{fmtPhone(m.phone)}</div><div className="phone">{dayjs(m.createdAt).format('YYYY.M.D')} 등록</div></div>
            {IS_DEMO && <QR text={qrPayload(m.id)} />}
          </div>
          <div className="perf"><span>{IS_DEMO ? '이 QR 을 카메라에 보여주면 출석돼요' : '회원 페이지의 QR 을 카메라에 보여주면 출석돼요'}</span><span>{s.activePasses(m.id).reduce((n, p) => n + p.remaining, 0)}회 남음</span></div>
        </div>
        <div className="btn-row">
          {IS_DEMO ? <button className="btn primary wide" onClick={share}>QR 보내기</button>
            : s.alimtalkEnabled ? <button className="btn primary wide" disabled={talkBusy} onClick={() => { void sendTalk(); }}>{talkBusy ? '보내는 중…' : '알림톡으로 링크 보내기'}</button>
            : <button className="btn primary wide" onClick={() => { void sendLink(); }}>링크 문자 보내기</button>}
          <button className="btn wide" onClick={() => { setForm({ name: m.name, phone: fmtPhone(m.phone), memo: m.memo ?? '' }); setAdding(true); }}>정보 수정</button>
        </div>
        {!IS_DEMO && s.alimtalkEnabled && <button className="btn sm ghost" style={{ marginTop: 8 }} onClick={() => { void sendLink(); }}>링크 문자 보내기</button>}

        <h2>수강권</h2>
        {passes.length === 0 ? <p className="sub">아직 수강권이 없어요. 결제가 들어오면 자동으로 생겨요.</p> : (
          <div className="list">
            {passes.map((p) => {
              const expired = p.validTo < t; const done = p.remaining <= 0;
              return (
                <div className="row" key={p.id}>
                  <div className="main"><div className="t">{passName(s, p)} {p.kind === 'PERIOD' && <span className="chip pro">월정액</span>}</div><div className="d">{dayjs(p.validFrom).format('M/D')} ~ {dayjs(p.validTo).format('M/D')} {maybeWon(p.price, ' · ')}{expired ? ' · 기간 만료' : done ? ' · 소진' : ''}</div></div>
                  <div className="right"><b className="num">{p.remaining}</b>/ {p.totalCount}</div>
                </div>
              );
            })}
          </div>
        )}

        <h2>출석 기록</h2>
        {att.length === 0 ? <p className="sub">출석 기록이 없어요.</p> : (
          <div className="list">
            {att.slice(0, 30).map((a) => (
              <div className="row" key={a.id} style={a.cancelledAt ? { opacity: .4 } : undefined}>
                <div className="main"><div className="t">{course(a.courseId)}</div><div className="d">{dayjs(a.attendedAt).format('M/D (dd) HH:mm')} · {s.courses.find((c) => c.id === a.courseId)?.hall}{s.passes.find((p) => p.id === a.passId)?.kind === 'PERIOD' && ' · 월정액'}{a.cancelledAt && ' · 취소됨'}</div></div>
                {!a.cancelledAt && <button className="btn sm ghost" onClick={() => { if (confirm('이 출석을 취소하고 횟수를 되돌릴까요?')) { s.cancelAttendance(a.id).then(() => toast('출석을 취소했어요'), () => {}); } }}>취소</button>}
              </div>
            ))}
          </div>
        )}

        <h2>결제</h2>
        {pays.length === 0 ? <p className="sub">결제 내역이 없어요.</p> : (
          <div className="list">
            {pays.map((p) => (
              <div className="row" key={p.id}>
                <div className="main"><div className="t">{p.productName}</div><div className="d">{dayjs(p.paidAt).format('YYYY.M.D HH:mm')} · {p.source === 'KIOSK' ? '키오스크' : '수동'}{p.status === 'CANCELLED' && <span className="chip danger" style={{ marginLeft: 6 }}>취소</span>}</div></div>
                <div className="right num">{maybeWon(p.amount)}</div>
              </div>
            ))}
          </div>
        )}

        {adding && (
          <Sheet onClose={() => setAdding(false)} title="회원 정보 수정">
            <MemberForm form={form} setForm={setForm} onSubmit={() => { s.updateMember(m.id, form).then(() => { setAdding(false); toast('저장했어요'); }, () => {}); }} label="저장" />
          </Sheet>
        )}
      </>
    );
  }

  const qq = q.trim();
  const list = s.members.filter((m) => !qq || m.name.includes(qq) || m.phone.includes(qq.replace(/\D/g, '') || '\u0000') || m.memberNo.includes(qq)).sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  return (
    <>
      <h1><small>{s.members.length}명</small>회원</h1>
      <div className="search"><input className="input" placeholder="이름, 전화번호, 회원번호" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      <div className="list cols">
        {list.map((m) => {
          const ap = s.activePasses(m.id); const left = ap.reduce((n, p) => n + p.remaining, 0);
          const last = s.attendances.filter((a) => a.memberId === m.id && !a.cancelledAt).sort((a, b) => b.attendedAt.localeCompare(a.attendedAt))[0];
          return (
            <button className="row" key={m.id} onClick={() => go('members', m.id)}>
              <div className="avatar">{m.name.slice(-2)}</div>
              <div className="main"><div className="t">{m.name} {ap.some((p) => p.kind === 'PERIOD') && <span className="chip pro">전문반</span>}</div><div className="d">{last ? `마지막 출석 ${dayjs(last.attendedAt).format('M/D')}` : '출석 기록 없음'} · {fmtPhone(m.phone)}</div></div>
              <div className="right">{ap.length ? <><b className="num">{left}</b>남음</> : <span className="chip danger">수강권 없음</span>}</div>
            </button>
          );
        })}
        {list.length === 0 && <div className="empty"><b>검색 결과가 없어요</b>아래에서 새 회원을 등록할 수 있어요</div>}
      </div>
      <div style={{ height: 70 }} />
      <button className="btn primary fab" onClick={() => { setForm({ name: '', phone: '', memo: '' }); setAdding(true); }}><Icon name="plus" />새 회원</button>
      {adding && (
        <Sheet onClose={() => setAdding(false)} title="새 회원 등록">
          <MemberForm form={form} setForm={setForm} onSubmit={() => { s.addMember(form).then((m) => { setAdding(false); toast(`${m.name} 등록, QR 이 발급됐어요`); go('members', m.id); }, () => {}); }} label="등록하고 QR 만들기" />
        </Sheet>
      )}
    </>
  );
}

function MemberForm({ form, setForm, onSubmit, label }: { form: { name: string; phone: string; memo: string }; setForm: (f: { name: string; phone: string; memo: string }) => void; onSubmit: () => void; label: string }) {
  const ok = form.name.trim().length > 0 && form.phone.replace(/\D/g, '').length >= 10;
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (ok) onSubmit(); }}>
      <div className="field"><label>이름</label><input className="input" autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
      <div className="field"><label>휴대폰 번호 (키오스크 결제와 자동으로 맞춰요)</label><input className="input" inputMode="tel" placeholder="010-0000-0000" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></div>
      <div className="field"><label>메모</label><input className="input" value={form.memo} onChange={(e) => setForm({ ...form, memo: e.target.value })} /></div>
      <button className="btn primary wide" type="submit" disabled={!ok}>{label}</button>
    </form>
  );
}
