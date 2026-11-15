// Replace the sample catalog in a fresh DB with the studio's real products/courses/instructors (no member data).
const D = require(process.env.ROOT + '/server/node_modules/better-sqlite3');
const cat = require(process.argv[3]);
const db = new D(process.argv[2]);
db.transaction(() => {
  for (const t of ['products', 'courses', 'instructors', 'tiers']) db.prepare(`delete from ${t}`).run();
  for (const t of ['instructors', 'courses', 'products', 'tiers']) for (const r of cat[t]) {
    const k = Object.keys(r); db.prepare(`insert into ${t}(${k.join(',')}) values(${k.map(() => '?').join(',')})`).run(...k.map((x) => r[x]));
  }
  db.prepare("insert into settings(key,value) values('needs_real_prices','0') on conflict(key) do update set value='0'").run();
})();
console.log('catalog', cat.products.length, 'products');
