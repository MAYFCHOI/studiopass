import { useEffect, useRef, useState } from 'react';
import dayjs from 'dayjs';
import { useStore } from '../store';
import type { Tab } from '../App';
import { fmtPhone, won, maybeWon } from '../lib/util';
import { readSheet, sheetAt, detectHeaderRow, guessMapping, toPayments, sampleCsv, type Mapping, type Row } from '../lib/excel';
import { matchMember, samePhoneMembers } from '../lib/search';
import { useBusy, newRequestKey } from '../lib/useBusy';
import { Sheet } from '../components/Sheet';
import { Icon } from '../components/Icon';

/** 상품명: 잘리지 않게 줄을 바꿔 보여 준다. 키오스크 묶음 결제("A + B")는 상품마다 한 줄. */
function ProdName({ name }: { name: string }) {
  const parts = (name ?? '').split('+').map((x) => x.replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (parts.length < 2) return <div className="prod">{parts[0] ?? name}</div>;
  return <div className="prod multi">{parts.map((x, i) => <span key={i}>{i ? '+ ' : ''}{x}</span>)}</div>;
}
import { toast } from '../components/Toast';
import type { Payment, ImportResult, AssignResult, PayMethod, Product, State, Substitution } from '../types';
import { needsCourse, guessCourse, coursesFor, productByName, passlessPayment } from '../lib/dropin';
import { courseTitle } from '../lib/labels';

const FIELDS: { key: keyof Mapping; label: string; need?: boolean }[] = [
  { key: 'paidAt', label: '결제 일시', need: true }, { key: 'amount', label: '금액', need: true }, { key: 'productName', label: '상품명', need: true },
  { key: 'payerPhone', label: '휴대폰 번호' }, { key: 'payerName', label: '결제자 이름' }, { key: 'externalId', label: '승인번호' }, { key: 'status', label: '상태(승인/취소)' },
];
/** 서버가 받지 않은 행의 이유 */
const REJECT: Record<string, string> = {
  BAD_ROW: '형식이 맞지 않아요', BAD_DATE: '결제 일시를 읽지 못했어요', BAD_AMOUNT: '금액을 읽지 못했어요', NO_PRODUCT: '상품명이 없어요',
  PRODUCT_TOO_LONG: '상품명이 100자를 넘어요', ID_TOO_LONG: '승인번호가 100자를 넘어요', NAME_TOO_LONG: '결제자 이름이 50자를 넘어요',
  BAD_PHONE: '휴대폰 번호 형식이 아니에요', BAD_STATUS: '상태 값을 읽지 못했어요',
};
const REVIEW_TEXT = { REFUND_IN_USE: '환불됐지만 출석 기록이 있어 확인 필요', REFUND_UNMATCHED: '원 결제를 찾지 못한 환불', REFUND_SUGGESTED: '환불 확인 필요 · 원 결제 후보 있음' } as const;
/** 환불 확정(linkRefund) 실패 문구 */
const refundFail = (r: { error: string; used: number }) => r.error === 'PASS_IN_USE' ? `그 결제의 수강권으로 출석 ${r.used}회가 있어 취소할 수 없어요. 출석을 먼저 취소해 주세요`
  : r.error === 'NOT_APPROVED' ? '그 결제는 이미 취소됐어요. 다른 결제를 골라 주세요' : '이미 처리된 환불이에요. 화면을 새로 고쳐 주세요';

type SheetState = { aoa: unknown[][]; firstLine: number; headerIdx: number; headers: string[]; rows: Row[]; lines: number[]; map: Mapping; name: string };
type Result = ImportResult & { badDate: number; name: string; reverted?: { removed: number; kept: number } };

/** 연결 결과 → 토스트 문구 */
function assignMessage(r: AssignResult, who: string) {
  if (!r.ok) return r.error === 'PASS_IN_USE' ? `이 수강권으로 출석 ${r.used ?? 0}회가 있어서 회원을 바꿀 수 없어요. 출석을 먼저 취소해 주세요`
    : r.error === 'ERASED' ? '정보를 삭제한 회원이에요' : '이미 취소된 결제예요';
  if (r.moved) return `${who}에게 옮겼어요. 수강권도 함께 옮겨졌어요`;
  return r.passId ? `${who}에게 연결, 수강권이 생겼어요` : `${who}에게 연결했지만 상품명이 맞는 수강권 상품이 없어 수강권은 아직 없어요. 설정에서 상품명을 키오스크와 같게 고친 뒤 다시 연결해 주세요`;
}

export default function Payments({ go }: { go: (t: Tab, arg?: string) => void }) {
  const s = useStore();
  const [tab, setTab] = useState<'queue' | 'all'>('queue');
  const [sheet, setSheet] = useState<SheetState | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [assign, setAssign] = useState<Payment | null>(null);
  const [review, setReview] = useState<Payment | null>(null);
  const [payerErase, setPayerErase] = useState(false);
  const [dropName, setDropName] = useState('');
  const [dropCourse, setDropCourse] = useState(''); // 원데이 결제의 수업(웜업처럼 상품에 수업이 없을 때)
  const [manual, setManual] = useState(false);
  const [editing, setEditing] = useState<Payment | null>(null);
  const [month, setMonth] = useState(dayjs().format('YYYY-MM'));
  const [q, setQ] = useState('');
  const file = useRef<HTMLInputElement>(null);
  const [busy, run] = useBusy();
  const owner = s.me?.role !== 'DESK';

  const open = async (f: File) => {
    const { aoa, firstLine } = await readSheet(f).catch(() => ({ aoa: [] as unknown[][], firstLine: 1 }));
    const headerIdx = detectHeaderRow(aoa);
    const t = sheetAt(aoa, headerIdx, firstLine);
    if (!t.rows.length) { toast('빈 파일이거나 읽을 수 없는 파일이에요'); return; }
    setSheet({ aoa, firstLine, headerIdx, ...t, map: guessMapping(t.headers), name: f.name });
  };
  const setHeader = (idx: number) => {
    if (!sheet) return;
    const t = sheetAt(sheet.aoa, idx, sheet.firstLine);
    setSheet({ ...sheet, headerIdx: idx, ...t, map: guessMapping(t.headers) });
  };
  const doImport = () => run(async () => {
    if (!sheet) return;
    const { rows, badDate } = toPayments(sheet.rows, sheet.map, sheet.lines);
    const empty: ImportResult = { added: 0, dup: 0, matched: 0, cancelled: 0, cancelFailed: 0, refundUnmatched: 0, refundSuggested: 0, rejected: [], rejectedCount: 0, dupBatches: [] };
    const r = rows.length ? await s.importPayments(rows).catch(() => null) : empty;
    if (!r) return; // 실패는 store 가 알렸다
    setSheet(null);
    setResult({ ...r, badDate, name: sheet.name });
    setTab('queue');
  });
  const revert = (batchId: string, label: string) => run(async () => {
    if (!confirm(`${label}\n이 업로드로 들어온 결제와 수강권을 지워요. 출석에 쓰인 수강권의 결제는 남아요. 지운 뒤 고친 컬럼으로 파일을 다시 올리면 돼요.`)) return;
    const r = await s.revertImport(batchId).catch(() => null);
    if (!r) return;
    if (!r.ok) {
      toast(r.error === 'HAS_CANCELLED'
        ? `이 업로드의 결제 ${r.count}건이 이미 취소(환불)돼서 되돌릴 수 없어요. 지우고 다시 올리면 취소된 결제가 되살아나요. 결제를 한 건씩 확인해 주세요`
        : `이 업로드의 환불 ${r.count}건이 이미 원 결제를 취소해서 되돌릴 수 없어요. 결제를 한 건씩 확인해 주세요`);
      return;
    }
    if (result) setResult({ ...result, reverted: { removed: r.removed, kept: r.kept } });
  });

  /** 회원은 연결됐는데 수강권이 없는 결제: 키오스크 상품명이 어떤 수강권 상품과도 맞지 않았다. */
  const noPass = (p: Payment) => p.status === 'APPROVED' && !!p.memberId && !p.passId && !passlessPayment(s, p.productName);
  /** 원데이 결제: 회원 연결 없이 이름만 적으면 끝. 회원에게 연결했다면 보통 결제처럼 수강권이 있어야 한다. */
  /** 이름은 적었어도 수업이 없어 강사 정산에 안 들어가는 원데이(웜업 등) */
  const noCourse = (p: Payment) => needsCourse(s, p) && !p.courseId;
  const dropOpen = (p: Payment) => !!p.dropIn && p.status === 'APPROVED' && (p.memberId ? !p.passId : (!p.payerName || noCourse(p)));
  const queue = s.payments.filter((p) => !!p.review || (p.status === 'APPROVED' && (p.dropIn ? dropOpen(p) : (!p.memberId || !p.passId)))).sort((a, b) => b.paidAt.localeCompare(a.paidAt));
  const all = [...s.payments].sort((a, b) => b.paidAt.localeCompare(a.paidAt));
  const months = [...new Set([dayjs().format('YYYY-MM'), ...all.map((p) => dayjs(p.paidAt).format('YYYY-MM'))])].sort().reverse();
  const shown = all.filter((p) => dayjs(p.paidAt).format('YYYY-MM') === month);
  const taught = useTaughtBy(owner && assign && needsCourse(s, assign) ? dropCourse : '', assign?.paidAt ?? '');
  const name = (id?: string) => s.members.find((m) => m.id === id)?.name;
  const canEdit = (p: Payment) => owner && p.source === 'MANUAL' && p.status === 'APPROVED';
  const openAssign = (p: Payment) => { setAssign(p); setDropCourse(p.courseId ?? (needsCourse(s, p) ? guessCourse(s, p.productName, p.paidAt)?.id ?? '' : '')); };
  const openItem = (p: Payment) => (p.review ? setReview(p) : openAssign(p));
  const closeAssign = () => { setAssign(null); setQ(''); setPayerErase(false); setDropName(''); setDropCourse(''); };
  const saveDropName = (p: Payment) => run(async () => {
    const n = dropName.trim() || p.payerName || ''; if (!n) return;
    if (needsCourse(s, p) && dropCourse && dropCourse !== (p.courseId ?? '')) { if ((await s.setPaymentCourse(p.id, dropCourse).then(() => true, () => false)) === false) return; }
    if (!(await taught.save())) return;
    if (n !== p.payerName) await s.setPayerName(p.id, n).catch(() => null);
    const c = s.courses.find((x) => x.id === dropCourse);
    toast(needsCourse(s, p) && c ? `${n} 님 원데이 · ${courseTitle(s, c)} 수업으로 적었어요` : `${n} 님 원데이로 적었어요`); closeAssign();
  });
  const pick = (p: Payment, memberId: string, who: string) => run(async () => {
    const r = await s.assignPayment(p.id, memberId).catch(() => null);
    if (!r) return;
    toast(assignMessage(r, who));
    if (r.ok) closeAssign();
  });
  const cancel = (p: Payment, after: () => void) => run(async () => {
    if (!confirm('이 결제를 취소 처리할까요? 수강권도 함께 없어져요.')) return;
    const r = await s.cancelPayment(p.id).catch(() => null);
    if (!r) return;
    if (r.ok) { toast('취소 처리했어요'); after(); return; }
    toast(`이 수강권으로 출석 ${r.used}회가 있어서 취소할 수 없어요. 출석을 먼저 취소해 주세요`);
  });
  const preview = sheet ? toPayments(sheet.rows.slice(0, 3), sheet.map).rows : [];

  return (
    <>
      <h1>결제</h1>
      <div className="btn-row">
        <button className="btn primary wide" onClick={() => setManual(true)}>현금·이체 결제 넣기</button>
        <button className="btn" onClick={() => file.current?.click()}><Icon name="upload" size={18} />엑셀</button>
      </div>
      <input ref={file} type="file" accept=".xlsx,.xls,.csv" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void open(f); e.target.value = ''; }} />
      <p className="sub">토스 키오스크·포스 결제는 저절로 들어와요. 현금이나 계좌이체로 받은 결제만 위 버튼으로 넣어 주세요. 엑셀은 예전 결제 내역을 한꺼번에 올릴 때만 써요. <button className="chip" onClick={() => { const b = new Blob(['﻿' + sampleCsv()], { type: 'text/csv' }); const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = 'kiosk-sample.csv'; a.click(); }}>샘플 파일</button></p>

      {result && <ImportPanel r={result} owner={owner} busy={busy} onClose={() => setResult(null)} onRevert={revert} />}

      <div className="seg" style={{ marginTop: 6 }}>
        <button aria-pressed={tab === 'queue'} onClick={() => setTab('queue')}>확인 필요 {queue.length ? `· ${queue.length}` : ''}</button>
        <button aria-pressed={tab === 'all'} onClick={() => setTab('all')}>전체</button>
      </div>

      {tab === 'queue' && (queue.length === 0 ? <div className="empty"><b>확인할 결제가 없어요</b>모든 결제가 회원에게 연결됐거나 원데이로 적혔어요</div> : (
        <div className="list">
          {queue.map((p) => {
            const same = samePhoneMembers(s.members, p.payerPhone);
            return (
              <button className="row" key={p.id} onClick={() => openItem(p)}>
                <div className="main"><div className="t">{name(p.memberId) ?? (p.payerName || '이름 없음')}</div><ProdName name={p.productName} /><div className="d">{dayjs(p.paidAt).format('M/D HH:mm')} · {p.review ? REVIEW_TEXT[p.review] : noPass(p) ? `${name(p.memberId) ?? '회원'} 연결됨 · 수강권 상품과 이름이 안 맞아 수강권 없음` : p.dropIn ? (p.payerName && noCourse(p) ? '원데이 · 수업을 골라야 강사 정산에 들어가요' : '원데이 · 이름만 적으면 돼요 (회원이면 회원 선택)') : <>{p.payerPhone ? fmtPhone(p.payerPhone) : '번호 없음'}{p.payerPhone && (same.length === 0 ? ' · 일치 회원 없음' : same.length > 1 ? ` · 같은 번호 회원 ${same.length}명` : '')}</>}</div></div>
                <div className="right">{p.amount !== undefined && <b className="num">{won(p.amount)}</b>}<span className="chip amber">{p.review === 'REFUND_UNMATCHED' ? '원 결제 고르기' : p.review === 'REFUND_SUGGESTED' ? '환불 확인' : p.review ? '환불 확인' : noPass(p) ? '상품 미확인' : p.dropIn ? (p.payerName && noCourse(p) ? '수업 고르기' : '이름 적기') : '회원 연결'}</span></div>
              </button>
            );
          })}
        </div>
      ))}
      {tab === 'all' && (<>
        <div className="seg" style={{ marginTop: 8, flexWrap: 'wrap' }}>{months.map((m) => <button key={m} aria-pressed={month === m} onClick={() => setMonth(m)}>{dayjs(m + '-01').format('M월')} · {all.filter((p) => dayjs(p.paidAt).format('YYYY-MM') === m).length}</button>)}</div>
        {shown.length === 0 ? <div className="empty"><b>{dayjs(month + '-01').format('M월')} 결제가 없어요</b></div> : <div className="list">
          {shown.map((p) => (
            <div className="row" key={p.id} style={p.status === 'CANCELLED' ? { opacity: .45 } : undefined}>
              <div className="main"><div className="t">{name(p.memberId) ?? p.payerName ?? '이름 없음'}</div><ProdName name={p.productName} /><div className="d">{dayjs(p.paidAt).format('M/D HH:mm')} · {p.source === 'KIOSK' ? '키오스크' : METHOD_TEXT[p.method ?? ''] ?? '직접 입력'}{p.discountPct ? ` · 할인 ${p.discountPct}%` : ''}{p.externalId && ` · ${p.externalId}`}{p.status === 'CANCELLED' && ' · 취소'}{p.review && ` · ${REVIEW_TEXT[p.review]}`}</div></div>
              <div className="right">{p.amount !== undefined && <b className="num">{won(p.amount)}</b>}
                {p.review && <button className="chip amber" onClick={() => setReview(p)}>확인</button>}
                {canEdit(p) && <button className="chip" onClick={() => setEditing(p)}>수정</button>}
                {p.memberId && <button className="chip" onClick={() => go('members', p.memberId)}>{name(p.memberId)}</button>}
                {p.status === 'APPROVED' && <button className="chip amber" onClick={() => openAssign(p)}>{!p.memberId ? (p.dropIn ? (!p.payerName ? '이름 적기' : noCourse(p) ? '수업 고르기' : '원데이') : '회원 연결') : noPass(p) ? '상품 미확인' : '변경'}</button>}
              </div>
            </div>
          ))}
        </div>}
      </>)}

      {sheet && (
        <Sheet onClose={() => setSheet(null)} title={`${sheet.rows.length}건 불러오기`}>
          <p className="sub">{sheet.name} · 컬럼이 맞게 잡혔는지 아래 미리보기로 확인해 주세요.</p>
          <div className="field"><label>제목 행 (표의 첫 줄)</label>
            <select className="input" value={sheet.headerIdx} onChange={(e) => setHeader(Number(e.target.value))}>
              {sheet.aoa.slice(0, 15).map((r, i) => ({ r, i })).filter(({ r }) => (r ?? []).some((v) => String(v ?? '').trim())).map(({ r, i }) => (
                <option key={i} value={i}>{sheet.firstLine + i}행: {(r ?? []).map((v) => String(v ?? '').trim()).filter(Boolean).join(' · ').slice(0, 40)}</option>
              ))}
            </select></div>
          {FIELDS.map((f) => (
            <div className="field" key={f.key}><label>{f.label}{f.need && ' *'}</label>
              <select className="input" value={sheet.map[f.key] ?? ''} onChange={(e) => setSheet({ ...sheet, map: { ...sheet.map, [f.key]: e.target.value || undefined } })}>
                <option value="">(없음)</option>{sheet.headers.map((h) => <option key={h} value={h}>{h} — 예: {String(sheet.rows[0][h] instanceof Date ? dayjs(sheet.rows[0][h] as Date).format('YYYY-MM-DD HH:mm') : sheet.rows[0][h]).slice(0, 18)}</option>)}
              </select></div>
          ))}
          <div className="preview" aria-label="미리보기">
            <b>미리보기</b>
            {preview.map((p, i) => <div key={i}>{p.paidAt ? dayjs(p.paidAt).format('M/D HH:mm') : '일시 없음'} · {won(p.amount ?? 0)} · {p.productName || '상품 없음'} · {p.payerPhone ? fmtPhone(p.payerPhone) : '번호 없음'}{p.status === 'CANCELLED' && ' · 환불'}</div>)}
          </div>
          <button className="btn primary wide" disabled={busy || !sheet.map.paidAt || !sheet.map.amount || !sheet.map.productName} onClick={() => { void doImport(); }}>{busy ? '불러오는 중…' : '불러오기'}</button>
        </Sheet>
      )}

      {assign && (
        <Sheet onClose={closeAssign} title={assign.passId ? '다른 회원으로 바꾸기' : assign.dropIn && !assign.memberId ? '원데이 손님' : '누구의 결제인가요?'}>
          <p className="sub">{assign.payerName || '이름 없음'} · {assign.productName}{maybeWon(assign.amount, ' · ')}{assign.payerPhone && ` · ${fmtPhone(assign.payerPhone)}`}</p>
          {assign.passId && assign.memberId && <div className="notice" role="note">지금 {name(assign.memberId) ?? '회원'}에게 연결돼 있어요. 다른 회원을 고르면 수강권도 그 회원에게 옮겨져요. 이 수강권으로 출석한 적이 있으면 바꿀 수 없어요.</div>}
          {noPass(assign) && (
            <div className="notice" role="note">
              상품 미확인: {name(assign.memberId) ?? '회원'}에게 연결됐지만 키오스크 상품명 "{assign.productName}" 이 어떤 수강권 상품과도 맞지 않아 수강권이 만들어지지 않았어요. 설정에서 수강권 상품 이름을 키오스크와 똑같이 고친 뒤 다시 연결해 주세요.
              <div style={{ marginTop: 8 }}><button className="btn sm primary" disabled={busy} onClick={() => { void pick(assign, assign.memberId!, name(assign.memberId) ?? '회원'); }}>다시 연결</button></div>
            </div>
          )}
          {assign.dropIn && !assign.memberId && (
            <div className="notice" role="note">
              원데이 결제예요. 회원 등록이나 QR 없이 <b>{needsCourse(s, assign) ? '이름과 수업만 적으면' : '이름만 적으면'}</b> 끝이에요. 회원이 결제한 거면 아래에서 회원을 골라 주세요(수강권이 생겨요).
              {needsCourse(s, assign) && (() => {
                const day = coursesFor(s, assign.productName, assign.paidAt); const dayIds = new Set(day.map((c) => c.id));
                const rest = s.courses.filter((c) => c.active !== false && c.kind === 'GENERAL' && !dayIds.has(c.id));
                return (
                  <div className="field" style={{ marginTop: 10 }}><label style={{ color: 'inherit' }}>어느 수업이었나요? (이 수업 강사에게 정산돼요)</label>
                    <select className="input" value={dropCourse} onChange={(e) => setDropCourse(e.target.value)}>
                      <option value="">고르기</option>
                      <optgroup label={`${dayjs(assign.paidAt).format('M/D (dd)')} 수업`}>{day.map((c) => <option key={c.id} value={c.id}>{c.startTime} {courseTitle(s, c)}{c.note ? ` · ${c.note}` : ''}</option>)}</optgroup>
                      {rest.length > 0 && <optgroup label="다른 요일">{rest.map((c) => <option key={c.id} value={c.id}>{'일월화수목금토'[c.weekday[0]]} {c.startTime} {courseTitle(s, c)}</option>)}</optgroup>}
                    </select>
                  </div>
                );
              })()}
              <TaughtBySelect t={taught} />
              <div className="btn-row" style={{ marginTop: 8 }}>
                <input className="input" placeholder={assign.payerName || '손님 이름'} value={dropName} onChange={(e) => setDropName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void saveDropName(assign); }} />
                <button className="btn primary" disabled={busy || !(dropName.trim() || assign.payerName) || (needsCourse(s, assign) && !dropCourse)} onClick={() => { void saveDropName(assign); }}>{busy ? '저장 중…' : needsCourse(s, assign) ? '저장' : '이름만 적기'}</button>
              </div>
            </div>
          )}
          {samePhoneMembers(s.members, assign.payerPhone).length > 1 && <p className="sub">같은 번호 회원 {samePhoneMembers(s.members, assign.payerPhone).length}명: 자동으로 연결하지 않았어요. 맞는 회원을 골라 주세요.</p>}
          <input className="input" autoFocus={!(assign.dropIn && !assign.memberId)} placeholder="회원 이름, 전화번호 뒷자리" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="list">
            {s.members.filter((m) => !m.erased && m.id !== (assign.passId ? assign.memberId : undefined)).filter((m) => !q.trim() ? (assign.payerName ? m.name.includes(assign.payerName) || (!!assign.payerPhone && m.phone.slice(-4) === assign.payerPhone.slice(-4)) : true) : matchMember(m, q)).slice(0, 8).map((m) => (
              <button className="row" key={m.id} disabled={busy} onClick={() => { void pick(assign, m.id, m.name); }}>
                <div className="avatar">{m.name.slice(-2)}</div><div className="main"><div className="t">{m.name}</div><div className="d">{fmtPhone(m.phone)} · {m.memberNo}</div></div>
              </button>
            ))}
          </div>
          {owner && !assign.memberId && (assign.payerName || assign.payerPhone) && (!payerErase
            ? <button className="btn sm ghost" style={{ marginTop: 10 }} onClick={() => setPayerErase(true)}>결제자 정보 삭제</button>
            : <div className="notice" role="alertdialog" aria-label="결제자 정보 삭제 확인">
                결제자 이름·전화번호를 지울까요? 되돌릴 수 없어요. 결제 금액·상품·일시는 정산을 위해 남아요.
                <div className="btn-row">
                  <button className="btn wide" onClick={() => setPayerErase(false)}>그만두기</button>
                  <button className="btn primary wide" disabled={busy} onClick={() => { void run(() => s.erasePayer(assign.id).then(() => { closeAssign(); toast('결제자 정보를 삭제했어요'); })); }}>삭제하기</button>
                </div>
              </div>)}
          <div className="btn-row">
            {canEdit(assign) && <button className="btn wide" onClick={() => { const p = assign; closeAssign(); setEditing(p); }}>결제 수정</button>}
            {!assign.memberId && <button className="btn wide" onClick={() => { setAssign(null); go('members'); }}>새 회원으로 등록</button>}
            <button className="btn ghost" disabled={busy} onClick={() => { void cancel(assign, closeAssign); }}>{busy ? '처리 중…' : '취소 처리'}</button>
          </div>
        </Sheet>
      )}

      {review && <ReviewSheet p={review} busy={busy} run={run} onClose={() => setReview(null)} go={go} onCancel={() => { void cancel(review, () => setReview(null)); }} />}
      {manual && <ManualPay onClose={() => setManual(false)} />}
      {editing && <EditPay p={editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function ImportPanel({ r, owner, busy, onClose, onRevert }: { r: Result; owner: boolean; busy: boolean; onClose: () => void; onRevert: (batchId: string, label: string) => void }) {
  const old = r.dupBatches[0];
  const lines = [
    `${r.added}건 추가 · 중복 ${r.dup}건 · 회원 자동 연결 ${r.matched}건`,
    r.cancelled > 0 && `환불 ${r.cancelled}건 반영`,
    r.cancelFailed > 0 && `환불 ${r.cancelFailed}건은 출석 기록이 있어 확인 필요에 올렸어요`,
    r.refundSuggested + r.refundUnmatched > 0 && `환불 확인 필요 ${r.refundSuggested + r.refundUnmatched}건 (확인 필요 탭에서 원 결제를 확정해 주세요)`,
    r.badDate > 0 && `결제 일시를 읽지 못한 ${r.badDate}행은 건너뛰었어요`,
    r.rejectedCount > 0 && `저장하지 못한 행 ${r.rejectedCount}개 (아래 목록)`,
  ].filter(Boolean) as string[];
  return (
    <section className="result-panel" role="status" aria-label="불러오기 결과">
      <div className="head"><span>불러오기 결과 · {r.name}</span><button onClick={onClose}>닫기</button></div>
      <ul>{lines.map((l) => <li key={l}>{l}</li>)}</ul>
      {r.rejected.length > 0 && <ul className="rej">{r.rejected.map((x, i) => <li key={i}>{x.line ? `${x.line}행` : `${i + 1}번째`}: {REJECT[x.reason] ?? x.reason}</li>)}{r.rejectedCount > r.rejected.length && <li>외 {r.rejectedCount - r.rejected.length}개</li>}</ul>}
      {r.reverted && <p style={{ margin: '10px 0 0', fontWeight: 700 }}>되돌렸어요: 결제 {r.reverted.removed}건 삭제{r.reverted.kept > 0 && `, ${r.reverted.kept}건은 출석 기록이 있어 남겼어요`}. 고친 컬럼으로 다시 올려 주세요.</p>}
      {owner && !r.reverted && (
        <div className="btn-row">
          {r.added > 0 && r.batchId && <button className="btn sm" disabled={busy} onClick={() => onRevert(r.batchId!, '방금 올린 업로드를 되돌릴까요?')}>이 업로드 되돌리기</button>}
          {r.added === 0 && r.dup > 0 && old && <button className="btn sm primary" disabled={busy} onClick={() => onRevert(old.batchId, `예전에 올린 업로드(${old.count}건 겹침)를 되돌릴까요?`)}>잘못 올린 결제 되돌리기</button>}
        </div>
      )}
      {owner && !r.reverted && r.added === 0 && r.dup > 0 && old && <p className="sub" style={{ marginBottom: 0 }}>전부 중복이에요. 예전에 같은 파일을 잘못된 컬럼으로 올렸다면 그 업로드를 되돌린 뒤 다시 올리면 돼요.</p>}
    </section>
  );
}

function ReviewSheet({ p, busy, run, onClose, go, onCancel }: { p: Payment; busy: boolean; run: (f: () => Promise<unknown>) => Promise<void>; onClose: () => void; go: (t: Tab, arg?: string) => void; onCancel: () => void }) {
  const s = useStore();
  const name = (id?: string) => s.members.find((m) => m.id === id)?.name;
  const done = (msg: string) => { toast(msg); onClose(); };
  const [picking, setPicking] = useState(false);
  if (p.review === 'REFUND_IN_USE') {
    return (
      <Sheet onClose={onClose} title="환불 확인 필요">
        <p className="sub">{name(p.memberId) ?? p.payerName ?? '이름 없음'} · {p.productName}{maybeWon(p.amount, ' · ')} · {dayjs(p.paidAt).format('M/D HH:mm')}</p>
        <div className="notice" role="note">키오스크에서 환불됐지만 이 수강권으로 출석한 기록이 있어 결제를 승인 상태로 두었어요. 출석을 취소한 뒤 결제를 취소하거나, 그대로 둘지 정해 주세요.</div>
        <div className="btn-row">
          {p.memberId && <button className="btn wide" onClick={() => { onClose(); go('members', p.memberId); }}>출석 기록 보기</button>}
          <button className="btn wide" disabled={busy} onClick={onCancel}>취소 처리</button>
        </div>
        <button className="btn ghost wide" style={{ marginTop: 8 }} disabled={busy} onClick={() => { void run(() => s.clearReview(p.id).then(() => done('확인했어요. 승인 상태로 둘게요'))); }}>확인함 (그대로 둠)</button>
      </Sheet>
    );
  }
  if (p.review === 'REFUND_SUGGESTED' && !picking) {
    const o = s.payments.find((x) => x.id === p.refundSuggestedOf);
    const used = o?.passId ? s.attendances.filter((a) => a.passId === o.passId && !a.cancelledAt).length : 0;
    return (
      <Sheet onClose={onClose} title="환불 확인">
        <p className="sub">환불 {p.payerName || '이름 없음'} · {p.productName}{maybeWon(p.amount, ' · ')} · {dayjs(p.paidAt).format('M/D HH:mm')}</p>
        {o ? (
          <div className="notice" role="note">
            원 결제 후보: {name(o.memberId) ?? o.payerName ?? '이름 없음'} · {o.productName} · {dayjs(o.paidAt).format('M/D HH:mm')}{o.externalId && ` · ${o.externalId}`}<br />
            {o.passId ? (used > 0 ? `이 수강권으로 출석 ${used}회가 있어요` : '이 수강권은 아직 쓰지 않았어요') : '수강권 없음'}
            <p style={{ margin: '6px 0 0', fontWeight: 500 }}>승인번호가 달라 자동으로 취소하지 않았어요. 맞으면 환불 처리하면 그 결제와 수강권이 취소돼요(되돌릴 수 없어요).</p>
          </div>
        ) : <p className="sub">후보 결제를 찾을 수 없어요. 다른 결제를 골라 주세요.</p>}
        <div className="btn-row">
          {o && <button className="btn primary wide" disabled={busy} onClick={() => { void run(async () => {
            if (!confirm('이 결제를 환불 처리할까요? 결제와 수강권이 취소돼요.')) return;
            const r = await s.linkRefund(p.id, o.id);
            if (r.ok) done('환불 처리했어요'); else toast(refundFail(r));
          }); }}>{busy ? '처리 중…' : '이 결제 환불 처리'}</button>}
          <button className="btn wide" onClick={() => setPicking(true)}>다른 결제 고르기</button>
        </div>
      </Sheet>
    );
  }
  const t = dayjs(p.paidAt);
  const cands = s.payments.filter((x) => x.status === 'APPROVED' && x.id !== p.id && !dayjs(x.paidAt).isAfter(t) && !dayjs(x.paidAt).isBefore(t.subtract(60, 'day'))
    && ((!!p.payerPhone && x.payerPhone === p.payerPhone) || (x.productName === p.productName && (p.amount === undefined || x.amount === p.amount))))
    .sort((a, b) => Number(b.payerPhone === p.payerPhone) - Number(a.payerPhone === p.payerPhone) || b.paidAt.localeCompare(a.paidAt)).slice(0, 8);
  return (
    <Sheet onClose={onClose} title="원 결제를 찾지 못한 환불">
      <p className="sub">환불 {p.payerName || '이름 없음'} · {p.productName}{maybeWon(p.amount, ' · ')} · {dayjs(p.paidAt).format('M/D HH:mm')}{p.payerPhone && ` · ${fmtPhone(p.payerPhone)}`}</p>
      <p className="sub">어느 결제의 환불인가요? 고르면 그 결제가 취소되고 수강권도 없어져요.</p>
      {cands.length === 0 ? <p className="sub">비슷한 승인 결제가 없어요.</p> : (
        <div className="list">
          {cands.map((x) => (
            <button className="row" key={x.id} disabled={busy} onClick={() => { void run(async () => {
              const r = await s.linkRefund(p.id, x.id);
              if (r.ok) done('원 결제를 취소했어요'); else toast(refundFail(r));
            }); }}>
              <div className="main"><div className="t">{name(x.memberId) ?? x.payerName ?? '이름 없음'}</div><ProdName name={x.productName} /><div className="d">{dayjs(x.paidAt).format('M/D HH:mm')}{x.externalId && ` · ${x.externalId}`}{x.payerPhone && ` · ${fmtPhone(x.payerPhone)}`}</div></div>
              <div className="right">{x.amount !== undefined && <b className="num">{won(x.amount)}</b>}<span className="chip">이 결제</span></div>
            </button>
          ))}
        </div>
      )}
      <button className="btn ghost wide" style={{ marginTop: 10 }} disabled={busy} onClick={() => { void run(() => s.clearReview(p.id).then(() => done('확인했어요'))); }}>원 결제가 이 앱에 없어요 (확인함)</button>
    </Sheet>
  );
}

const METHODS: [PayMethod, string][] = [['CASH', '현금'], ['TRANSFER', '계좌이체'], ['OTHER', '기타']];
const METHOD_TEXT: Record<string, string> = Object.fromEntries(METHODS);

/** 현금·이체처럼 키오스크 밖에서 받은 결제. 수강권 상품은 회원을 고르고, 원데이 상품은 손님 이름만 적어도 된다. */
function ManualPay({ onClose }: { onClose: () => void }) {
  const s = useStore();
  const live = s.members.filter((m) => !m.erased);
  const products = sellable(s).sort((a, b) => a.name.localeCompare(b.name));
  const [method, setMethod] = useState<PayMethod>('CASH');
  const pct = s.instructorDiscountPct ?? 50;
  const [discount, setDiscount] = useState(false);
  const [productId, setProductId] = useState('');
  const prod = products.find((p) => p.id === productId);
  const [amount, setAmount] = useState('');
  const [q, setQ] = useState('');
  const [memberId, setMemberId] = useState('');
  const member = live.find((m) => m.id === memberId);
  const [guest, setGuest] = useState('');
  const today = dayjs().format('YYYY-MM-DD');
  const [day, setDay] = useState(today);
  const [courseId, setCourseId] = useState(''); // 원데이인데 상품에 수업이 없을 때(웜업)
  const [key] = useState(newRequestKey); // 이 폼의 요청 키: 두 번 눌러도, 응답을 못 받고 다시 눌러도 결제는 하나
  const [busy, run] = useBusy();
  const total = Number(amount.replace(/\D/g, '')) || 0; // DESK 는 상품 가격을 모르니 금액을 직접 넣는다
  const drop = !!prod?.dropIn;
  const at = day === today ? dayjs().toISOString() : dayjs(`${day}T12:00:00`).toISOString();
  const pickCourse = drop && !member && !!prod && !prod.courseId;
  const dayCourses = pickCourse ? coursesFor(s, prod!.name, at) : [];
  const course = courseId || (pickCourse ? guessCourse(s, prod!.name, at)?.id ?? '' : '');
  const taught = useTaughtBy(s.me?.role !== 'DESK' && pickCourse ? course : '', at);
  const who = member?.name ?? guest.trim();
  const ready = !!prod && total > 0 && (!!member || (drop && !!guest.trim())) && (!pickCourse || !!course);
  const priceOf = (p: Product | undefined, d: boolean) => (p?.price ? String(d ? Math.round((p.price * (100 - pct)) / 100) : p.price) : '');
  const choose = (id: string) => { setProductId(id); const p = products.find((x) => x.id === id); const v = priceOf(p, discount); if (v) setAmount(v); };
  const toggleDiscount = () => { const d = !discount; setDiscount(d); const v = priceOf(prod, d); if (v) setAmount(v); };
  const submit = () => run(async () => {
    const paidAt = day === today ? undefined : dayjs(`${day}T12:00:00`).toISOString();
    await s.addPayment({ memberId: member?.id, productName: prod!.name, amount: total, payerName: who, payerPhone: member?.phone, paidAt, method, courseId: pickCourse ? course : undefined, discountPct: discount ? pct : undefined }, { idempotencyKey: key });
    if (!(await taught.save())) return;
    toast(member && !drop ? `${who} 결제 등록, 수강권이 생겼어요` : `${who} 님 원데이 결제 등록`); onClose();
  });
  const regular = products.filter((p) => !p.dropIn); const drops = products.filter((p) => p.dropIn);
  return (
    <Sheet onClose={onClose} title="현금·이체 결제 넣기">
      <div className="field"><label>받은 방법</label><div className="seg">{METHODS.map(([v, t]) => <button key={v} aria-pressed={method === v} onClick={() => setMethod(v)}>{t}</button>)}</div></div>
      <div className="field"><label>상품</label><select className="input" value={productId} onChange={(e) => choose(e.target.value)}>
        <option value="">상품 고르기</option>
        {regular.length > 0 && <optgroup label="수강권">{regular.map((p) => <option key={p.id} value={p.id}>{p.name}{maybeWon(p.price, ' · ')}</option>)}</optgroup>}
        {drops.length > 0 && <optgroup label="원데이">{drops.map((p) => <option key={p.id} value={p.id}>{p.name}{maybeWon(p.price, ' · ')}</option>)}</optgroup>}
      </select></div>
      <div className="field"><label>금액</label><input className="input" inputMode="numeric" placeholder="원" value={amount} onChange={(e) => setAmount(e.target.value)} />
        <div className="seg" style={{ marginTop: 8 }}><button aria-pressed={!discount} onClick={() => { if (discount) toggleDiscount(); }}>정가</button><button aria-pressed={discount} onClick={() => { if (!discount) toggleDiscount(); }}>강사 할인 {pct}%</button></div></div>
      {pickCourse && <div className="field"><label>어느 수업이었나요? (이 수업 강사에게 정산돼요)</label><select className="input" value={course} onChange={(e) => setCourseId(e.target.value)}><option value="">고르기</option>{dayCourses.map((c) => <option key={c.id} value={c.id}>{c.startTime} {courseTitle(s, c)}{c.note ? ` · ${c.note}` : ''}</option>)}</select></div>}
      {pickCourse && <TaughtBySelect t={taught} />}
      {drop && !member && <div className="field"><label>손님 이름</label><input className="input" placeholder="이름만 적으면 돼요" value={guest} onChange={(e) => setGuest(e.target.value)} /></div>}
      <div className="field"><label>{drop ? '회원이면 회원 고르기 (선택)' : '회원'}</label>
        {member
          ? <div className="row"><div className="avatar">{member.name.slice(-2)}</div><div className="main"><div className="t">{member.name}</div><div className="d">{fmtPhone(member.phone)} · {member.memberNo}</div></div><button className="chip" onClick={() => setMemberId('')}>바꾸기</button></div>
          : <>
              <input className="input" placeholder="회원 이름, 전화번호 뒷자리" value={q} onChange={(e) => setQ(e.target.value)} />
              {q.trim() && <div className="list">{live.filter((m) => matchMember(m, q)).slice(0, 6).map((m) => (
                <button className="row" key={m.id} onClick={() => { setMemberId(m.id); setQ(''); }}>
                  <div className="avatar">{m.name.slice(-2)}</div><div className="main"><div className="t">{m.name}</div><div className="d">{fmtPhone(m.phone)} · {m.memberNo}</div></div>
                </button>))}</div>}
            </>}
      </div>
      <div className="field"><label>받은 날</label><input className="input" type="date" max={today} value={day} onChange={(e) => setDay(e.target.value || today)} /></div>
      <button className="btn primary wide" disabled={busy || !ready} onClick={() => { void submit(); }}>{busy ? '등록 중…' : ready ? `${who} · ${won(total)} 등록` : '등록'}</button>
    </Sheet>
  );
}

/** 결제 넣기·고치기에 고를 수 있는 상품: 쉬는 상품, 쉬는 수업(지운 수업)에 묶인 상품은 뺀다. keep 은 지금 고른 상품(고칠 때 그대로 보이게) */
function sellable(s: Pick<State, 'products' | 'courses'>, keep?: string) {
  const liveCourse = (id?: string) => !id || s.courses.find((c) => c.id === id)?.active !== false;
  return s.products.filter((p) => p.id === keep || (p.active !== false && liveCourse(p.courseId)));
}

/** 직접 넣은 결제(현금·이체) 고치기. 원장만. 상품·받은 날을 바꾸면 수강권을 새로 만든다(출석했으면 못 바꾼다) */
/** 원데이 결제가 센 수업 날: 받은 날부터 그 수업 요일이 처음 오는 날(서버 정산 classDay 와 같다, 달은 넘기지 않는다). */
function dropDay(paidAt: string, weekday?: number) {
  const d = dayjs(paidAt).startOf('day');
  if (weekday === undefined) return d.format('YYYY-MM-DD');
  const t = d.add((weekday - d.day() + 7) % 7, 'day');
  return (t.month() === d.month() ? t : d).format('YYYY-MM-DD');
}

/** 원데이에 고른 수업을 그 날 다른 강사가 했을 때(웜업을 다른 쌤이 한 날 등): 그 날 그 수업을 대강으로 적어 정산이 그 강사에게 가게 한다. 원장만. */
function useTaughtBy(courseId: string, paidAt: string) {
  const s = useStore();
  const course = s.courses.find((c) => c.id === courseId);
  const date = course && paidAt ? dropDay(paidAt, course.weekday[0]) : '';
  const [sub, setSub] = useState<Substitution | null | undefined>(undefined);
  const [who, setWho] = useState('');
  useEffect(() => {
    setSub(undefined); setWho('');
    if (!course || !date) return;
    let live = true;
    s.substitutions(date.slice(0, 7)).then((xs) => {
      if (!live) return; const x = xs.find((y) => y.courseId === course.id && y.date === date) ?? null;
      setSub(x); setWho(x?.instructorId ?? course.instructorId);
    }, () => { if (live) { setSub(null); setWho(course.instructorId); } });
    return () => { live = false; };
  }, [course?.id, date]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = async () => {
    if (!course || sub === undefined || !who) return true;
    if (who === (sub?.instructorId ?? course.instructorId)) return true;
    if (who === course.instructorId) { if (sub) await s.removeSubstitution(sub.id); return true; }
    const r = await s.addSubstitution({ courseId: course.id, date, instructorId: who });
    if (!r.ok) toast('대강을 적지 못했어요. 정산 화면에서 다시 적어 주세요');
    return r.ok;
  };
  return { course, date, who, setWho, ready: !!course && sub !== undefined, save };
}

function TaughtBySelect({ t }: { t: ReturnType<typeof useTaughtBy> }) {
  const s = useStore();
  if (!t.ready || !t.course) return null;
  const c = t.course;
  const orig = s.instructors.find((i) => i.id === c.instructorId)?.name ?? '원래 강사';
  return (
    <div className="field" style={{ marginTop: 10 }}><label style={{ color: 'inherit' }}>{dayjs(t.date).format('M/D')} 이 수업은 누가 했나요?</label>
      <select className="input" value={t.who} onChange={(e) => t.setWho(e.target.value)}>
        {[...s.instructors].sort((a, b) => Number(b.id === c.instructorId) - Number(a.id === c.instructorId) || a.name.localeCompare(b.name)).map((i) => <option key={i.id} value={i.id}>{i.name}{i.id === c.instructorId ? ' (원래 강사)' : ''}</option>)}
      </select>
      {t.who !== c.instructorId && <p className="sub" style={{ margin: '6px 0 0' }}>{orig} 쌤 대신 한 날로 대강에 적혀요. 이 날 이 수업 정산은 고른 강사에게 가요. 같은 날 추가 페이를 따로 넣었다면 정산에서 지워 주세요.</p>}
    </div>
  );
}

function EditPay({ p, onClose }: { p: Payment; onClose: () => void }) {
  const s = useStore();
  const cur = productByName(s.products, p.productName);
  const products = sellable(s, cur?.id).sort((a, b) => a.name.localeCompare(b.name));
  const [method, setMethod] = useState<PayMethod | undefined>(p.method);
  const [productId, setProductId] = useState(cur?.id ?? '');
  const prod = products.find((x) => x.id === productId);
  const [amount, setAmount] = useState(String(p.amount ?? ''));
  const today = dayjs().format('YYYY-MM-DD');
  const [day, setDay] = useState(dayjs(p.paidAt).format('YYYY-MM-DD'));
  const [guest, setGuest] = useState(p.payerName ?? '');
  const [courseId, setCourseId] = useState(p.courseId ?? '');
  const [busy, run] = useBusy();
  const [del, setDel] = useState(false);
  const total = Number(amount.replace(/\D/g, '')) || 0;
  const productName = prod?.name ?? p.productName;
  const drop = prod ? !!prod.dropIn : !!p.dropIn;
  const at = day === dayjs(p.paidAt).format('YYYY-MM-DD') ? p.paidAt : dayjs(`${day}T12:00:00`).toISOString();
  const pickCourse = drop && !p.memberId && !!prod && !prod.courseId;
  const dayCourses = pickCourse ? coursesFor(s, productName, at) : [];
  const taught = useTaughtBy(pickCourse ? courseId : '', at);
  const changedProduct = productName !== p.productName;
  const changedDay = at !== p.paidAt;
  const passUsed = p.passId ? s.attendances.filter((a) => !a.cancelledAt && s.passes.some((x) => x.id === a.passId && x.paymentId === p.id)).length : 0;
  const ready = total > 0 && (!pickCourse || !!courseId) && (!drop || !!p.memberId || !!guest.trim());
  const submit = () => run(async () => {
    const r = await s.editPayment(p.id, {
      ...(changedProduct ? { productName } : {}), ...(total !== p.amount ? { amount: total } : {}), ...(changedDay ? { paidAt: at } : {}),
      ...(method !== p.method ? { method: method ?? null } : {}), ...(pickCourse && courseId !== (p.courseId ?? '') ? { courseId } : {}),
      ...(!p.memberId && drop && guest.trim() !== (p.payerName ?? '') ? { payerName: guest.trim() } : {}),
    }).catch(() => null);
    if (!r) return;
    if (r.ok && !(await taught.save())) return;
    if (!r.ok) { toast(r.error === 'PASS_IN_USE' ? `이 수강권으로 출석 ${r.used}회가 있어 상품·받은 날은 못 바꿔요. 금액·받은 방법만 고칠 수 있어요` : r.error === 'KIOSK' ? '키오스크 결제는 고칠 수 없어요' : '이미 취소된 결제예요'); return; }
    toast(p.memberId && (changedProduct || changedDay) ? '고쳤어요. 수강권도 새로 만들었어요' : '고쳤어요'); onClose();
  });
  const remove = () => run(async () => {
    const r = await s.cancelPayment(p.id).catch(() => null);
    if (!r) return;
    if (!r.ok) { toast(`이 수강권으로 출석 ${r.used}회가 있어 지울 수 없어요. 출석을 먼저 취소해 주세요`); return; }
    toast('결제를 지웠어요'); onClose();
  });
  return (
    <Sheet onClose={onClose} title="결제 수정">
      <p className="sub">{p.memberId ? (s.members.find((m) => m.id === p.memberId)?.name ?? '회원') : (p.payerName || '이름 없음')} · {dayjs(p.paidAt).format('M/D')} 넣은 결제</p>
      {passUsed > 0 && <div className="notice" role="note">이 결제의 수강권으로 출석 {passUsed}회가 있어요. 상품과 받은 날은 바꿀 수 없고, 금액·받은 방법만 고칠 수 있어요.</div>}
      <div className="field"><label>받은 방법</label><div className="seg">{METHODS.map(([v, t]) => <button key={v} aria-pressed={method === v} onClick={() => setMethod(v)}>{t}</button>)}</div></div>
      <div className="field"><label>상품</label><select className="input" value={productId} disabled={passUsed > 0} onChange={(e) => { setProductId(e.target.value); setCourseId(''); const x = products.find((y) => y.id === e.target.value); if (x?.price) setAmount(String(x.price)); }}>
        {!cur && <option value="">{p.productName} (상품 목록에 없음)</option>}
        {products.map((x) => <option key={x.id} value={x.id}>{x.name}{x.dropIn ? ' · 원데이' : ''}{maybeWon(x.price, ' · ')}</option>)}
      </select></div>
      <div className="field"><label>금액</label><input className="input" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
      {pickCourse && <div className="field"><label>어느 수업이었나요? (이 수업 강사에게 정산돼요)</label><select className="input" value={courseId} onChange={(e) => setCourseId(e.target.value)}><option value="">고르기</option>{dayCourses.map((c) => <option key={c.id} value={c.id}>{c.startTime} {courseTitle(s, c)}{c.note ? ` · ${c.note}` : ''}</option>)}</select></div>}
      {pickCourse && <TaughtBySelect t={taught} />}
      {drop && !p.memberId && <div className="field"><label>손님 이름</label><input className="input" value={guest} onChange={(e) => setGuest(e.target.value)} /></div>}
      <div className="field"><label>받은 날</label><input className="input" type="date" max={today} value={day} disabled={passUsed > 0} onChange={(e) => setDay(e.target.value || day)} /></div>
      {p.memberId && (changedProduct || changedDay) && <p className="sub">상품이나 받은 날을 바꾸면 이 결제의 수강권을 지우고 새 상품·날짜로 다시 만들어요.</p>}
      <button className="btn primary wide" disabled={busy || !ready} onClick={() => { void submit(); }}>{busy ? '저장 중…' : `${won(total)}로 저장`}</button>
      {!del
        ? <button className="btn ghost wide" style={{ marginTop: 10 }} onClick={() => setDel(true)}>이 결제 지우기</button>
        : <div className="notice" role="alertdialog" aria-label="결제 지우기 확인" style={{ marginTop: 10 }}>
            잘못 넣은 결제면 지워 주세요. 정산과 결제 합계에서 빠지고{p.passId ? ' 이 결제로 만든 수강권도 같이 없어져요' : ''}. 결제 목록에는 흐리게 '취소'로 남아요.
            <div className="btn-row">
              <button className="btn wide" onClick={() => setDel(false)}>그만두기</button>
              <button className="btn primary wide" disabled={busy} onClick={() => { void remove(); }}>{busy ? '지우는 중…' : '지우기'}</button>
            </div>
          </div>}
    </Sheet>
  );
}
