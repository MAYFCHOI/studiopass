import { useEffect, useMemo, useRef, useState } from 'react';
import dayjs from 'dayjs';
import { Html5Qrcode } from 'html5-qrcode';
import { useStore, type ScanResult } from '../store';
import type { Tab } from '../App';
import { parseQr } from '../lib/util';

export default function Scan({ go }: { go: (t: Tab, arg?: string) => void }) {
  const s = useStore();
  const wd = dayjs().day();
  const todays = useMemo(() => s.courses.filter((c) => c.weekday.includes(wd)).sort((a, b) => a.startTime.localeCompare(b.startTime)), [s.courses, wd]);
  const nowMin = dayjs().hour() * 60 + dayjs().minute();
  const nearest = todays.reduce<string | undefined>((best, c) => {
    const m = Number(c.startTime.slice(0, 2)) * 60 + Number(c.startTime.slice(3));
    if (!best) return c.id;
    const bm = (() => { const b = todays.find((x) => x.id === best)!; return Number(b.startTime.slice(0, 2)) * 60 + Number(b.startTime.slice(3)); })();
    return Math.abs(m - nowMin) < Math.abs(bm - nowMin) ? c.id : best;
  }, undefined);
  const [courseId, setCourseId] = useState<string | undefined>(nearest);
  const [showAll, setShowAll] = useState(false);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [camErr, setCamErr] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const scanner = useRef<Html5Qrcode | null>(null);
  const busy = useRef(false);
  const list = showAll ? s.courses : todays;

  const handle = (memberId: string) => {
    if (busy.current) return;
    busy.current = true;
    if (!courseId) { setResult({ ok: false, reason: '먼저 수업을 선택해 주세요' }); return; }
    const r = s.attend(memberId, courseId);
    setResult(r);
    if (navigator.vibrate) navigator.vibrate(r.ok ? 40 : [60, 40, 60]);
  };

  useEffect(() => {
    if (result) return; // paused while spotlight shows
    let stopped = false;
    const el = document.getElementById('reader');
    if (!el) return;
    const inst = new Html5Qrcode('reader', { verbose: false });
    scanner.current = inst;
    inst.start({ facingMode: 'environment' }, { fps: 8, qrbox: (w, h) => { const m = Math.min(w, h) * 0.62; return { width: m, height: m }; } },
      (text) => { const id = parseQr(text); if (id) handle(id); else { busy.current = true; setResult({ ok: false, reason: '이 스튜디오의 QR 이 아니에요' }); } },
      () => {})
      .catch((e) => { if (!stopped) setCamErr(String(e?.message ?? e)); });
    return () => { stopped = true; inst.stop().catch(() => {}).finally(() => { try { inst.clear(); } catch { /* noop */ } }); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, courseId]);

  const found = q.trim() ? s.members.filter((m) => m.name.includes(q.trim()) || m.phone.includes(q.replace(/\D/g, '')) || m.memberNo.includes(q.trim())).slice(0, 6) : [];
  const course = s.courses.find((c) => c.id === courseId);
  const ins = (id?: string) => s.instructors.find((i) => i.id === id)?.name;

  return (
    <>
      <h1><small>{course ? `${course.name} · ${ins(course.instructorId)}` : '수업을 선택하세요'}</small>출석 체크</h1>
      <div className="strip">
        {list.map((c) => (
          <button key={c.id} className="slot" aria-pressed={c.id === courseId} onClick={() => setCourseId(c.id)}>
            <div className="time">{c.startTime}{!c.weekday.includes(wd) && ' · 오늘 수업 아님'}</div>
            <div className="n">{c.name}</div>
            <div className="i">{ins(c.instructorId)}</div>
          </button>
        ))}
        <button className="slot" onClick={() => setShowAll((v) => !v)} style={{ minWidth: 110 }}><div className="time">&nbsp;</div><div className="n">{showAll ? '오늘만' : '전체 수업'}</div><div className="i">&nbsp;</div></button>
      </div>

      <div className="scan-wrap">
        {camErr ? (
          <div className="empty" style={{ padding: 60 }}><b>카메라를 열 수 없어요</b>{camErr.includes('Permission') || camErr.includes('NotAllowed') ? '브라우저 설정에서 카메라를 허용해 주세요.' : 'HTTPS 주소에서 열었는지 확인해 주세요.'}<br />아래에서 이름으로 찾아 출석할 수 있어요.</div>
        ) : (<>
          <div id="reader" />
          <div className="scan-frame"><div /></div>
          <div className="scan-hint">회원 QR 을 네모 안에 맞춰 주세요</div>
        </>)}
      </div>

      <h2>이름으로 출석</h2>
      <input className="input" placeholder="이름, 전화번호 뒷자리, 회원번호" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="list">
        {found.map((m) => (
          <button className="row" key={m.id} onClick={() => { setQ(''); handle(m.id); }}>
            <div className="avatar">{m.name.slice(-2)}</div>
            <div className="main"><div className="t">{m.name}</div><div className="d">{m.memberNo} · {s.activePasses(m.id).map((p) => (p.kind === 'PERIOD' ? `전문반 ${p.remaining}` : `${s.courses.find((c) => c.id === p.courseId)?.name} ${p.remaining}`)).join(', ') || '수강권 없음'}</div></div>
            <span className="chip">출석</span>
          </button>
        ))}
      </div>

      {result && (
        <div className={'spot' + (result.ok ? '' : ' bad')} role="alertdialog" onClick={() => { setResult(null); busy.current = false; }}>
          <div className="kicker">{result.ok ? `${dayjs(result.attendance.attendedAt).format('HH:mm')} · ${result.course.name}` : '출석 안 됨'}</div>
          <p className="who">{result.ok ? result.member.name : result.member?.name ?? '확인 필요'}</p>
          <p className="what">{result.ok ? '출석 완료' : result.reason}</p>
          <p className="left">{result.ok ? (<>{result.pass.kind === 'PERIOD' ? '전문반 자유수강 ' : ''}남은 횟수 <b className="num">{result.pass.remaining}</b> / {result.pass.totalCount} · {dayjs(result.pass.validTo).format('M/D')}까지</>) : (result.member ? <button className="chip" onClick={(e) => { e.stopPropagation(); go('members', result.member!.id); }}>회원 정보 보기</button> : ' ')}</p>
          <button className="ok" onClick={() => { setResult(null); busy.current = false; }}>다음 사람</button>
        </div>
      )}
    </>
  );
}
