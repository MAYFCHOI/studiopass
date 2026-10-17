import { useState } from 'react';
import { useStore } from '../store';
import { won, maybeWon, WEEKDAYS, newId } from '../lib/util';
import { Sheet } from '../components/Sheet';
import { toast } from '../components/Toast';
import type { Instructor, Course, Product, Hall } from '../types';
import { Timetable } from '../components/Timetable';
import { courseTitle, courseMeta } from '../lib/labels';
import { IS_DEMO } from '../lib/mode';

export default function Settings() {
  const s = useStore();
  const [edit, setEdit] = useState<{ kind: 'ins'; v: Instructor } | { kind: 'course'; v: Course } | { kind: 'product'; v: Product } | null>(null);
  const saved = () => { setEdit(null); toast('저장했어요'); };

  return (
    <>
      {s.needsRealPrices && <div className="notice" role="note">수강권 가격과 강사 정산 조건이 아직 예시값이에요. 실제 값으로 바꿔주세요</div>}
      <h1><small>{s.studioName}</small>설정</h1>

      <h2>수업 시간표</h2>
      <p className="sub">칸을 누르면 수업을 고칠 수 있어요.</p>
      <Timetable onPick={(c) => setEdit({ kind: 'course', v: { ...c } })} />
      <button className="btn sm" style={{ marginTop: 10 }} onClick={() => setEdit({ kind: 'course', v: { id: newId(), name: '', instructorId: s.instructors[0]?.id ?? '', kind: 'GENERAL', hall: 'HUB', level: 'ALL', weekday: [1], startTime: '19:00', durationMin: 80 } })}>수업 추가</button>

      <h2>강사와 정산 기준</h2>
      <div className="list">
        {s.instructors.map((i) => (
          <button className="row" key={i.id} onClick={() => setEdit({ kind: 'ins', v: { ...i } })}>
            <div className="avatar">{i.name.slice(0, 2)}</div>
            <div className="main"><div className="t">{i.name}</div><div className="d">{i.crew}</div></div>
            <div className="right">{i.settlementType === 'RATIO' ? <><b>{100 - (i.ratioInstructor ?? 0)}:{i.ratioInstructor ?? 0}</b>학원:강사</> : <><b>{won(i.perSessionFee ?? 0)}</b>1타임</>}</div>
          </button>
        ))}
      </div>
      <button className="btn sm" style={{ marginTop: 10 }} onClick={() => setEdit({ kind: 'ins', v: { id: newId(), name: '', settlementType: 'RATIO', ratioInstructor: 50, perSessionFee: 0 } })}>강사 추가</button>

      <h2>수강권 상품 (키오스크 상품명과 똑같이)</h2>
      <p className="sub">키오스크 결제 내역의 상품명이 여기 이름과 같으면 수강권이 자동으로 만들어져요.</p>
      <div className="list">
        {s.products.map((p) => (
          <button className="row" key={p.id} onClick={() => setEdit({ kind: 'product', v: { ...p } })}>
            <div className="main"><div className="t">{p.name}</div><div className="d">{p.passKind === 'PERIOD' ? `월정액 · ${p.count}회 자유수강 · ${p.periodDays}일` : `${(() => { const c = s.courses.find((x) => x.id === p.courseId); return c ? courseTitle(s, c) + ' 전용' : '정규 수업 아무거나'; })()} · ${p.count}회 · ${p.periodDays}일`}</div></div>
            <div className="right num">{maybeWon(p.price)}</div>
          </button>
        ))}
      </div>
      <button className="btn sm" style={{ marginTop: 10 }} onClick={() => setEdit({ kind: 'product', v: { id: newId(), name: '', passKind: 'COUNT', count: 8, periodDays: 60, price: 180000 } })}>상품 추가</button>

      <h2>이 프로토타입이 가정한 것</h2>
      <div className="note">
        <ul>
          <li>키오스크 결제는 업체 관리 웹에서 엑셀로 내려받아 올린다. 자동 연동(API)은 업체가 열어주면 같은 자리에 붙인다.</li>
          <li>결제자 식별은 휴대폰 번호. 번호가 없거나 안 맞으면 "확인 필요" 에 쌓이고 사람이 고른다.</li>
          <li>시간표·강사는 실제 포스터 그대로. 수강권 가격·회차·기간과 강사 정산 조건(전원 50:50)은 아직 받지 못한 예시값.</li>
          <li>정규 회차권은 HUB·LAB 정규 수업 어디서나 쓴다. LAB 첫 타임(PRO Class)은 전문반 월정액만 들어간다.</li>
          <li>HUB 첫 타임은 포스터 띠 문구대로 WarmUp Training LV.0 으로 봤다.</li>
          <li>회차권은 결제일부터 상품에 정한 일수 동안 유효. 전문반은 결제일 +30일, 월 12회, 이월 없음.</li>
          <li>한 회원이 수강권을 여러 개 가지면 그 수업 전용권 → 정규 공통 회차권 → 전문반 월정액, 같은 순위는 만료 임박 순.</li>
          <li>QR 에는 회원 식별값만 넣는다. 이름·연락처는 찍었을 때 화면에서만 보인다.</li>
          {IS_DEMO && <li>지금은 기기(브라우저) 안에만 저장된다. 실제 운영 때는 서버 + 로그인으로 바꾼다.</li>}
        </ul>
      </div>

      {IS_DEMO && <>
        <h2>데이터</h2>
        <div className="btn-row">
          <button className="btn ghost wide" onClick={() => { if (confirm('데모 데이터로 되돌릴까요? 지금 입력한 내용은 지워져요.')) { s.reset().then(() => toast('데모 데이터로 되돌렸어요')); } }}>데모 데이터로 초기화</button>
        </div>
      </>}

      {edit?.kind === 'ins' && (
        <Sheet onClose={() => setEdit(null)} title={edit.v.name ? '강사 수정' : '강사 추가'}>
          <div className="field"><label>이름</label><input className="input" autoFocus value={edit.v.name} onChange={(e) => setEdit({ kind: 'ins', v: { ...edit.v, name: e.target.value } })} /></div>
          <div className="field"><label>장르 · 크루</label><input className="input" value={edit.v.crew ?? ''} onChange={(e) => setEdit({ kind: 'ins', v: { ...edit.v, crew: e.target.value } })} /></div>
          <div className="field"><label>정산 방식</label><div className="seg"><button aria-pressed={edit.v.settlementType === 'RATIO'} onClick={() => setEdit({ kind: 'ins', v: { ...edit.v, settlementType: 'RATIO' } })}>비율제</button><button aria-pressed={edit.v.settlementType === 'PER_SESSION'} onClick={() => setEdit({ kind: 'ins', v: { ...edit.v, settlementType: 'PER_SESSION' } })}>타임제</button></div></div>
          {edit.v.settlementType === 'RATIO' ? (
            <div className="field"><label>강사 비율 (%) · 학원 {100 - (edit.v.ratioInstructor ?? 50)}%</label><input className="input" type="range" min={0} max={100} step={5} value={edit.v.ratioInstructor ?? 50} onChange={(e) => setEdit({ kind: 'ins', v: { ...edit.v, ratioInstructor: Number(e.target.value) } })} style={{ padding: 0, height: 32 }} /><div style={{ fontSize: 28, fontWeight: 800 }}>{100 - (edit.v.ratioInstructor ?? 50)} : {edit.v.ratioInstructor ?? 50}</div></div>
          ) : (
            <div className="field"><label>1타임 금액</label><input className="input" inputMode="numeric" value={edit.v.perSessionFee ?? 0} onChange={(e) => setEdit({ kind: 'ins', v: { ...edit.v, perSessionFee: Number(e.target.value.replace(/\D/g, '')) } })} /></div>
          )}
          <button className="btn primary wide" disabled={!edit.v.name.trim()} onClick={() => { s.upsertInstructor(edit.v).then(saved, () => {}); }}>저장</button>
        </Sheet>
      )}
      {edit?.kind === 'course' && (
        <Sheet onClose={() => setEdit(null)} title={edit.v.name ? '수업 수정' : '수업 추가'}>
          <div className="field"><label>장르 (시간표 검은 띠에 들어가는 글자)</label><input className="input" autoFocus value={edit.v.name} onChange={(e) => setEdit({ kind: 'course', v: { ...edit.v, name: e.target.value } })} /></div>
          <div className="field"><label>강사</label><select className="input" value={edit.v.instructorId} onChange={(e) => setEdit({ kind: 'course', v: { ...edit.v, instructorId: e.target.value } })}>{s.instructors.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</select></div>
          <div className="grid2">
            <div className="field"><label>홀</label><div className="seg">{(['HUB', 'LAB'] as Hall[]).map((h) => <button key={h} aria-pressed={edit.v.hall === h} onClick={() => setEdit({ kind: 'course', v: { ...edit.v, hall: h } })}>{h}</button>)}</div></div>
            <div className="field"><label>레벨</label><select className="input" value={edit.v.level ?? ''} onChange={(e) => setEdit({ kind: 'course', v: { ...edit.v, level: e.target.value || undefined } })}><option value="">표시 안 함</option>{['0', '1', '2', '3', '4', 'ALL'].map((l) => <option key={l} value={l}>LV.{l}</option>)}</select></div>
          </div>
          <div className="field"><label>요일</label><div className="seg" style={{ flexWrap: 'wrap' }}>{WEEKDAYS.map((w, i) => <button key={w} aria-pressed={edit.v.weekday.includes(i)} onClick={() => setEdit({ kind: 'course', v: { ...edit.v, weekday: !IS_DEMO ? [i] : edit.v.weekday.includes(i) ? edit.v.weekday.filter((x) => x !== i) : [...edit.v.weekday, i].sort() } })}>{w}</button>)}</div></div>
          <div className="grid2">
            <div className="field"><label>시작</label><input className="input" type="time" value={edit.v.startTime} onChange={(e) => setEdit({ kind: 'course', v: { ...edit.v, startTime: e.target.value } })} /></div>
            <div className="field"><label>길이(분)</label><input className="input" inputMode="numeric" value={edit.v.durationMin} onChange={(e) => setEdit({ kind: 'course', v: { ...edit.v, durationMin: Number(e.target.value) || 0 } })} /></div>
          </div>
          <div className="field"><label>종류</label><div className="seg"><button aria-pressed={edit.v.kind === 'GENERAL'} onClick={() => setEdit({ kind: 'course', v: { ...edit.v, kind: 'GENERAL' } })}>일반</button><button aria-pressed={edit.v.kind === 'PRO'} onClick={() => setEdit({ kind: 'course', v: { ...edit.v, kind: 'PRO' } })}>전문반</button></div></div>
          <button className="btn primary wide" disabled={!edit.v.name.trim()} onClick={() => { s.upsertCourse(edit.v).then(saved, () => {}); }}>저장</button>
        </Sheet>
      )}
      {edit?.kind === 'product' && (
        <Sheet onClose={() => setEdit(null)} title={edit.v.name ? '상품 수정' : '상품 추가'}>
          <div className="field"><label>상품명 (키오스크와 동일하게)</label><input className="input" autoFocus value={edit.v.name} onChange={(e) => setEdit({ kind: 'product', v: { ...edit.v, name: e.target.value } })} /></div>
          <div className="field"><label>종류</label><div className="seg"><button aria-pressed={edit.v.passKind === 'COUNT'} onClick={() => setEdit({ kind: 'product', v: { ...edit.v, passKind: 'COUNT' } })}>회차권</button><button aria-pressed={edit.v.passKind === 'PERIOD'} onClick={() => setEdit({ kind: 'product', v: { ...edit.v, passKind: 'PERIOD', courseId: undefined, periodDays: 30 } })}>전문반 월정액</button></div></div>
          {edit.v.passKind === 'COUNT' && <div className="field"><label>수업</label><select className="input" value={edit.v.courseId ?? ''} onChange={(e) => setEdit({ kind: 'product', v: { ...edit.v, courseId: e.target.value || undefined } })}><option value="">정규 수업 아무거나</option>{s.courses.filter((c) => c.kind === 'GENERAL').map((c) => <option key={c.id} value={c.id}>{courseTitle(s, c)} · {courseMeta(c)}</option>)}</select></div>}
          <div className="grid2">
            <div className="field"><label>{edit.v.passKind === 'PERIOD' ? '월 자유수강 횟수' : '회차'}</label><input className="input" inputMode="numeric" value={edit.v.count} onChange={(e) => setEdit({ kind: 'product', v: { ...edit.v, count: Number(e.target.value) || 0 } })} /></div>
            <div className="field"><label>유효 기간(일)</label><input className="input" inputMode="numeric" value={edit.v.periodDays} onChange={(e) => setEdit({ kind: 'product', v: { ...edit.v, periodDays: Number(e.target.value) || 0 } })} /></div>
          </div>
          <div className="field"><label>가격</label><input className="input" inputMode="numeric" value={edit.v.price ?? 0} onChange={(e) => setEdit({ kind: 'product', v: { ...edit.v, price: Number(e.target.value.replace(/\D/g, '')) } })} /></div>
          <button className="btn primary wide" disabled={!edit.v.name.trim()} onClick={() => { s.upsertProduct(edit.v).then(saved, () => {}); }}>저장</button>
        </Sheet>
      )}
    </>
  );
}
