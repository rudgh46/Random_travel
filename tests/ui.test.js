// 볼거리 패널 · 공유 · 필터 기억 · 연속 중복 방지 · 접근성
// 네트워크(날씨)는 이 파일에서 차단해서, 날씨와 무관하게 UI 동작만 본다.
const { weatherReady, landed } = require('./lib/harness');

module.exports = {
  name: 'UI · 공유 · 접근성',
  needsBrowser: true,
  needsNetwork: false,

  async run(t, { browser, url }) {
    const errs = [];
    const watch = page => page.on('pageerror', e => errs.push(e.message));
    // 날씨 API 를 막아 이 스위트를 네트워크와 무관하게 만든다
    const blockWx = ctx => ctx.route('**api.open-meteo.com/**', r => r.abort());

    const ctx = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    await blockWx(ctx);

    // ── 볼거리 ──
    t.section('볼거리 패널');
    const p = await ctx.newPage();
    watch(p);
    await p.goto(url);
    await p.emulateMedia({ reducedMotion: 'reduce' });
    t.ok(!(await p.isVisible('#spots')), '처음엔 닫혀 있다');
    t.ok(!(await p.isVisible('#spotHint')), '목적지 전에는 힌트가 없다');

    await p.click('#go');
    await landed(p);
    const place = (await p.textContent('#flap')).trim();
    t.info(`뽑힌 목적지: ${place}`);
    t.ok(place.length > 0, '목적지가 표시된다');
    t.ok(await p.isVisible('#spotHint'), '착지 후 힌트가 나타난다');
    t.ok(await p.getAttribute('#flap', 'role') === 'button', '지명이 버튼 역할을 갖는다');
    t.ok(await p.getAttribute('#flap', 'tabindex') === '0', '지명이 키보드 포커스를 받는다');

    await p.click('#flap');
    t.ok(await p.isVisible('#spots'), '지명을 누르면 열린다');
    t.ok((await p.textContent('#spotsPlace')).trim() === place, '패널 제목이 목적지와 같다');
    const cards = await p.locator('#spotsList li a').all();
    t.ok(cards.length > 0, `볼거리 카드 ${cards.length}개`);
    const hrefs = await Promise.all(cards.map(a => a.getAttribute('href')));
    t.ok(hrefs.every(h => h.startsWith('https://map.naver.com/p/search/')), '모든 카드가 지도 검색 링크다');
    const rels = await Promise.all(cards.map(a => a.getAttribute('rel')));
    t.ok(rels.every(r => r === 'noopener'), '외부 링크에 noopener 가 붙어 있다');

    await p.click('#flap');
    t.ok(!(await p.isVisible('#spots')), '다시 누르면 접힌다');
    await p.click('#spotHint');
    t.ok(await p.isVisible('#spots'), '힌트 버튼으로도 열린다');
    await p.click('#spotsClose');
    t.ok(!(await p.isVisible('#spots')), '닫기 버튼이 동작한다');

    await p.click('#flap');
    await p.click('#again');
    await landed(p);
    t.ok(!(await p.isVisible('#spots')), '다시 뽑으면 패널이 닫힌다');

    await p.keyboard.press('Tab');   // 포커스를 흘려보내고
    await p.locator('#flap').focus();
    await p.keyboard.press('Enter');
    t.ok(await p.isVisible('#spots'), 'Enter 로 열린다');
    await p.keyboard.press(' ');
    t.ok(!(await p.isVisible('#spots')), 'Space 로 닫힌다');

    // 데이터가 없는 목적지는 검색 카드로 대체
    const fallback = await p.evaluate(() => {
      renderSpots({ n: '없는지역', r: '강원', t: 'gb' });
      return {
        noteShown: !document.getElementById('spotsNote').hidden,
        count: document.querySelectorAll('#spotsList li a').length,
      };
    });
    t.ok(fallback.noteShown, '볼거리가 없으면 안내 문구가 뜬다');
    t.ok(fallback.count === 4, `검색 카드 4개로 대체된다 (${fallback.count}개)`);

    // ── 공유 ──
    t.section('공유');
    const p2 = await ctx.newPage();
    watch(p2);
    await p2.goto(`${url}?to=${encodeURIComponent('경주')}&d=${await p2.evaluate(() => '') || ''}`.replace(/&d=$/, ''));
    await p2.waitForSelector('#passWrap.show');
    t.ok((await p2.textContent('#flap')).trim() === '경주', '링크로 들어오면 승차권이 바로 뜬다');
    t.ok((await p2.textContent('#passPlace')).trim() === '경주', '승차권 목적지가 일치한다');

    const p3 = await ctx.newPage();
    watch(p3);
    await p3.goto(`${url}?to=${encodeURIComponent('없는곳')}`);
    await p3.waitForTimeout(300);
    t.ok(!(await p3.isVisible('#passWrap')), '없는 목적지는 무시한다');

    await p2.evaluate(() => { delete navigator.share; });   // 데스크톱 = 클립보드 경로
    await p2.click('#share');
    await p2.waitForTimeout(300);
    const clip = await p2.evaluate(() => navigator.clipboard.readText());
    t.info(`복사된 링크: ${decodeURIComponent(clip)}`);
    t.ok(/\?to=/.test(clip) && decodeURIComponent(clip).includes('경주'), '공유 링크가 클립보드에 복사된다');
    t.ok(/&d=\d{4}-\d{2}-\d{2}&t=\d{2}%3A\d{2}|&d=\d{4}-\d{2}-\d{2}&t=\d{2}:\d{2}/.test(clip),
      '링크에 출발 일시가 담긴다');
    t.ok((await p2.textContent('#share')).includes('복사'), '복사 피드백이 표시된다');
    await p2.waitForTimeout(1900);
    t.ok((await p2.textContent('#share')).trim() === '공유하기', '피드백이 원래 라벨로 돌아온다');

    await p2.click('#again');
    await landed(p2);
    await p2.waitForTimeout(200);
    const qs = decodeURIComponent(new URL(p2.url()).search);
    const picked2 = (await p2.textContent('#flap')).trim();
    t.info(`주소: ${qs}`);
    t.ok(qs.startsWith(`?to=${picked2}&`) && /&d=\d{4}-\d{2}-\d{2}&t=\d{2}:\d{2}/.test(qs),
      '주소창이 결과·출발일시와 동기화된다');

    // ── 연속 중복 방지 ──
    t.section('연속 중복 방지');
    const p4 = await ctx.newPage();
    watch(p4);
    await p4.goto(url);
    await p4.emulateMedia({ reducedMotion: 'reduce' });
    await p4.selectOption('#region', '수도권근교');
    await p4.selectOption('#budget', '10000');
    t.info(`후보: ${(await p4.textContent('#poolCount')).trim()}`);
    const seq = [];
    for (let i = 0; i < 12; i++) {
      await p4.click('#go');
      await landed(p4);
      seq.push((await p4.textContent('#flap')).trim());
    }
    t.info(`뽑힌 순서: ${seq.join(' → ')}`);
    const backToBack = seq.filter((v, i) => i > 0 && v === seq[i - 1]).length;
    t.ok(backToBack === 0, '바로 연달아 같은 곳이 나오지 않는다');
    t.ok(new Set(seq).size >= 5, `12번 중 서로 다른 곳 ${new Set(seq).size}곳`);

    // ── 필터 기억 ──
    t.section('필터 기억');
    await p4.selectOption('#term', 'hn');
    await p4.selectOption('#dur', '150');
    await p4.waitForTimeout(200);
    const p5 = await ctx.newPage();
    watch(p5);
    await p5.goto(url);
    await p5.waitForTimeout(300);
    const restored = await p5.evaluate(() => ['term', 'region', 'budget', 'dur']
      .map(id => `${id}=${document.getElementById(id).value}`).join(' '));
    t.info(`복원: ${restored}`);
    t.ok(restored === 'term=hn region=수도권근교 budget=10000 dur=150', '새로 열어도 필터가 유지된다');
    const dryPersisted = await p5.isChecked('#dryOnly');
    t.ok(dryPersisted === false, '"비 안 오는 곳만"은 의도적으로 저장하지 않는다');

    // ── 접근성 ──
    t.section('접근성');
    const ctx2 = await browser.newContext();     // 앞 테스트의 필터를 물려받지 않도록
    await blockWx(ctx2);
    const p6 = await ctx2.newPage();
    watch(p6);
    await p6.goto(url);
    t.ok(await p6.getAttribute('.board', 'aria-live') === null, '안내판 전체에 aria-live 가 걸려 있지 않다');
    t.ok(await p6.getAttribute('#poolCount', 'aria-live') === 'polite', '후보 수만 별도 live 영역이다');
    t.ok(await p6.getAttribute('#srStatus', 'role') === 'status', '결과 알림용 status 영역이 있다');
    t.ok((await p6.textContent('#srStatus')).trim() === '', '초기에는 알림이 비어 있다');

    await p6.click('#go');                        // 애니메이션 켜진 상태로 롤링
    await p6.waitForTimeout(400);
    t.ok(await p6.getAttribute('#flap', 'aria-hidden') === 'true', '롤링 중에는 지명이 낭독 대상에서 빠진다');
    await landed(p6);
    t.ok(await p6.getAttribute('#flap', 'aria-hidden') === null, '착지 후 다시 낭독 대상이 된다');
    const st = (await p6.textContent('#srStatus')).trim();
    t.info(`낭독 문구: ${st}`);
    t.ok(/목적지 .+예상 요금 .+소요시간/.test(st), '결과가 한 문장으로 한 번만 안내된다');
    const box = await p6.locator('#srStatus').boundingBox();
    t.ok(box && box.width <= 2 && box.height <= 2, '알림 영역은 시각적으로 숨겨져 있다');

    // ── 레이아웃 ──
    t.section('레이아웃');
    const btns = await p6.evaluate(() => [...document.querySelectorAll('.pass-actions > *')]
      .map(e => ({ t: e.textContent.trim(), y: Math.round(e.getBoundingClientRect().top) })));
    t.info(`버튼: ${btns.map(b => b.t).join(' / ')}`);
    t.ok(new Set(btns.map(b => b.y)).size === 1, '승차권 버튼 3개가 한 줄에 놓인다');

    const mob = await ctx2.newPage();
    watch(mob);
    await mob.setViewportSize({ width: 390, height: 1400 });
    await mob.goto(url);
    await mob.emulateMedia({ reducedMotion: 'reduce' });
    await mob.click('#go');
    await landed(mob);
    await mob.click('#spotHint');
    const overflow = await mob.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    t.ok(!overflow, '모바일 390px 에서 가로 스크롤이 없다');

    t.ok(errs.length === 0, errs.length ? `런타임 에러: ${errs.join(' | ')}` : '런타임 에러 없음');
    await ctx.close(); await ctx2.close();
  },
};
