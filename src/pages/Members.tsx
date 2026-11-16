import { useEffect, useRef, useState } from 'react';
import dayjs from 'dayjs';
import QRCode from 'qrcode';
import { useStore } from '../store';
import type { Tab } from '../App';
import { fmtPhone, qrPayload, maybeWon } from '../lib/util';
import { Sheet } from '../components/Sheet';
import { Icon } from '../components/Icon';
import { passName, courseTitle } from '../lib/labels';
import logoMark from '../assets/logo-mark-white.png';
import { toast } from '../components/Toast';
import { IS_DEMO } from '../lib/mode';
import { matchMember, samePhoneMembers } from '../lib/search';
import { useBusy, newRequestKey } from '../lib/useBusy';
import type { MemberHistory } from '../types';

/** 화면 목록(최근 62일)과 서버 전체 기록을 id 로 합친다. 같은 id 는 화면 쪽(더 최신)을 쓴다. */
function merge<T extends { id: string }>(recent: T[], all?: T[]): T[] {
  if (!all) return recent;
  const ids = new Set(recent.map((x) => x.id));
  return [...recent, ...all.filter((x) => !ids.has(x.id))];
}

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
  const [erasing, setErasing] = useState(false);
  const [eraseBusy, setEraseBusy] = useState(false);
  const [busy, run] = useBusy();
  const [formKey, setFormKey] = useState(newRequestKey); // 새 회원 폼마다 하나(두 번 눌러도 회원은 한 명)
  const [history, setHistory] = useState<{ id: string; h: MemberHistory | null } | null>(null);
  const [showAllFor, setShowAllFor] = useState<string | null>(null); // 출석 기록 전부 보기(회원별)
  const [ext, setExt] = useState<{ passId: string; days: number } | null>(null); // 유효기간 연장 중인 수강권
  const [extBusy, setExtBusy] = useState(false);
  const [qrUrl, setQrUrl] = useState<string | null>(null); // 화면에 띄운 회원 페이지 링크 QR
  const [qrBusy, setQrBusy] = useState(false);
  const [bf, setBf] = useState<{ date: string; courseId: string; passId: string } | null>(null); // 지난 출석 넣기
  const [adj, setAdj] = useState<{ passId: string; remaining: number } | null>(null); // 남은 횟수 맞추는 중인 수강권
  const memberHistory = s.memberHistory;
  useEffect(() => {
    if (!memberId) return;
    let live = true;
    memberHistory(memberId).then((h) => { if (live) setHistory({ id: memberId, h }); }, () => { if (live) setHistory({ id: memberId, h: null }); });
    return () => { live = false; };
  }, [memberId, memberHistory]);

  if (memberId) {
    const m = s.members.find((x) => x.id === memberId);
    if (!m) return <div className="empty"><b>회원을 찾을 수 없어요</b><button className="btn sm" onClick={() => go('members')}>목록으로</button></div>;
    const loaded = history?.id === m.id; const h = loaded ? history.h ?? undefined : undefined; // 서버 전체 기록(62일 밖 포함), 받기 전에는 화면 목록만
    const passes = merge(s.passes.filter((p) => p.memberId === m.id), h?.passes).sort((a, b) => b.validFrom.localeCompare(a.validFrom));
    const att = merge(s.attendances.filter((a) => a.memberId === m.id), h?.attendances).sort((a, b) => b.attendedAt.localeCompare(a.attendedAt));
    const pays = merge(s.payments.filter((p) => p.memberId === m.id), h?.payments).sort((a, b) => b.paidAt.localeCompare(a.paidAt));
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
    const sendLink = () => run(async () => {
      const url = await s.issueLink(m.id).catch(() => null);
      if (!url) { toast('링크를 만들지 못했어요. 다시 시도해 주세요'); return; }
      const text = '[THE DEPTH] ' + m.name + '님 회원 페이지예요. 출석할 때 이 화면의 QR 을 보여주세요.\n' + url;
      if (/Android|iPhone/i.test(navigator.userAgent)) {
        await s.recordMessage(m.id).catch(() => {});
        // iOS 메시지 앱은 '&body=' 를, 안드로이드는 '?body=' 를 읽는다
        window.location.assign('sms:' + m.phone + (/iPhone|iPad|iPod/i.test(navigator.userAgent) ? '&' : '?') + 'body=' + encodeURIComponent(text));
        return;
      }
      const copied = await navigator.clipboard?.writeText(text).then(() => true, () => false);
      await s.recordMessage(m.id).catch(() => {});
      // 데스크 맥: 학원 아이폰의 '문자 메시지 전달'로 맥 메시지 앱에서 보낸다. 본문이 안 채워지는 버전이 있어 클립보드에도 넣어 둔다.
      if (/Macintosh/i.test(navigator.userAgent)) {
        toast(copied ? '메시지 앱을 열어요. 본문이 비어 있으면 ⌘V 로 붙여 넣어 주세요' : '메시지 앱을 열어요');
        window.location.assign('sms:' + m.phone + '&body=' + encodeURIComponent(text));
        if (!copied) window.prompt('본문이 비어 있으면 아래 내용을 복사해 붙여 넣어 주세요', text);
        return;
      }
      if (!copied) { window.prompt('아래 내용을 복사해 문자로 보내 주세요', text); } else toast('링크를 복사했어요');
    });
    const sendTalk = async () => {
      if (talkBusy) return;
      setTalkBusy(true);
      const r = await s.sendAlimtalkLink(m.id).catch(() => null);
      setTalkBusy(false);
      if (r?.ok) toast('알림톡으로 링크를 보냈어요');
      else if (r?.error === 'NO_PHONE') toast('전화번호가 없어서 보낼 수 없어요');
      else toast('알림톡을 보내지 못했어요. 링크 문자로 보내 주세요');
    };
    // 데스크 화면에 회원 페이지 링크를 QR 로 띄운다. 회원이 자기 폰 카메라로 찍으면 열린다(문자 없음, 번호 안 보임)
    const showQr = async () => {
      if (qrBusy) return;
      setQrBusy(true);
      const url = await s.issueLink(m.id).catch(() => null);
      setQrBusy(false);
      if (!url) { toast('링크를 만들지 못했어요. 다시 시도해 주세요'); return; }
      setQrUrl(url);
    };
    const minDay = dayjs().subtract(62, 'day').format('YYYY-MM-DD');
    const bfCourses = bf ? s.courses.filter((c) => c.weekday.includes(dayjs(bf.date).day())).sort((a, b) => a.startTime.localeCompare(b.startTime)) : [];
    const bfPasses = passes.filter((p) => p.remaining > 0 || (p.adjustedUsed ?? 0) > 0);
    const openBf = () => { const date = t; const c = s.courses.filter((x) => x.active !== false && x.weekday.includes(dayjs(date).day()))[0]; setBf({ date, courseId: c?.id ?? '', passId: bfPasses[0]?.id ?? '' }); };
    const saveBf = async () => {
      if (!bf || !bf.courseId || !bf.passId || extBusy) return;
      setExtBusy(true);
      try {
        const r = await s.backfillAttendance({ memberId: m.id, ...bf });
        if (r.ok) { toast(`${dayjs(bf.date).format('M/D')} 출석을 넣었어요`); setBf(null); }
        else toast({ ALREADY: '그날 그 수업은 이미 출석이 있어요', EMPTY: '이 수강권은 남은 횟수가 없어요', WRONG_DAY: '그 수업 요일이 아니에요', NOT_FOR_COURSE: '이 수강권으로는 그 수업을 들을 수 없어요', BAD_DATE: '최근 62일 안의 지난 날짜만 넣을 수 있어요' }[r.error] ?? '넣지 못했어요. 다시 시도해 주세요');
      } catch { /* 안내는 스토어가 띄운다 */ } finally { setExtBusy(false); }
    };
    const erase = async () => {
      if (eraseBusy) return;
      setEraseBusy(true);
      await s.eraseMember(m.id).then(() => { setErasing(false); toast('회원 정보를 삭제했어요'); }, () => {});
      setEraseBusy(false);
    };
    const owner = s.me?.role === 'OWNER';
    return (
      <>
        <button className="btn sm ghost" style={{ marginTop: 14 }} onClick={() => go('members')}><Icon name="back" size={16} />회원 목록</button>
        {m.erased && <div className="notice" role="note" style={{ marginTop: 12 }}>개인정보를 삭제한 회원이에요. 출석·결제 기록만 정산용으로 남아 있고, 이 회원으로는 출석할 수 없어요.</div>}
        <div className="pass">
          <div className="band"><img className="band-mark" src={logoMark} alt="" /><span>THE DEPTH<small>DANCE STUDIO</small></span><span className="no">{m.memberNo}</span></div>
          <div className="body">
            <div><div className="name">{m.name}</div><div className="phone">{fmtPhone(m.phone)}</div><div className="phone">{dayjs(m.createdAt).format('YYYY.M.D')} 등록</div></div>
            {IS_DEMO && <QR text={qrPayload(m.id)} />}
          </div>
          <div className="perf"><span>{IS_DEMO ? '이 QR 을 카메라에 보여주면 출석돼요' : '회원 페이지의 QR 을 카메라에 보여주면 출석돼요'}</span><span>{s.activePasses(m.id).reduce((n, p) => n + p.remaining, 0)}회 남음</span></div>
        </div>
        {!m.erased && <div className="btn-row">
          {IS_DEMO ? <button className="btn primary wide" onClick={share}>QR 보내기</button>
            : <button className="btn primary wide" disabled={qrBusy} onClick={() => { void showQr(); }}>{qrBusy ? '링크 만드는 중…' : '화면에 QR 띄우기'}</button>}
          <button className="btn wide" onClick={() => { setForm({ name: m.name, phone: fmtPhone(m.phone), memo: m.memo ?? '' }); setAdding(true); }}>정보 수정</button>
        </div>}
        {!m.erased && !IS_DEMO && (
          <div className="btn-row" style={{ marginTop: 8 }}>
            {s.alimtalkEnabled && <button className="btn sm ghost" disabled={talkBusy} onClick={() => { void sendTalk(); }}>{talkBusy ? '보내는 중…' : '알림톡으로 보내기'}</button>}
            <button className="btn sm ghost" disabled={busy} onClick={() => { void sendLink(); }}>{busy ? '링크 만드는 중…' : '링크 문자 보내기'}</button>
          </div>
        )}
        {qrUrl && (
          <Sheet onClose={() => setQrUrl(null)} title={`${m.name}님 회원 페이지`}>
            <div className="link-qr"><QR text={qrUrl} /></div>
            <p className="sub" style={{ textAlign: 'center' }}>회원 휴대폰 카메라로 이 QR 을 비추면 회원 페이지가 열려요. 열린 페이지를 홈 화면에 추가해 두면 다음부터 바로 열 수 있어요.</p>
          </Sheet>
        )}
        {!m.erased && m.tier && (s.tiers?.length ?? 0) > 0 && (
          <div className="tier-row">
            <div className="main"><div className="t">등급 {m.tier.name}</div><div className="d">출석 {m.tier.count}회{m.tier.manual ? ' · 원장이 올린 등급' : m.tierFloor ? ` · 원장이 ${s.tiers?.[m.tierFloor - 1]?.name ?? ''} 이상으로 정함` : ''}</div></div>
            {owner && (
              <select className="input" aria-label="등급 직접 정하기" value={m.tierFloor ?? ''} onChange={(e) => { const v = e.target.value ? Number(e.target.value) : null; void s.setMemberTier(m.id, v).then(() => toast(v ? '등급을 정했어요' : '출석 기준으로 돌렸어요'), () => {}); }}>
                <option value="">출석 기준</option>
                {(s.tiers ?? []).map((t, i) => i > 0 && <option key={t.name} value={i + 1}>{t.name} 이상</option>)}
              </select>
            )}
          </div>
        )}

        <h2>수강권</h2>
        {passes.length === 0 ? <p className="sub">아직 수강권이 없어요. 결제가 들어오면 자동으로 생겨요.</p> : (
          <div className="list">
            {passes.map((p) => {
              const expired = p.validTo < t; const done = p.remaining <= 0;
              const open = ext?.passId === p.id;
              const adjOpen = adj?.passId === p.id;
              const adjMax = p.remaining + (p.adjustedUsed ?? 0); // 앱 출석을 빼고 남길 수 있는 최대
              const adjust = async () => {
                if (!adj || extBusy) return;
                setExtBusy(true);
                try {
                  const r = await s.adjustPass(p.id, adj.remaining);
                  if (r.ok) { toast(`남은 횟수를 ${adj.remaining}회로 맞췄어요`); setAdj(null); }
                  else toast(r.error === 'TOO_MANY' ? '앱에서 출석한 횟수보다 많이 남길 수 없어요' : '맞추지 못했어요. 다시 시도해 주세요');
                } catch { /* 안내는 스토어가 띄운다 */ } finally { setExtBusy(false); }
              };
              const extend = async () => {
                if (!ext || extBusy) return;
                setExtBusy(true);
                try {
                  const r = await s.extendPass(p.id, ext.days);
                  if (r.ok) { toast(`유효기간을 ${ext.days}일 늘렸어요 (${dayjs(p.validTo).add(ext.days, 'day').format('M/D')}까지)`); setExt(null); }
                  else toast(r.error === 'ALREADY_EXTENDED' ? '이 수강권은 이미 한 번 연장했어요' : '연장하지 못했어요. 다시 시도해 주세요');
                } catch { /* 안내는 스토어가 띄운다 */ } finally { setExtBusy(false); }
              };
              return (
                <div className="pass-item" key={p.id}>
                  <div className="row">
                    <div className="main"><div className="t">{passName(s, p)} {p.kind === 'PERIOD' && <span className="chip pro">월정액</span>}</div><div className="d">{dayjs(p.validFrom).format('M/D')} ~ {dayjs(p.validTo).format('M/D')} {maybeWon(p.price, ' · ')}{p.extendedDays ? ` · ${p.extendedDays}일 연장함` : ''}{p.adjustedUsed ? ` · 앱 전 ${p.adjustedUsed}회 사용` : ''}{expired ? ' · 기간 만료' : done ? ' · 소진' : ''}</div></div>
                    <div className="right inline"><b className="num">{p.remaining}</b> / {p.totalCount}</div>
                  </div>
                  {!m.erased && !open && !adjOpen && (!done || !!p.adjustedUsed) && (
                    <div className="pass-actions">
                      {p.kind === 'COUNT' && <button className="btn sm ghost" onClick={() => { setExt(null); setAdj({ passId: p.id, remaining: p.remaining }); }}>횟수 맞추기</button>}
                      {!done && !p.extendedDays && <button className="btn sm ghost" onClick={() => { setAdj(null); setExt({ passId: p.id, days: 7 }); }}>기간 연장</button>}
                      {!done && !!p.extendedDays && owner && <button className="btn sm ghost" onClick={() => { void s.undoExtendPass(p.id).then(() => toast('연장을 되돌렸어요'), () => {}); }}>연장 되돌리기</button>}
                    </div>
                  )}
                  {adjOpen && (
                    <div className="pass-extend">
                      <label className="sub">지금 남은 횟수 <input className="input" inputMode="numeric" value={adj.remaining} onChange={(e) => setAdj({ passId: p.id, remaining: Math.min(adjMax, Number(e.target.value.replace(/\D/g, '')) || 0) })} style={{ width: 80, display: 'inline-block', marginLeft: 6 }} /> / {p.totalCount}회</label>
                      <p className="sub" style={{ margin: 0 }}>{adjMax - adj.remaining > 0 ? <>앱을 쓰기 전에 <b>{adjMax - adj.remaining}회</b> 쓴 걸로 맞춰요. </> : ''}출석 기록은 생기지 않아서 강사 정산과 등급은 바뀌지 않아요.</p>
                      <div className="pass-actions">
                        <button className="btn sm" onClick={() => setAdj(null)}>닫기</button>
                        <button className="btn sm primary" disabled={extBusy || adj.remaining === p.remaining} onClick={() => { void adjust(); }}>{adj.remaining}회 남기기</button>
                      </div>
                    </div>
                  )}
                  {open && (
                    <div className="pass-extend">
                      <div className="seg">{[7, 14, 30].map((n) => <button key={n} aria-pressed={ext.days === n} onClick={() => setExt({ passId: p.id, days: n })}>{n}일</button>)}</div>
                      <label className="sub">직접 입력(일) <input className="input" inputMode="numeric" value={ext.days} onChange={(e) => setExt({ passId: p.id, days: Math.min(90, Number(e.target.value.replace(/\D/g, '')) || 0) })} style={{ width: 80, display: 'inline-block', marginLeft: 6 }} /></label>
                      <p className="sub" style={{ margin: 0 }}>{dayjs(p.validTo).format('M/D')} → <b>{dayjs(p.validTo).add(ext.days, 'day').format('M/D')}</b>까지. 수강권마다 한 번만 연장할 수 있어요.</p>
                      <div className="pass-actions">
                        <button className="btn sm" onClick={() => setExt(null)}>닫기</button>
                        <button className="btn sm primary" disabled={extBusy || ext.days < 1} onClick={() => { void extend(); }}>{ext.days}일 연장</button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <h2>출석 기록</h2>
        {!m.erased && !bf && bfPasses.length > 0 && <button className="btn sm ghost" onClick={openBf}>지난 출석 넣기</button>}
        {bf && (
          <div className="pass-extend">
            <label className="sub">날짜 <input className="input" type="date" min={minDay} max={t} value={bf.date} onChange={(e) => { const date = e.target.value || t; const c = s.courses.filter((x) => x.active !== false && x.weekday.includes(dayjs(date).day()))[0]; setBf({ ...bf, date, courseId: c?.id ?? '' }); }} style={{ display: 'inline-block', width: 'auto', marginLeft: 6 }} /></label>
            <select className="input" aria-label="수업" value={bf.courseId} onChange={(e) => setBf({ ...bf, courseId: e.target.value })}>
              {bfCourses.length === 0 && <option value="">그 요일 수업이 없어요</option>}
              {bfCourses.map((c) => <option key={c.id} value={c.id}>{c.startTime} {courseTitle(s, c)}{c.active === false ? ' (쉬는 수업)' : ''}</option>)}
            </select>
            <select className="input" aria-label="수강권" value={bf.passId} onChange={(e) => setBf({ ...bf, passId: e.target.value })}>
              {bfPasses.map((p) => <option key={p.id} value={p.id}>{passName(s, p)} · {p.adjustedUsed ? `앱 전 사용 ${p.adjustedUsed}회에서` : `남은 ${p.remaining}회에서`}</option>)}
            </select>
            <p className="sub" style={{ margin: 0 }}>{dayjs(bf.date).format('M/D')} 그 수업 강사 정산에 1명으로 들어가요.{(() => { const p = bfPasses.find((x) => x.id === bf.passId); return p?.adjustedUsed ? ' 앱 전 사용 횟수에서 바꾸니 남은 횟수는 그대로예요.' : ' 남은 횟수가 1 줄어요.'; })()}{bf.date.slice(0, 7) < t.slice(0, 7) ? ' 지난달 정산 숫자가 바뀌어요.' : ''}</p>
            <div className="pass-actions">
              <button className="btn sm" onClick={() => setBf(null)}>닫기</button>
              <button className="btn sm primary" disabled={extBusy || !bf.courseId || !bf.passId} onClick={() => { void saveBf(); }}>출석 넣기</button>
            </div>
          </div>
        )}
        {att.length === 0 ? <p className="sub">출석 기록이 없어요.</p> : (
          <div className="list">
            {(showAllFor === m.id ? att : att.slice(0, 30)).map((a) => (
              <div className="row" key={a.id} style={a.cancelledAt ? { opacity: .4 } : undefined}>
                <div className="main"><div className="t">{course(a.courseId)}</div><div className="d">{dayjs(a.attendedAt).format('M/D (dd) HH:mm')} · {s.courses.find((c) => c.id === a.courseId)?.hall}{s.passes.find((p) => p.id === a.passId)?.kind === 'PERIOD' && ' · 월정액'}{a.backfilled && ' · 지난 출석으로 넣음'}{a.cancelledAt && ' · 취소됨'}</div></div>
                {!a.cancelledAt && <button className="btn sm ghost" onClick={() => { if (confirm('이 출석을 취소하고 횟수를 되돌릴까요?')) { s.cancelAttendance(a.id).then(() => toast('출석을 취소했어요'), () => {}); } }}>취소</button>}
              </div>
            ))}
          </div>
        )}

        {att.length > 30 && showAllFor !== m.id && <button className="btn sm ghost" style={{ marginTop: 8 }} onClick={() => setShowAllFor(m.id)}>더 보기 (전체 {att.length}건)</button>}
        {!h && !IS_DEMO && <p className="sub">{loaded ? '최근 62일 기록만 보여요. 전체 기록을 불러오지 못했어요.' : '최근 62일 기록이에요. 전체 기록을 불러오는 중…'}</p>}

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

        {owner && !m.erased && (
          <>
            <h2>개인정보</h2>
            {!erasing ? (
              <button className="btn sm ghost" onClick={() => setErasing(true)}>회원 정보 삭제</button>
            ) : (
              <div className="notice" role="alertdialog" aria-label="회원 정보 삭제 확인">
                <b>{m.name} 회원의 정보를 지울까요?</b>
                <p style={{ margin: '6px 0 0' }}>이름·전화번호·메모, 회원 페이지 링크, 이 회원 결제의 결제자 이름·전화가 지워지고 되돌릴 수 없어요. 출석 기록과 수강권, 결제 금액은 정산을 위해 남으니 정산 숫자는 바뀌지 않아요. 지운 뒤에는 이 회원으로 출석할 수 없어요.</p>
                <div className="btn-row">
                  <button className="btn wide" disabled={eraseBusy} onClick={() => setErasing(false)}>그만두기</button>
                  <button className="btn primary wide" disabled={eraseBusy} onClick={() => { void erase(); }}>{eraseBusy ? '지우는 중…' : '삭제하기'}</button>
                </div>
              </div>
            )}
          </>
        )}

        {adding && (
          <Sheet onClose={() => setAdding(false)} title="회원 정보 수정">
            <MemberForm form={form} setForm={setForm} busy={busy} others={samePhoneMembers(s.members, form.phone, m.id).length} onSubmit={() => { void run(() => s.updateMember(m.id, form).then(() => { setAdding(false); toast('저장했어요'); })); }} label="저장" />
          </Sheet>
        )}
      </>
    );
  }

  const qq = q.trim();
  const live = s.members.filter((m) => !m.erased);
  const list = live.filter((m) => matchMember(m, qq)).sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  return (
    <>
      <h1><small>{live.length}명</small>회원</h1>
      <div className="search"><input className="input" placeholder="이름, 전화번호, 회원번호" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      <div className="list cols">
        {list.map((m) => {
          const ap = s.activePasses(m.id); const left = ap.reduce((n, p) => n + p.remaining, 0);
          const last = s.attendances.filter((a) => a.memberId === m.id && !a.cancelledAt).sort((a, b) => b.attendedAt.localeCompare(a.attendedAt))[0];
          return (
            <button className="row" key={m.id} onClick={() => go('members', m.id)}>
              <div className="avatar">{m.name.slice(-2)}</div>
              <div className="main"><div className="t">{m.name} {ap.some((p) => p.kind === 'PERIOD') && <span className="chip pro">전문반</span>}</div><div className="d">{last ? `마지막 출석 ${dayjs(last.attendedAt).format('M/D')}` : '출석 기록 없음'} · {fmtPhone(m.phone)}</div></div>
              <div className="right inline">{ap.length ? <><b className="num">{left}</b>회 남음</> : <span className="chip danger">수강권 없음</span>}</div>
            </button>
          );
        })}
        {list.length === 0 && (qq
          ? <div className="empty"><b>검색 결과가 없어요</b>이름, 전화번호 뒷자리, 회원번호로 찾아 보세요</div>
          : <div className="empty"><b>아직 회원이 없어요</b>새 회원 버튼으로 첫 회원을 등록해 주세요</div>)}
      </div>
      <div style={{ height: 70 }} />
      <button className="btn primary fab" onClick={() => { setForm({ name: '', phone: '', memo: '' }); setFormKey(newRequestKey()); setAdding(true); }}><Icon name="plus" />새 회원</button>
      {adding && (
        <Sheet onClose={() => setAdding(false)} title="새 회원 등록">
          <MemberForm form={form} setForm={setForm} busy={busy} others={samePhoneMembers(s.members, form.phone).length} onSubmit={() => { void run(() => s.addMember(form, { idempotencyKey: formKey }).then((m) => { setAdding(false); toast(`${m.name} 등록, QR 이 발급됐어요`); go('members', m.id); })); }} label="등록하고 QR 만들기" />
        </Sheet>
      )}
    </>
  );
}

function MemberForm({ form, setForm, onSubmit, label, busy, others }: { form: { name: string; phone: string; memo: string }; setForm: (f: { name: string; phone: string; memo: string }) => void; onSubmit: () => void; label: string; busy: boolean; others: number }) {
  const ok = form.name.trim().length > 0 && form.phone.replace(/\D/g, '').length >= 10;
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (ok && !busy) onSubmit(); }}>
      <div className="field"><label>이름</label><input className="input" autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
      <div className="field"><label>휴대폰 번호 (키오스크 결제와 자동으로 맞춰요)</label><input className="input" inputMode="tel" placeholder="010-0000-0000" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />{others > 0 && <span className="hint" role="note">같은 번호 회원 {others}명이 있어요. 같은 번호를 두 명이 쓰면 키오스크 결제가 자동으로 연결되지 않아요</span>}</div>
      <div className="field"><label>메모</label><input className="input" value={form.memo} onChange={(e) => setForm({ ...form, memo: e.target.value })} /><span className="hint">건강·종교 같은 민감한 정보는 적지 마세요</span></div>
      <button className="btn primary wide" type="submit" disabled={!ok || busy}>{busy ? '저장 중…' : label}</button>
    </form>
  );
}
