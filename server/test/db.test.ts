import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db.js';
describe('openDb', () => {
  it('applies migrations once', () => {
    const db = openDb(':memory:');
    const tables = db.prepare("select name from sqlite_master where type='table'").all().map((r: any) => r.name);
    for (const t of ['staff','sessions','members','member_links','instructors','courses','products','payments','passes','attendances','tiers','messages','audit_log','settings','schema_migrations']) expect(tables).toContain(t);
    expect(db.prepare('select count(*) n from schema_migrations').get()).toEqual({ n: 2 });
  });
  it('blocks a second active attendance for the same member, course and day', () => {
    const db = openDb(':memory:');
    db.exec(`insert into members(id,member_no,name,phone,created_at) values('m','2026-0001','김서연','01011112222','2026-10-17T00:00:00Z');
      insert into instructors(id,name,settlement_type,ratio_instructor,per_session_fee) values('i','YUZ','RATIO',50,0);
      insert into courses(id,hall,name,instructor_id,kind,weekday,start_time,duration_min) values('c','HUB','HIPHOP','i','GENERAL',1,'19:25',80);
      insert into products(id,name,pass_kind,count,period_days,price) values('p','정규 8회권','COUNT',8,60,180000);
      insert into passes(id,member_id,product_id,kind,total_count,remaining,valid_from,valid_to,price,created_at) values('s','m','p','COUNT',8,8,'2026-10-01','2026-11-30',180000,'2026-10-01T00:00:00Z');`);
    const ins = "insert into attendances(id,member_id,pass_id,course_id,instructor_id,attended_on,attended_at) values(?,?,?,?,?,?,?)";
    db.prepare(ins).run('a1','m','s','c','i','2026-10-19','2026-10-19T10:30:00Z');
    expect(() => db.prepare(ins).run('a2','m','s','c','i','2026-10-19','2026-10-19T10:31:00Z')).toThrow(/UNIQUE/);
    db.prepare("update attendances set cancelled_at='x' where id='a1'").run();
    expect(() => db.prepare(ins).run('a3','m','s','c','i','2026-10-19','2026-10-19T10:32:00Z')).not.toThrow();
  });
});
