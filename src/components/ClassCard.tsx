import type { Course } from '../types';
import { useStore } from '../store';
import { lvl } from '../lib/labels';

/** 시간표 포스터의 한 칸: 검은 장르 띠 + 큰 강사 이름 + 주황 레벨. */
export function ClassCard({ c, time = true, range = false, pressed, onClick, count, dim }: { c: Course; time?: boolean; range?: boolean; pressed?: boolean; onClick?: () => void; count?: number; dim?: string }) {
  const ins = useStore((s) => s.instructors.find((i) => i.id === c.instructorId)?.name ?? '?');
  const end = (() => { const m = Number(c.startTime.slice(0, 2)) * 60 + Number(c.startTime.slice(3)) + c.durationMin; return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; })();
  const body = (
    <>
      <span className="cc-genre">{c.name}</span>
      <span className="cc-who">{ins}</span>
      <span className="cc-foot">
        {(time || dim) && <span className="cc-time">{dim && <span className="cc-dim">{dim}</span>}{time && (range ? `${c.startTime}–${end}` : c.startTime)}</span>}
        {c.kind === 'PRO' ? <span className="cc-lv">PRO</span> : c.level && <span className="cc-lv">{lvl(c)}</span>}
      </span>
      {count !== undefined && <span className="cc-count num" aria-label={`출석 ${count}명`}>{count}</span>}
    </>
  );
  const cls = `cc hall-${c.hall.toLowerCase()}`;
  return onClick ? <button className={cls} aria-pressed={pressed} onClick={onClick}>{body}</button> : <div className={cls}>{body}</div>;
}
