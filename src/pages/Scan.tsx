import { useEffect, useMemo, useRef, useState } from 'react';
import dayjs from 'dayjs';
import { Html5Qrcode } from 'html5-qrcode';
import { useStore, type ScanResult } from '../store';
import type { Tab } from '../App';
import { reasonText } from '../lib/reasons';
import { IS_DEMO } from '../lib/mode';
import { useOnline } from '../lib/useOnline';
import { ClassCard } from '../components/ClassCard';
import { courseTitle, courseMeta, passName } from '../lib/labels';

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
  const [showAll, setShowAll] = useState(todays.length === 0);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [camErr, setCamErr] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const scanner = useRef<Html5Qrcode | null>(null);
  const busy = useRef(false);
  const list = showAll ? s.courses : todays;
  // 서버 모드에서 끊겼으면 카메라 결과를 처리하지 않는다(카메라 콜백이 최신 값을 보도록 ref).
  const offline = !useOnline() && !IS_DEMO;
  const offlineRef = useRef(offline);
  offlineRef.current = offline;

  // 카메라는 QR 글자를 그대로, 이름 검색은 회원 id 로 보낸다. 판정은 store(데모: AM1 해석, 서버: AM2 서명 확인).
  const handle = (input: { qr?: string; memberId?: string }) => {
    if (busy.current) return;
    busy.current = true;
    if (!courseId) { setResult({ ok: false, reason: 'NO_COURSE' }); return; }
    s.attend({ ...input, courseId }).then((r) => {
      setResult(r);
      if (navigator.vibrate) navigator.vibrate(r.ok ? 40 : [60, 40, 60]);
    });
  };

  const [cams, setCams] = useState<{ id: string; label: string }[]>([]);
  const [camIdx, setCamIdx] = useState(0);
  useEffect(() => {
    if (result) return; // paused while spotlight shows
    let stopped = false;
    const el = document.getElementById('reader');
    if (!el) return;
    const inst = new Html5Qrcode('reader', { verbose: false });
    scanner.current = inst;
    const startP = (async () => {
      // 카메라 목록을 먼저 받는다(권한 요청 겸). 후면 카메라가 있으면 facingMode, 없으면(노트북) 첫 카메라 id 로.
      let list = cams;
      if (list.length === 0) {
        list = await Html5Qrcode.getCameras(); setCams(list);
      }
      if (stopped) return;
      if (list.length === 0) throw new Error('NoCamera');
      const hasBack = list.some((c) => /back|rear|environment|후면/i.test(c.label));
      const target = hasBack && camIdx === 0 ? { facingMode: 'environment' as const } : list[camIdx % list.length].id;
      await inst.start(target, { fps: 8, qrbox: (w, h) => { const m = Math.min(w, h) * 0.62; return { width: m, height: m }; } },
        (text) => {
          if (!offlineRef.current) { handle({ qr: text }); return; }
          if (busy.current) return;
          busy.current = true;
          setResult({ ok: false, reason: 'OFFLINE' });
        },
        () => {});
    })().catch((e) => { if (!stopped) setCamErr(String(e?.message ?? e)); });
    // 정리: stop() 은 카메라가 아직 켜지는 중이거나 실패한 상태면 동기 예외를 던진다.
    // 언마운트 중 예외가 나면 React 가 앱 전체를 내리므로(검은 화면), start 가 끝난 뒤 상태를 보고 안전하게 끈다.
    const shutdown = () => {
      try {
        const clear = () => { try { inst.clear(); } catch { /* noop */ } };
        if (inst.isScanning) inst.stop().catch(() => {}).finally(clear); else clear();
      } catch { /* noop */ }
    };
    return () => { stopped = true; startP.then(shutdown, shutdown); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, courseId, camIdx]);

  const found = q.trim() ? s.members.filter((m) => m.name.includes(q.trim()) || m.phone.includes(q.replace(/\D/g, '')) || m.memberNo.includes(q.trim())).slice(0, 6) : [];
  const course = s.courses.find((c) => c.id === courseId);

  return (
    <>
      <h1><small>{course ? `${courseTitle(s, course)} · ${courseMeta(course)}` : '수업을 선택하세요'}</small>출석 체크</h1>
      <div className="strip">
        {list.map((c) => (
          <ClassCard key={c.id} c={c} dim={c.weekday.includes(wd) ? c.hall : '일월화수목금토'[c.weekday[0]]} pressed={c.id === courseId} onClick={() => setCourseId(c.id)} />
        ))}
        <button className="cc more" onClick={() => setShowAll((v) => !v)}>{showAll ? '오늘 수업만' : '전체 수업 보기'}</button>
      </div>

      <div className="scan-wrap">
        {camErr ? (
          <div className="empty" style={{ padding: 60 }}><b>카메라를 열 수 없어요</b>{/Permission|NotAllowed|denied/i.test(camErr) ? '브라우저 주소창의 카메라 권한을 허용하고 다시 열어 주세요.' : /NoCamera|NotFound/i.test(camErr) ? '이 기기에 카메라가 없어요.' : /NotReadable|in use/i.test(camErr) ? '다른 앱이 카메라를 쓰고 있어요. 닫고 다시 시도해 주세요.' : 'HTTPS 주소에서 열었는지 확인해 주세요.'}<br />아래에서 이름으로 찾아 출석할 수 있어요.<div style={{ marginTop: 14 }}><button className="btn sm" onClick={() => { setCamErr(null); setCams([]); }}>다시 시도</button></div></div>
        ) : (<>
          <div id="reader" />
          <div className="scan-frame"><div /></div>
          <div className="scan-hint">회원 QR 을 네모 안에 맞춰 주세요</div>
          {cams.length > 1 && <button className="btn sm" style={{ position: 'absolute', top: 12, right: 12, background: 'rgba(0,0,0,.6)' }} onClick={() => setCamIdx((i) => i + 1)}>카메라 전환</button>}
        </>)}
      </div>

      <h2>이름으로 출석</h2>
      <input className="input" placeholder="이름, 전화번호 뒷자리, 회원번호" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="list">
        {found.map((m) => (
          <button className="row" key={m.id} onClick={() => { setQ(''); handle({ memberId: m.id }); }}>
            <div className="avatar">{m.name.slice(-2)}</div>
            <div className="main"><div className="t">{m.name}</div><div className="d">{m.memberNo} · {s.activePasses(m.id).map((p) => `${passName(s, p)} ${p.remaining}`).join(', ') || '수강권 없음'}</div></div>
            <span className="chip">출석</span>
          </button>
        ))}
      </div>

      {result && (
        <div className={'spot' + (result.ok ? '' : ' bad')} role="alertdialog" onClick={() => { setResult(null); busy.current = false; }}>
          <div className="kicker">{result.ok ? `${dayjs(result.attendedAt).format('HH:mm')} · ${courseTitle(s, result.course)}` : '출석 안 됨'}</div>
          <p className="who">{result.ok ? result.member.name : result.member?.name ?? '확인 필요'}</p>
          <p className="what">{result.ok ? '출석 완료' : reasonText(result.reason)}</p>
          <p className="left">{result.ok ? (<>{passName(s, result.pass)} · 남은 횟수 <b className="num">{result.pass.remaining}</b> / {result.pass.totalCount} · {dayjs(result.pass.validTo).format('M/D')}까지</>) : (result.member ? <button className="chip" onClick={(e) => { e.stopPropagation(); go('members', result.member!.id); }}>회원 정보 보기</button> : ' ')}</p>
          <button className="ok" onClick={() => { setResult(null); busy.current = false; }}>다음 사람</button>
        </div>
      )}
    </>
  );
}
