import { useRef, useState } from 'react';
import dayjs from 'dayjs';
import { useStore } from '../store';
import type { Tab } from '../App';
import { fmtPhone, won, maybeWon } from '../lib/util';
import { readSheet, guessMapping, toPayments, sampleCsv, type Mapping, type Row } from '../lib/excel';
import { Sheet } from '../components/Sheet';
import { Icon } from '../components/Icon';
import { toast } from '../components/Toast';
import type { Payment } from '../types';

const FIELDS: { key: keyof Mapping; label: string; need?: boolean }[] = [
  { key: 'paidAt', label: '결제 일시', need: true }, { key: 'amount', label: '금액', need: true }, { key: 'productName', label: '상품명', need: true },
  { key: 'payerPhone', label: '휴대폰 번호' }, { key: 'payerName', label: '결제자 이름' }, { key: 'externalId', label: '승인번호' }, { key: 'status', label: '상태(승인/취소)' },
];

export default function Payments({ go }: { go: (t: Tab, arg?: string) => void }) {
  const s = useStore();
  const [tab, setTab] = useState<'queue' | 'all'>('queue');
  const [sheet, setSheet] = useState<{ headers: string[]; rows: Row[]; map: Mapping; name: string } | null>(null);
  const [assign, setAssign] = useState<Payment | null>(null);
  const [payerErase, setPayerErase] = useState(false);
  const [manual, setManual] = useState(false);
  const [q, setQ] = useState('');
  const file = useRef<HTMLInputElement>(null);

  const open = async (f: File) => {
    const { headers, rows } = await readSheet(f);
    if (!rows.length) { toast('빈 파일이에요'); return; }
    setSheet({ headers, rows, map: guessMapping(headers), name: f.name });
  };
  const doImport = async () => {
    if (!sheet) return;
    const { rows, badDate } = toPayments(sheet.rows, sheet.map);
    const r = rows.length ? await s.importPayments(rows).catch(() => null) : { added: 0, dup: 0, matched: 0, cancelled: 0, cancelFailed: 0 };
    if (!r) return;
    setSheet(null);
    const extra = [
      r.cancelled > 0 && `환불 ${r.cancelled}건 반영`,
      r.cancelFailed > 0 && `환불 ${r.cancelFailed}건은 출석이 있어 확인 필요`,
      badDate > 0 && `결제 일시를 읽지 못한 ${badDate}행은 건너뜀`,
    ].filter(Boolean).join(' · ');
    toast(`${r.added}건 추가 (중복 ${r.dup}) · 회원 자동 연결 ${r.matched}건${extra ? ' · ' + extra : ''}`);
  };
  /** 회원은 연결됐는데 수강권이 없는 결제: 키오스크 상품명이 어떤 수강권 상품과도 맞지 않았다. */
  const noPass = (p: Payment) => p.status === 'APPROVED' && !!p.memberId && !p.passId;
  const queue = s.payments.filter((p) => p.status === 'APPROVED' && (!p.memberId || !p.passId)).sort((a, b) => b.paidAt.localeCompare(a.paidAt));
  /** 연결 후 수강권이 실제로 생겼는지는 저장소에서 다시 본다(상품명이 안 맞으면 회원만 연결된다). */
  const linked = (paymentId: string, who: string) => {
    const made = !!useStore.getState().payments.find((x) => x.id === paymentId)?.passId;
    toast(made ? `${who}에게 연결, 수강권이 생겼어요` : `${who}에게 연결했지만 상품명이 맞는 수강권 상품이 없어 수강권은 아직 없어요. 설정에서 상품명을 키오스크와 같게 고친 뒤 다시 연결해 주세요`);
  };
  const all = [...s.payments].sort((a, b) => b.paidAt.localeCompare(a.paidAt));
  const name = (id?: string) => s.members.find((m) => m.id === id)?.name;
  const month = s.payments.filter((p) => p.status === 'APPROVED' && dayjs(p.paidAt).format('YYYY-MM') === dayjs().format('YYYY-MM')).reduce((n, p) => n + (p.amount ?? 0), 0);
  const owner = s.me?.role !== 'DESK';

  return (
    <>
      <h1>{owner && <small>이달 결제 {won(month)}</small>}결제</h1>
      <div className="btn-row">
        <button className="btn primary wide" onClick={() => file.current?.click()}><Icon name="upload" size={18} />키오스크 엑셀 올리기</button>
        <button className="btn" onClick={() => setManual(true)}>직접 입력</button>
      </div>
      <input ref={file} type="file" accept=".xlsx,.xls,.csv" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) open(f); e.target.value = ''; }} />
      <p className="sub">키오스크 관리 웹에서 내려받은 결제 내역을 그대로 올리면 돼요. 휴대폰 번호가 같은 회원에게 자동으로 연결되고 수강권이 생겨요. 번호가 안 맞는 결제만 아래에서 직접 골라주면 돼요. <button className="chip" onClick={() => { const b = new Blob(['﻿' + sampleCsv()], { type: 'text/csv' }); const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = 'kiosk-sample.csv'; a.click(); }}>샘플 파일</button></p>

      <div className="seg" style={{ marginTop: 6 }}>
        <button aria-pressed={tab === 'queue'} onClick={() => setTab('queue')}>확인 필요 {queue.length ? `· ${queue.length}` : ''}</button>
        <button aria-pressed={tab === 'all'} onClick={() => setTab('all')}>전체</button>
      </div>

      {tab === 'queue' && (queue.length === 0 ? <div className="empty"><b>확인할 결제가 없어요</b>모든 결제가 회원에게 연결됐어요</div> : (
        <div className="list">
          {queue.map((p) => (
            <button className="row" key={p.id} onClick={() => setAssign(p)}>
              <div className="main"><div className="t">{p.payerName || '이름 없음'} · {p.productName}</div><div className="d">{dayjs(p.paidAt).format('M/D HH:mm')} · {noPass(p) ? `${name(p.memberId) ?? '회원'} 연결됨 · 수강권 상품과 이름이 안 맞아 수강권 없음` : <>{p.payerPhone ? fmtPhone(p.payerPhone) : '번호 없음'}{p.payerPhone && !s.members.some((m) => m.phone === p.payerPhone) && ' · 일치 회원 없음'}</>}</div></div>
              <div className="right">{p.amount !== undefined && <b className="num">{won(p.amount)}</b>}<span className="chip amber">{noPass(p) ? '상품 미확인' : '회원 연결'}</span></div>
            </button>
          ))}
        </div>
      ))}
      {tab === 'all' && (
        <div className="list">
          {all.slice(0, 100).map((p) => (
            <div className="row" key={p.id} style={p.status === 'CANCELLED' ? { opacity: .45 } : undefined}>
              <div className="main"><div className="t">{name(p.memberId) ?? p.payerName ?? '이름 없음'} · {p.productName}</div><div className="d">{dayjs(p.paidAt).format('M/D HH:mm')} · {p.source === 'KIOSK' ? '키오스크' : '수동'}{p.externalId && ` · ${p.externalId}`}{p.status === 'CANCELLED' && ' · 취소'}</div></div>
              <div className="right">{p.amount !== undefined && <b className="num">{won(p.amount)}</b>}{p.memberId ? <>{noPass(p) && <button className="chip amber" onClick={() => setAssign(p)}>상품 미확인</button>}<button className="chip" onClick={() => go('members', p.memberId)}>{name(p.memberId)}</button></> : p.status === 'APPROVED' && <button className="chip amber" onClick={() => setAssign(p)}>회원 연결</button>}</div>
            </div>
          ))}
        </div>
      )}

      {sheet && (
        <Sheet onClose={() => setSheet(null)} title={`${sheet.rows.length}건 불러오기`}>
          <p className="sub">{sheet.name} · 컬럼이 맞게 잡혔는지 확인해 주세요. 한 번 맞추면 다음부터 기억해도 되는 부분이에요.</p>
          {FIELDS.map((f) => (
            <div className="field" key={f.key}><label>{f.label}{f.need && ' *'}</label>
              <select className="input" value={sheet.map[f.key] ?? ''} onChange={(e) => setSheet({ ...sheet, map: { ...sheet.map, [f.key]: e.target.value || undefined } })}>
                <option value="">(없음)</option>{sheet.headers.map((h) => <option key={h} value={h}>{h} — 예: {String(sheet.rows[0][h]).slice(0, 18)}</option>)}
              </select></div>
          ))}
          <button className="btn primary wide" disabled={!sheet.map.paidAt || !sheet.map.amount || !sheet.map.productName} onClick={doImport}>불러오기</button>
        </Sheet>
      )}

      {assign && (
        <Sheet onClose={() => { setAssign(null); setQ(''); setPayerErase(false); }} title="누구의 결제인가요?">
          <p className="sub">{assign.payerName || '이름 없음'} · {assign.productName}{maybeWon(assign.amount, ' · ')}{assign.payerPhone && ` · ${fmtPhone(assign.payerPhone)}`}</p>
          {noPass(assign) && (
            <div className="notice" role="note">
              상품 미확인: {name(assign.memberId) ?? '회원'}에게 연결됐지만 키오스크 상품명 "{assign.productName}" 이 어떤 수강권 상품과도 맞지 않아 수강권이 만들어지지 않았어요. 설정에서 수강권 상품 이름을 키오스크와 똑같이 고친 뒤 다시 연결해 주세요.
              <div style={{ marginTop: 8 }}><button className="btn sm primary" onClick={() => {
                const who = name(assign.memberId) ?? '회원';
                s.assignPayment(assign.id, assign.memberId!).then(() => { setAssign(null); setQ(''); linked(assign.id, who); }, () => {});
              }}>다시 연결</button></div>
            </div>
          )}
          <input className="input" autoFocus placeholder="회원 이름 검색" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="list">
            {s.members.filter((m) => !m.erased).filter((m) => !q.trim() ? (assign.payerName ? m.name.includes(assign.payerName) || m.phone.slice(-4) === assign.payerPhone?.slice(-4) : true) : m.name.includes(q.trim())).slice(0, 8).map((m) => (
              <button className="row" key={m.id} onClick={() => { s.assignPayment(assign.id, m.id).then(() => { setAssign(null); setQ(''); linked(assign.id, m.name); }, () => {}); }}>
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
                  <button className="btn primary wide" onClick={() => { s.erasePayer(assign.id).then(() => { setPayerErase(false); setAssign(null); toast('결제자 정보를 삭제했어요'); }, () => {}); }}>삭제하기</button>
                </div>
              </div>)}
          <div className="btn-row">
            <button className="btn wide" onClick={() => { setAssign(null); go('members'); }}>새 회원으로 등록</button>
            <button className="btn ghost" onClick={() => {
              if (!confirm('이 결제를 취소 처리할까요?')) return;
              s.cancelPayment(assign.id).then((r) => {
                if (r.ok) { setAssign(null); return; }
                toast(`이 수강권으로 출석 ${r.used}회가 있어서 취소할 수 없어요. 출석을 먼저 취소해 주세요`);
              }, () => {});
            }}>취소 처리</button>
          </div>
        </Sheet>
      )}

      {manual && <ManualPay onClose={() => setManual(false)} />}
    </>
  );
}

function ManualPay({ onClose }: { onClose: () => void }) {
  const s = useStore();
  const live = s.members.filter((m) => !m.erased);
  const [memberId, setMemberId] = useState(live[0]?.id ?? '');
  const [productId, setProductId] = useState(s.products[0]?.id ?? '');
  const prod = s.products.find((p) => p.id === productId);
  const [amount, setAmount] = useState(String(prod?.price ?? ''));
  const total = Number(amount) || prod?.price || 0; // DESK 는 상품 가격을 모르니 금액을 직접 넣는다
  return (
    <Sheet onClose={onClose} title="직접 입력 (현금·이체)">
      <div className="field"><label>회원</label><select className="input" value={memberId} onChange={(e) => setMemberId(e.target.value)}>{live.map((m) => <option key={m.id} value={m.id}>{m.name} · {m.memberNo}</option>)}</select></div>
      <div className="field"><label>상품</label><select className="input" value={productId} onChange={(e) => { setProductId(e.target.value); setAmount(String(s.products.find((p) => p.id === e.target.value)?.price ?? '')); }}>{s.products.map((p) => <option key={p.id} value={p.id}>{p.name}{maybeWon(p.price, ' · ')}</option>)}</select></div>
      <div className="field"><label>금액</label><input className="input" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
      <button className="btn primary wide" disabled={!memberId || !prod || !total} onClick={() => {
        const m = s.members.find((x) => x.id === memberId)!;
        s.addPayment({ memberId, productName: prod!.name, amount: total, payerName: m.name, payerPhone: m.phone })
          .then(() => { toast(`${m.name} 결제 등록, 수강권이 생겼어요`); onClose(); }, () => {});
      }}>등록</button>
    </Sheet>
  );
}
