import type { Db } from '../db.js';
import { newId } from '../util.js';
import { buildSchedule } from '../../../shared/schedule.js';
export function seedIfEmpty(db: Db) {
  if ((db.prepare('select count(*) n from instructors').get() as { n: number }).n > 0) return false;
  const { instructors, courses } = buildSchedule();
  db.transaction(() => {
    const ins = db.prepare('insert into instructors(id,name,genres,settlement_type,ratio_instructor,per_session_fee) values(?,?,?,?,?,?)');
    for (const i of instructors) ins.run(i.id, i.name, i.crew, i.settlementType, i.ratioInstructor, i.perSessionFee);
    const cs = db.prepare('insert into courses(id,hall,name,instructor_id,kind,level,note,weekday,start_time,duration_min) values(?,?,?,?,?,?,?,?,?,?)');
    for (const c of courses) cs.run(c.id, c.hall, c.name, c.instructorId, c.kind, c.level ?? null, c.note ?? null, c.weekday[0], c.startTime, c.durationMin);
    const pr = db.prepare('insert into products(id,name,course_id,pass_kind,count,period_days,price) values(?,?,null,?,?,?,?)');
    pr.run('p_one', '정규 클래스 1회권', 'COUNT', 1, 7, 30000);
    pr.run('p_four', '정규 클래스 4회권', 'COUNT', 4, 30, 100000);
    pr.run('p_eight', '정규 클래스 8회권', 'COUNT', 8, 60, 180000);
    pr.run('p_pro', '전문반 월정액', 'PERIOD', 12, 30, 350000);
    const t = db.prepare('insert into tiers(id,name,min_count,sort) values(?,?,?,?)');
    [['DEPTH 1', 0], ['DEPTH 2', 10], ['DEPTH 3', 30], ['DEPTH 4', 60]].forEach(([n, m], i) => t.run(newId(), n, m, i));
    db.prepare("insert or replace into settings(key,value) values('studio_name','THE DEPTH'),('needs_real_prices','1')").run();
  })();
  return true;
}
