import { useState } from 'react';
import type { Course, Hall } from '../types';
import { useStore } from '../store';
import { ClassCard } from './ClassCard';
import { HALL_NAME } from '../lib/labels';

const DAYS: { wd: number; l: string }[] = [{ wd: 1, l: 'M' }, { wd: 2, l: 'T' }, { wd: 3, l: 'W' }, { wd: 4, l: 'T' }, { wd: 5, l: 'F' }, { wd: 6, l: 'S' }, { wd: 0, l: 'S' }];

/** 홀별 주간 시간표. 포스터와 같은 배치: 요일 = 열, 시작 시각 = 행. 시각이 다른 칸(예: 21:30)은 같은 줄 가장 가까운 행에 붙는다. */
export function Timetable({ onPick }: { onPick?: (c: Course) => void }) {
  const courses = useStore((s) => s.courses);
  const [hall, setHall] = useState<Hall>('HUB');
  const mine = courses.filter((c) => c.hall === hall);
  const isWeekend = (c: Course) => c.weekday.every((d) => d === 0 || d === 6);
  const week = mine.filter((c) => !isWeekend(c));
  const weekend = mine.filter(isWeekend).sort((a, b) => a.weekday[0] === b.weekday[0] ? a.startTime.localeCompare(b.startTime) : a.weekday[0] === 6 ? -1 : 1);
  const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
  // 행 = 시작 시각 묶음. 45분 안쪽 차이는 같은 행(예: 20:50 줄의 21:30 수업)
  const rows: number[] = [];
  [...new Set(week.map((c) => toMin(c.startTime)))].sort((a, b) => a - b).forEach((m) => { if (!rows.some((r) => Math.abs(r - m) < 45)) rows.push(m); });
  const rowOf = (c: Course) => rows.reduce((b, r) => (Math.abs(r - toMin(c.startTime)) < Math.abs(b - toMin(c.startTime)) ? r : b), rows[0]);
  const hhmm = (m: number) => `${Math.floor(m / 60) > 12 ? Math.floor(m / 60) - 12 : Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
  const days = DAYS.filter((d) => d.wd >= 1 && d.wd <= 5);
  return (
    <div className={`tt hall-${hall.toLowerCase()}`}>
      <div className="tt-head">
        <div className="tt-title"><i>~ Regular Class ~</i><b>{hall}</b><span>HALL</span></div>
        <div className="seg">{(['HUB', 'LAB'] as Hall[]).map((h) => <button key={h} aria-pressed={h === hall} onClick={() => setHall(h)}>{HALL_NAME[h]}</button>)}</div>
      </div>
      <div className="tt-scroll">
        <div className="tt-grid" style={{ gridTemplateColumns: `repeat(${days.length}, minmax(60px, 1fr))` }}>
          {days.map((d) => <div key={d.wd} className="tt-day">{d.l}</div>)}
          {rows.map((r) => {
            const inRow = week.filter((c) => rowOf(c) === r);
            const note = inRow.find((c) => c.note)?.note;
            const lv = inRow.every((c) => c.level === inRow[0]?.level) && inRow[0]?.level === '0' ? ' LV.0' : '';
            return [
              <div key={'t' + r} className="tt-time" style={{ gridColumn: `1 / -1` }}>
                {note && <em>{note}{lv}</em>}
                <b className="num">{hhmm(r)}~{hhmm(r + Math.max(...inRow.map((c) => c.durationMin)))}</b>
              </div>,
              ...days.map((d) => {
                const c = inRow.find((x) => x.weekday.includes(d.wd));
                return c ? <ClassCard key={r + '-' + d.wd} c={c} time={toMin(c.startTime) !== r} onClick={onPick ? () => onPick(c) : undefined} /> : <div key={r + '-' + d.wd} className="cc empty" aria-hidden />;
              }),
            ];
          })}
        </div>
      </div>
      {weekend.length > 0 && (
        <div className="tt-weekend">
          <div className="tt-time"><b className="num">SAT · SUN</b></div>
          <div className="tt-wk">{weekend.map((c) => <ClassCard key={c.id} c={c} dim={'일월화수목금토'[c.weekday[0]] + '요일'} onClick={onPick ? () => onPick(c) : undefined} />)}</div>
        </div>
      )}
    </div>
  );
}
