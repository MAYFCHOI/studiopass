import { useRef, useState } from 'react';
import dayjs from 'dayjs';
import { useStore } from '../store';
import type { Tab } from '../App';
import { fmtPhone, won, maybeWon } from '../lib/util';
import { readSheet, sheetAt, detectHeaderRow, guessMapping, toPayments, sampleCsv, type Mapping, type Row } from '../lib/excel';
import { matchMember, samePhoneMembers } from '../lib/search';
import { useBusy, newRequestKey } from '../lib/useBusy';
import { Sheet } from '../components/Sheet';
import { Icon } from '../components/Icon';
import { toast } from '../components/Toast';
import type { Payment, ImportResult, AssignResult } from '../types';

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
const REVIEW_TEXT = { REFUND_IN_USE: '환불됐지만 출석 기록이 있어 확인 필요', REFUND_UNMATCHED: '원 결제를 찾지 못한 환불' } as const;

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
  const [manual, setManual] = useState(false);
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
    const empty: ImportResult = { added: 0, dup: 0, matched: 0, cancelled: 0, cancelFailed: 0, refundUnmatched: 0, rejected: [], rejectedCount: 0, dupBatches: [] };
    const r = rows.length ? await s.importPayments(rows).catch(() => null) : empty;
    if (!r) return; // 실패는 store 가 알렸다
    setSheet(null);
    setResult({ ...r, badDate, name: sheet.name });
    setTab('queue');
  });
  const revert = (batchId: string, label: string) => run(async () => {
    if (!confirm(`${label}\n이 업로드로 들어온 결제와 수강권을 지워요. 출석에 쓰인 수강권의 결제는 남아요. 지운 뒤 고친 컬럼으로 파일을 다시 올리면 돼요.`)) return;
    const r = await s.revertImport(batchId).catch(() => null);
    if (r && result) setResult({ ...result, reverted: r });
  });

  /** 회원은 연결됐는데 수강권이 없는 결제: 키오스크 상품명이 어떤 수강권 상품과도 맞지 않았다. */
  const noPass = (p: Payment) => p.status === 'APPROVED' && !!p.memberId && !p.passId;
  const queue = s.payments.filter((p) => !!p.review || (p.status === 'APPROVED' && (!p.memberId || !p.passId))).sort((a, b) => b.paidAt.localeCompare(a.paidAt));
  const all = [...s.payments].sort((a, b) => b.paidAt.localeCompare(a.paidAt));
  const name = (id?: string) => s.members.find((m) => m.id === id)?.name;
  const month = s.payments.filter((p) => p.status === 'APPROVED' && dayjs(p.paidAt).format('YYYY-MM') === dayjs().format('YYYY-MM')).reduce((n, p) => n + (p.amount ?? 0), 0);
  const openItem = (p: Payment) => (p.review ? setReview(p) : setAssign(p));
  const closeAssign = () => { setAssign(null); setQ(''); setPayerErase(false); };
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
      <h1>{owner && <small>이달 결제 {won(month)}</small>}결제</h1>
      <div className="btn-row">
        <button className="btn primary wide" onClick={() => file.current?.click()}><Icon name="upload" size={18} />키오스크 엑셀 올리기</button>
        <button className="btn" onClick={() => setManual(true)}>직접 입력</button>
      </div>
      <input ref={file} type="file" accept=".xlsx,.xls,.csv" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void open(f); e.target.value = ''; }} />
      <p className="sub">키오스크 관리 웹에서 내려받은 결제 내역을 그대로 올리면 돼요. 휴대폰 번호가 같은 회원에게 자동으로 연결되고 수강권이 생겨요. 번호가 안 맞는 결제만 아래에서 직접 골라주면 돼요. <button className="chip" onClick={() => { const b = new Blob(['﻿' + sampleCsv()], { type: 'text/csv' }); const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = 'kiosk-sample.csv'; a.click(); }}>샘플 파일</button></p>

      {result && <ImportPanel r={result} owner={owner} busy={busy} onClose={() => setResult(null)} onRevert={revert} />}

      <div className="seg" style={{ marginTop: 6 }}>
        <button aria-pressed={tab === 'queue'} onClick={() => setTab('queue')}>확인 필요 {queue.length ? `· ${queue.length}` : ''}</button>
        <button aria-pressed={tab === 'all'} onClick={() => setTab('all')}>전체</button>
      </div>

      {tab === 'queue' && (queue.length === 0 ? <div className="empty"><b>확인할 결제가 없어요</b>모든 결제가 회원에게 연결됐어요</div> : (
        <div className="list">
          {queue.map((p) => {
            const same = samePhoneMembers(s.members, p.payerPhone);
            return (
              <button className="row" key={p.id} onClick={() => openItem(p)}>
                <div className="main"><div className="t">{name(p.memberId) ?? (p.payerName || '이름 없음')} · {p.productName}</div><div className="d">{dayjs(p.paidAt).format('M/D HH:mm')} · {p.review ? REVIEW_TEXT[p.review] : noPass(p) ? `${name(p.memberId) ?? '회원'} 연결됨 · 수강권 상품과 이름이 안 맞아 수강권 없음` : <>{p.payerPhone ? fmtPhone(p.payerPhone) : '번호 없음'}{p.payerPhone && (same.length === 0 ? ' · 일치 회원 없음' : same.length > 1 ? ` · 같은 번호 회원 ${same.length}명` : '')}</>}</div></div>
                <div className="right">{p.amount !== undefined && <b className="num">{won(p.amount)}</b>}<span className="chip amber">{p.review === 'REFUND_UNMATCHED' ? '원 결제 고르기' : p.review ? '환불 확인' : noPass(p) ? '상품 미확인' : '회원 연결'}</span></div>
              </button>
            );
          })}
        </div>
      ))}
      {tab === 'all' && (
        <div className="list">
          {all.slice(0, 100).map((p) => (
            <div className="row" key={p.id} style={p.status === 'CANCELLED' ? { opacity: .45 } : undefined}>
              <div className="main"><div className="t">{name(p.memberId) ?? p.payerName ?? '이름 없음'} · {p.productName}</div><div className="d">{dayjs(p.paidAt).format('M/D HH:mm')} · {p.source === 'KIOSK' ? '키오스크' : '수동'}{p.externalId && ` · ${p.externalId}`}{p.status === 'CANCELLED' && ' · 취소'}{p.review && ` · ${REVIEW_TEXT[p.review]}`}</div></div>
              <div className="right">{p.amount !== undefined && <b className="num">{won(p.amount)}</b>}
                {p.review && <button className="chip amber" onClick={() => setReview(p)}>확인</button>}
                {p.memberId && <button className="chip" onClick={() => go('members', p.memberId)}>{name(p.memberId)}</button>}
                {p.status === 'APPROVED' && <button className="chip amber" onClick={() => setAssign(p)}>{!p.memberId ? '회원 연결' : noPass(p) ? '상품 미확인' : '변경'}</button>}
              </div>
            </div>
          ))}
        </div>
      )}

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
        <Sheet onClose={closeAssign} title={assign.passId ? '다른 회원으로 바꾸기' : '누구의 결제인가요?'}>
          <p className="sub">{assign.payerName || '이름 없음'} · {assign.productName}{maybeWon(assign.amount, ' · ')}{assign.payerPhone && ` · ${fmtPhone(assign.payerPhone)}`}</p>
          {assign.passId && assign.memberId && <div className="notice" role="note">지금 {name(assign.memberId) ?? '회원'}에게 연결돼 있어요. 다른 회원을 고르면 수강권도 그 회원에게 옮겨져요. 이 수강권으로 출석한 적이 있으면 바꿀 수 없어요.</div>}
          {noPass(assign) && (
            <div className="notice" role="note">
              상품 미확인: {name(assign.memberId) ?? '회원'}에게 연결됐지만 키오스크 상품명 "{assign.productName}" 이 어떤 수강권 상품과도 맞지 않아 수강권이 만들어지지 않았어요. 설정에서 수강권 상품 이름을 키오스크와 똑같이 고친 뒤 다시 연결해 주세요.
              <div style={{ marginTop: 8 }}><button className="btn sm primary" disabled={busy} onClick={() => { void pick(assign, assign.memberId!, name(assign.memberId) ?? '회원'); }}>다시 연결</button></div>
            </div>
          )}
          {samePhoneMembers(s.members, assign.payerPhone).length > 1 && <p className="sub">같은 번호 회원 {samePhoneMembers(s.members, assign.payerPhone).length}명: 자동으로 연결하지 않았어요. 맞는 회원을 골라 주세요.</p>}
          <input className="input" autoFocus placeholder="회원 이름, 전화번호 뒷자리" value={q} onChange={(e) => setQ(e.target.value)} />
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
            {!assign.memberId && <button className="btn wide" onClick={() => { setAssign(null); go('members'); }}>새 회원으로 등록</button>}
            <button className="btn ghost" disabled={busy} onClick={() => { void cancel(assign, closeAssign); }}>{busy ? '처리 중…' : '취소 처리'}</button>
          </div>
        </Sheet>
      )}

      {review && <ReviewSheet p={review} busy={busy} run={run} onClose={() => setReview(null)} go={go} onCancel={() => { void cancel(review, () => setReview(null)); }} />}
      {manual && <ManualPay onClose={() => setManual(false)} />}
    </>
  );
}

function ImportPanel({ r, owner, busy, onClose, onRevert }: { r: Result; owner: boolean; busy: boolean; onClose: () => void; onRevert: (batchId: string, label: string) => void }) {
  const old = r.dupBatches[0];
  const lines = [
    `${r.added}건 추가 · 중복 ${r.dup}건 · 회원 자동 연결 ${r.matched}건`,
    r.cancelled > 0 && `환불 ${r.cancelled}건 반영`,
    r.cancelFailed > 0 && `환불 ${r.cancelFailed}건은 출석 기록이 있어 확인 필요에 올렸어요`,
    r.refundUnmatched > 0 && `원 결제를 찾지 못한 환불 ${r.refundUnmatched}건은 확인 필요에 올렸어요`,
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
              if (r.ok) done('원 결제를 취소했어요'); else toast(`그 결제의 수강권으로 출석 ${r.used}회가 있어 취소할 수 없어요. 출석을 먼저 취소해 주세요`);
            }); }}>
              <div className="main"><div className="t">{name(x.memberId) ?? x.payerName ?? '이름 없음'} · {x.productName}</div><div className="d">{dayjs(x.paidAt).format('M/D HH:mm')}{x.externalId && ` · ${x.externalId}`}{x.payerPhone && ` · ${fmtPhone(x.payerPhone)}`}</div></div>
              <div className="right">{x.amount !== undefined && <b className="num">{won(x.amount)}</b>}<span className="chip">이 결제</span></div>
            </button>
          ))}
        </div>
      )}
      <button className="btn ghost wide" style={{ marginTop: 10 }} disabled={busy} onClick={() => { void run(() => s.clearReview(p.id).then(() => done('확인했어요'))); }}>원 결제가 이 앱에 없어요 (확인함)</button>
    </Sheet>
  );
}

function ManualPay({ onClose }: { onClose: () => void }) {
  const s = useStore();
  const live = s.members.filter((m) => !m.erased);
  const products = s.products.filter((p) => p.active !== false);
  const [memberId, setMemberId] = useState(live[0]?.id ?? '');
  const [productId, setProductId] = useState(products[0]?.id ?? '');
  const prod = products.find((p) => p.id === productId);
  const [amount, setAmount] = useState(String(prod?.price ?? ''));
  const [key] = useState(newRequestKey); // 이 폼의 요청 키: 두 번 눌러도, 응답을 못 받고 다시 눌러도 결제는 하나
  const [busy, run] = useBusy();
  const total = Number(amount) || prod?.price || 0; // DESK 는 상품 가격을 모르니 금액을 직접 넣는다
  return (
    <Sheet onClose={onClose} title="직접 입력 (현금·이체)">
      <div className="field"><label>회원</label><select className="input" value={memberId} onChange={(e) => setMemberId(e.target.value)}>{live.map((m) => <option key={m.id} value={m.id}>{m.name} · {m.memberNo}</option>)}</select></div>
      <div className="field"><label>상품</label><select className="input" value={productId} onChange={(e) => { setProductId(e.target.value); setAmount(String(products.find((p) => p.id === e.target.value)?.price ?? '')); }}>{products.map((p) => <option key={p.id} value={p.id}>{p.name}{maybeWon(p.price, ' · ')}</option>)}</select></div>
      <div className="field"><label>금액</label><input className="input" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
      <button className="btn primary wide" disabled={busy || !memberId || !prod || !total} onClick={() => { void run(async () => {
        const m = s.members.find((x) => x.id === memberId)!;
        await s.addPayment({ memberId, productName: prod!.name, amount: total, payerName: m.name, payerPhone: m.phone }, { idempotencyKey: key });
        toast(`${m.name} 결제 등록, 수강권이 생겼어요`); onClose();
      }); }}>{busy ? '등록 중…' : '등록'}</button>
    </Sheet>
  );
}
