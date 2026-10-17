import { useCallback, useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import logo from '../assets/logo-mark.png'

interface MemberData {
  studioName: string
  name: string
  since: string
  attendCount: number
  tier: { name: string; level: number; count: number; nextName: string | null; nextAt: number | null }
  tiers: { name: string; minCount: number }[]
  passes: { name: string; remaining: number; total: number; validTo: string; kind: string }[]
  qr: string
}

type State =
  | { kind: 'loading' }
  | { kind: 'ok'; data: MemberData }
  | { kind: 'notfound' }
  | { kind: 'offline'; cached: MemberData | null }

const POLL_MS = 30_000

function tokenFromPath(): string {
  const m = /^\/m\/([^/?#]+)/.exec(location.pathname)
  return m ? decodeURIComponent(m[1]) : ''
}

function readCache(token: string): MemberData | null {
  try {
    const raw = localStorage.getItem('sp-member-' + token)
    return raw ? (JSON.parse(raw) as MemberData) : null
  } catch {
    return null
  }
}

function writeCache(token: string, data: MemberData) {
  try {
    localStorage.setItem('sp-member-' + token, JSON.stringify(data))
  } catch {
    /* 저장소를 못 써도 화면은 그대로 */
  }
}

const mdot = (iso: string) => {
  const [, m, d] = iso.split('-')
  return `${Number(m)}.${Number(d)}`
}

function Qr({ value }: { value: string }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    if (ref.current) QRCode.toCanvas(ref.current, value, { margin: 0, width: 520, errorCorrectionLevel: 'M' }).catch(() => {})
  }, [value])
  return (
    <div className="qr">
      <canvas ref={ref} role="img" aria-label="출석 QR" />
    </div>
  )
}

function Top({ level, name }: { level?: number; name?: string }) {
  return (
    <div className="top">
      <img className="mark" src={logo} alt="" />
      {name !== undefined && (
        <div className="depth">
          {[1, 2, 3, 4].map((n) => (
            <i key={n} className={n <= (level ?? 0) ? 'on' : ''} />
          ))}
          <span>{name}</span>
        </div>
      )}
    </div>
  )
}

export function MemberPage() {
  const token = tokenFromPath()
  const [state, setState] = useState<State>({ kind: 'loading' })

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/public/m/' + encodeURIComponent(token), { cache: 'no-store' })
      if (res.status === 404) return setState({ kind: 'notfound' })
      if (!res.ok) throw new Error(String(res.status))
      const data = (await res.json()) as MemberData
      writeCache(token, data)
      setState({ kind: 'ok', data })
    } catch {
      setState({ kind: 'offline', cached: readCache(token) })
    }
  }, [token])

  useEffect(() => {
    const first = setTimeout(load, 0)
    const tick = () => {
      if (document.visibilityState === 'visible') load()
    }
    const id = setInterval(tick, POLL_MS)
    document.addEventListener('visibilitychange', tick)
    return () => {
      clearTimeout(first)
      clearInterval(id)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [load])

  useEffect(() => {
    let lock: WakeLockSentinel | null = null
    const acquire = () => {
      if (document.visibilityState !== 'visible') return
      navigator.wakeLock?.request('screen').then((l) => { lock = l }).catch(() => {})
    }
    acquire()
    document.addEventListener('visibilitychange', acquire)
    return () => {
      document.removeEventListener('visibilitychange', acquire)
      lock?.release().catch(() => {})
    }
  }, [])

  if (state.kind === 'loading') {
    return <main className="screen"><Top /></main>
  }
  if (state.kind === 'notfound') {
    return (
      <main className="screen">
        <Top />
        <p className="msg">이 링크는 더 이상 쓸 수 없어요. 데스크에서 새 링크를 받아주세요</p>
      </main>
    )
  }
  if (state.kind === 'offline') {
    const c = state.cached
    return (
      <main className="screen">
        <Top />
        {c ? <Qr value={c.qr} /> : null}
        {c ? <div className="hint">데스크에서 이 QR 을 보여주세요</div> : null}
        <p className={c ? 'offline' : 'msg'}>인터넷에 연결되면 다시 열어주세요</p>
      </main>
    )
  }

  const d = state.data
  const t = d.tier
  const [y, mo, da] = d.since.split('-')
  return (
    <main className="screen">
      <Top level={t.level} name={t.name} />
      <div className="name">{d.name}</div>
      <div className="since num">{`${y}.${mo}.${da} 등록 · 출석 ${d.attendCount}회째`}</div>
      <Qr value={d.qr} />
      <div className="hint">데스크에서 이 QR 을 보여주세요</div>
      {t.nextName && t.nextAt != null && (
        <div className="next num">{`${t.nextName} 까지 ${Math.max(0, t.nextAt - t.count)}회`}</div>
      )}
      <div className="passes">
        {d.passes.length === 0 ? (
          <div className="nopass">지금 쓸 수 있는 수강권이 없어요. 데스크에 문의해 주세요</div>
        ) : (
          d.passes.map((p, i) => (
            <div className="pass" key={i}>
              <div className="what">{p.name}</div>
              <div className="until num">{mdot(p.validTo)}까지</div>
              <div className="left"><b className="num">{p.remaining}</b>회 남음</div>
            </div>
          ))
        )}
      </div>
    </main>
  )
}
