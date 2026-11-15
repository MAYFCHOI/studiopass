import { chromium } from 'playwright-core';
const OUT = process.argv[2]; const O = 'http://localhost:8091';
const b = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const W = { width: 1180, height: 820 };
async function session(id, viewport = W) {
  const ctx = await b.newContext({ viewport, deviceScaleFactor: 1.5, locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
  const pg = await ctx.newPage();
  await pg.goto(O); await pg.waitForTimeout(600);
  if (id) { await pg.fill('input >> nth=0', id); await pg.fill('input[type=password]', 'guide-password-1'); await pg.keyboard.press('Enter'); await pg.waitForTimeout(1200); }
  return pg;
}
const wait = (pg, ms = 700) => pg.waitForTimeout(ms);
const shot = async (pg, name, o = {}) => { await pg.screenshot({ path: `${OUT}/${name}.jpg`, type: 'jpeg', quality: 78, ...o }); console.log(name); };
const sheetShot = async (pg, name) => { await pg.locator('.sheet').screenshot({ path: `${OUT}/${name}.jpg`, type: 'jpeg', quality: 80 }); console.log(name); };
const go = async (pg, h) => { await pg.goto(`${O}/#/${h}`); await wait(pg, 1000); };
// 카메라 자리는 테스트 패턴이 나와 보기 흉하니 어둡게 가린다(안내용).
const hideCam = (pg) => pg.addStyleTag({ content: 'video{opacity:0!important}' });

// ---- 로그인 (인포)
let pg = await session(null);
await pg.fill('input >> nth=0', 'desk'); await pg.fill('input[type=password]', 'guide-password-1');
await shot(pg, '01-login');
await pg.keyboard.press('Enter'); await wait(pg, 1200);
await shot(pg, '02-today');
// ---- 출석
await go(pg, 'scan'); await hideCam(pg);
await shot(pg, '03-scan');
const search = pg.locator('input[placeholder^="이름"]');
await search.fill('유나'); await wait(pg); await pg.evaluate(() => { document.querySelector('input[placeholder^="이름"]').scrollIntoView({ block: 'start' }); window.scrollBy(0, -140); }); await wait(pg, 300);
await shot(pg, '04-scan-search');
await pg.locator('button.row', { hasText: '정유나' }).first().click(); await wait(pg, 900);
await shot(pg, '05-scan-ok');
await pg.getByRole('button', { name: '다음 사람' }).click(); await wait(pg);
await search.fill('도윤'); await wait(pg); await pg.locator('button.row', { hasText: '이도윤' }).first().click(); await wait(pg, 900);
await shot(pg, '06-scan-fail');
await pg.getByRole('button', { name: '다음 사람' }).click(); await wait(pg);
// ---- 회원
await go(pg, 'members'); await shot(pg, '07-members');
await pg.getByRole('button', { name: '새 회원' }).click(); await wait(pg);
const f = pg.locator('.sheet input, [role=dialog] input');
await f.nth(0).fill('윤가람'); await f.nth(1).fill('010-2025-0007'); await wait(pg, 300);
await sheetShot(pg, '08-member-new');
await pg.reload(); await wait(pg, 1000);
await go(pg, 'members'); await pg.locator('button.row', { hasText: '김하늘' }).first().click(); await wait(pg, 900);
await shot(pg, '09-member-card');
// ---- 결제
await go(pg, 'payments'); await shot(pg, '10-payments');
await pg.locator('.row', { hasText: 'WARM UP TRAINING' }).first().click(); await wait(pg);
await pg.locator('input[placeholder="손님 이름"]').fill('서다인'); await wait(pg, 300);
await sheetShot(pg, '11-dropin-name');
await pg.reload(); await wait(pg, 1000);
await go(pg, 'payments'); await pg.locator('.row', { hasText: 'YODA' }).first().click(); await wait(pg);
await pg.locator('input[placeholder^="회원 이름"]').fill('민준'); await wait(pg, 400);
await sheetShot(pg, '12-link-member');
await pg.reload(); await wait(pg, 1000);
await go(pg, 'payments'); await pg.getByRole('button', { name: '현금·이체 결제 넣기' }).click(); await wait(pg);
await pg.getByRole('button', { name: '계좌이체' }).click();
await pg.locator('select').first().selectOption({ label: 'HILLY' }).catch(async () => { const v = await pg.locator('select option', { hasText: 'HILLY' }).first().getAttribute('value'); await pg.locator('select').first().selectOption(v); });
await pg.locator('input[placeholder="원"]').fill('130000');
await pg.locator('input[placeholder^="회원 이름"]').fill('서연'); await wait(pg, 400);
await pg.locator('button.row', { hasText: '박서연' }).first().click(); await wait(pg, 400);
await sheetShot(pg, '13-cash');
await pg.context().close();

// ---- 원장: 정산, 설정
pg = await session('owner');
await go(pg, 'settle'); await shot(pg, '14-settle');
await go(pg, 'settings'); await shot(pg, '15-settings');
await pg.locator('button.row', { hasText: '(1 TICKET) HILLY' }).first().click(); await wait(pg);
await sheetShot(pg, '16-product-dropin');
await pg.context().close();

// ---- 회원 페이지 (휴대폰)
const ctx = await b.newContext({ viewport: { width: 390, height: 780 }, deviceScaleFactor: 2, locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
const ph = await ctx.newPage();
const login = await fetch(O + '/api/auth/login', { method: 'POST', headers: { origin: O, 'content-type': 'application/json' }, body: JSON.stringify({ loginId: 'owner', password: 'guide-password-1' }) });
const ck = login.headers.get('set-cookie').split(';')[0];
const boot = await (await fetch(O + '/api/bootstrap', { headers: { origin: O, cookie: ck } })).json();
const m = boot.members.find((x) => x.name === '김하늘');
const { url } = await (await fetch(`${O}/api/members/${m.id}/link`, { method: 'POST', headers: { origin: O, cookie: ck } })).json();
await ph.goto(url); await ph.waitForTimeout(1500);
await ph.screenshot({ path: `${OUT}/17-member-page.jpg`, type: 'jpeg', quality: 80 }); console.log('17-member-page');
await b.close();
