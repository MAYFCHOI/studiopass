import { useRef, useState } from 'react';
import dayjs from 'dayjs';
import { useStore } from '../store';
import type { Tab } from '../App';
import { fmtPhone, won } from '../lib/util';
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
  const [manual, setManual] = useState(false);
  const [q, setQ] = useState('');
  const file = useRef<HTMLInputElement>(null);

  const open = async (f: File) => {
    const { headers, rows } = await readSheet(f);
    if (!rows.length) { toast('빈 파일이에요'); return; }
    setSheet({ headers, rows, map: guessMapping(headers), name: f.name });
  };
  const doImport = () => {
    if (!sheet) return;
    const r = s.importPayments(toPayments(sheet.rows, sheet.map));
    setSheet(null);
    toast(`${r.added}건 추가 (중복 ${r.dup}) · 자동 배정 ${r.matched}건`);
  };
  const queue = s.payments.filter((p) => p.status === 'APPROVED' && !p.memberId).sort((a, b) => b.paidAt.localeCompare(a.paidAt));
  const all = [...s.payments].sort((a, b) => b.paidAt.localeCompare(a.paidAt));
  const name = (id?: string) => s.members.find((m) => m.id === id)?.name;
  const month = s.payments.filter((p) => p.status === 'APPROVED' && dayjs(p.paidAt).format('YYYY-MM') === dayjs().format('YYYY-MM')).reduce((n, p) => n + p.amount, 0);

  return (
    <>
      <h1><small>이달 결제 {won(month)}</small>결제</h1>
      <div className="btn-row">
        <button className="btn primary wide" onClick={() => file.current?.click()}><Icon name="upload" size={18} />키오스크 엑셀 올리기</button>
        <button className="btn" onClick={() => setManual(true)}>직접 입력</button>
      </div>
      <input ref={file} type="file" accept=".xlsx,.xls,.csv" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) open(f); e.target.value = ''; }} />
      <p className="sub">키오스크 관리 웹에서 내려받은 결제 내역을 그대로 올리면 돼요. 휴대폰 번호가 같은 회원에게 자동으로 배정되고 수강권이 생겨요. <button className="chip" onClick={() => { const b = new Blob(['﻿' + sampleCsv()], { type: 'text/csv' }); const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = 'kiosk-sample.csv'; a.click(); }}>샘플 파일</button></p>

      <div className="seg" style={{ marginTop: 6 }}>
        <button aria-pressed={tab === 'queue'} onClick={() => setTab('queue')}>배정 대기 {queue.length ? `· ${queue.length}` : ''}</button>
        <button aria-pressed={tab === 'all'} onClick={() => setTab('all')}>전체</button>
      </div>

      {tab === 'queue' && (queue.length === 0 ? <div className="empty"><b>배정 대기가 없어요</b>모든 결제가 회원에게 연결됐어요</div> : (
        <div className="list">
          {queue.map((p) => (
            <button className="row" key={p.id} onClick={() => setAssign(p)}>
              <div className="main"><div className="t">{p.payerName || '이름 없음'} · {p.productName}</div><div className="d">{dayjs(p.paidAt).format('M/D HH:mm')} · {p.payerPhone ? fmtPhone(p.payerPhone) : '번호 없음'}{p.payerPhone && !s.members.some((m) => m.phone === p.payerPhone) && ' · 일치 회원 없음'}</div></div>
              <div className="right"><b className="num">{won(p.amount)}</b><span className="chip amber">배정</span></div>
            </button>
          ))}
        </div>
      ))}
      {tab === 'all' && (
        <div className="list">
          {all.slice(0, 100).map((p) => (
            <div className="row" key={p.id} style={p.status === 'CANCELLED' ? { opacity: .45 } : undefined}>
              <div className="main"><div className="t">{name(p.memberId) ?? p.payerName ?? '미배정'} · {p.productName}</div><div className="d">{dayjs(p.paidAt).format('M/D HH:mm')} · {p.source === 'KIOSK' ? '키오스크' : '수동'}{p.externalId && ` · ${p.externalId}`}{p.status === 'CANCELLED' && ' · 취소'}</div></div>
              <div className="right"><b className="num">{won(p.amount)}</b>{p.memberId ? <button className="chip" onClick={() => go('members', p.memberId)}>{name(p.memberId)}</button> : p.status === 'APPROVED' && <button className="chip amber" onClick={() => setAssign(p)}>배정</button>}</div>
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
        <Sheet onClose={() => { setAssign(null); setQ(''); }} title="누구의 결제인가요?">
          <p className="sub">{assign.payerName || '이름 없음'} · {assign.productName} · {won(assign.amount)}{assign.payerPhone && ` · ${fmtPhone(assign.payerPhone)}`}</p>
          <input className="input" autoFocus placeholder="회원 이름 검색" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="list">
            {s.members.filter((m) => !q.trim() ? (assign.payerName ? m.name.includes(assign.payerName) || m.phone.slice(-4) === assign.payerPhone?.slice(-4) : true) : m.name.includes(q.trim())).slice(0, 8).map((m) => (
              <button className="row" key={m.id} onClick={() => { s.assignPayment(assign.id, m.id); setAssign(null); setQ(''); toast(`${m.name}에게 배정, 수강권이 생겼어요`); }}>
                <div className="avatar">{m.name.slice(-2)}</div><div className="main"><div className="t">{m.name}</div><div className="d">{fmtPhone(m.phone)} · {m.memberNo}</div></div>
              </button>
            ))}
          </div>
          <div className="btn-row">
            <button className="btn wide" onClick={() => { setAssign(null); go('members'); }}>새 회원으로 등록</button>
            <button className="btn ghost" onClick={() => { if (confirm('이 결제를 취소 처리할까요?')) { s.cancelPayment(assign.id); setAssign(null); } }}>취소 처리</button>
          </div>
        </Sheet>
      )}

      {manual && <ManualPay onClose={() => setManual(false)} />}
    </>
  );
}

function ManualPay({ onClose }: { onClose: () => void }) {
  const s = useStore();
  const [memberId, setMemberId] = useState(s.members[0]?.id ?? '');
  const [productId, setProductId] = useState(s.products[0]?.id ?? '');
  const prod = s.products.find((p) => p.id === productId);
  const [amount, setAmount] = useState(String(prod?.price ?? ''));
  return (
    <Sheet onClose={onClose} title="직접 입력 (현금·이체)">
      <div className="field"><label>회원</label><select className="input" value={memberId} onChange={(e) => setMemberId(e.target.value)}>{s.members.map((m) => <option key={m.id} value={m.id}>{m.name} · {m.memberNo}</option>)}</select></div>
      <div className="field"><label>상품</label><select className="input" value={productId} onChange={(e) => { setProductId(e.target.value); setAmount(String(s.products.find((p) => p.id === e.target.value)?.price ?? '')); }}>{s.products.map((p) => <option key={p.id} value={p.id}>{p.name} · {won(p.price)}</option>)}</select></div>
      <div className="field"><label>금액</label><input className="input" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
      <button className="btn primary wide" disabled={!memberId || !prod} onClick={() => {
        const m = s.members.find((x) => x.id === memberId)!;
        const r = s.importPayments([{ source: 'MANUAL', paidAt: new Date().toISOString(), amount: Number(amount) || prod!.price, payerName: m.name, payerPhone: m.phone, productName: prod!.name, status: 'APPROVED' }]);
        if (r.matched === 0) { const p = useStore.getState().payments.at(-1); if (p) s.assignPayment(p.id, memberId); }
        toast(`${m.name} 결제 등록, 수강권이 생겼어요`); onClose();
      }}>등록</button>
    </Sheet>
  );
}
