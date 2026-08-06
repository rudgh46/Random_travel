// 누적 뽑기 횟수 카운터.
//
// 가장 중요한 건 "없어도 멀쩡한가" 다. 저장소(Upstash) 환경변수가 없거나 죽어도
// 메인 페이지가 그대로 동작해야 한다. TAGO 프록시와 같은 규약이다.
// 그다음이 숨김 기준 — 집계가 적을 때 한 자리 수가 화면에 찍히면 없는 것보다 나쁘다.
const path = require('path');
const { ROOT } = require('./lib/harness');
const fn = require(path.join(ROOT, 'netlify', 'functions', 'count.js'));

const call = async (q = {}, method = 'GET', headers = {}) => {
  const r = await fn.handler({ httpMethod: method, queryStringParameters: q, headers });
  return { status: r.statusCode, body: JSON.parse(r.body || '{}') };
};

module.exports = {
  name: '뽑기 횟수 카운터',
  needsBrowser: true,
  needsNetwork: false,

  async run(t, { browser, url }) {
    // ── 저장소 미설정 ──
    t.section('저장소가 없을 때');
    const saved = [process.env.UPSTASH_REDIS_REST_URL, process.env.UPSTASH_REDIS_REST_TOKEN];
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;

    const off = await call();
    t.ok(off.status === 200, `설정이 없어도 200 으로 답한다 (${off.status})`);
    t.ok(off.body.enabled === false, 'enabled:false 를 돌려준다');
    t.ok(off.body.total === undefined, '숫자를 만들어내지 않는다');
    const offPost = await call({ to: '강릉' }, 'POST');
    t.ok(offPost.body.enabled === false, '기록 요청도 조용히 비활성으로 답한다');

    // ── 표시 기준 ──
    // 기준 미달이면 total 자체를 내려보내지 않는다. 프론트에서 감추는 방식이면
    // 개발자도구에 보이는 값과 화면이 달라진다.
    t.section(`표시 기준 (${fn.SHOW_FROM}회)`);
    t.ok(fn.SHOW_FROM >= 100, `기준이 충분히 높다 (${fn.SHOW_FROM})`);
    const low = fn.shape(fn.SHOW_FROM - 1, ['강릉', '5']);
    t.ok(low.visible === false, '기준 미달이면 visible:false');
    t.ok(low.total === undefined, '기준 미달이면 숫자를 아예 내려보내지 않는다');
    const hi = fn.shape(fn.SHOW_FROM, ['강릉', '42']);
    t.ok(hi.visible === true && hi.total === fn.SHOW_FROM, '기준을 채우면 숫자가 실린다');
    t.ok(hi.top && hi.top.n === '강릉' && hi.top.count === 42, '최다 목적지가 함께 실린다');
    t.ok(fn.shape(null, null).visible === false, '집계가 아예 없어도 터지지 않는다');
    t.ok(fn.shape(fn.SHOW_FROM, null).top === null, '최다 목적지가 없으면 null 이다');

    // ── 목적지 이름 검증 ──
    // 이 값이 Redis 키에 들어가므로 길이와 문자를 막는다.
    t.section('목적지 이름 검증');
    t.ok(fn.cleanName('강릉') === '강릉', '정상 이름은 통과');
    t.ok(fn.cleanName('고한·사북') === '고한·사북', '중점이 든 이름도 통과');
    t.ok(fn.cleanName('  강릉  ') === '강릉', '앞뒤 공백을 다듬는다');
    t.ok(fn.cleanName('강릉\nDEL key') === null, '개행이 든 값은 거부한다');
    t.ok(fn.cleanName('a'.repeat(50)) === null, '지나치게 긴 값은 거부한다');
    t.ok(fn.cleanName('') === null && fn.cleanName(null) === null && fn.cleanName(123) === null,
      '빈 값·다른 자료형은 거부한다');
    t.ok(fn.cleanName('<script>') === null, '태그 문자는 거부한다');

    // ── 브라우저: 카운터가 없어도 사이트가 멀쩡한가 ──
    t.section('집계 없이 열었을 때');
    const ctx = await browser.newContext();
    await ctx.route('**api.open-meteo.com/**', r => r.abort());
    const errs = [];
    const p = await ctx.newPage();
    p.on('pageerror', e => errs.push(e.message));
    await p.goto(url);                       // 로컬 서버에는 /api/count 가 없다 → 404
    await p.emulateMedia({ reducedMotion: 'reduce' });
    await p.waitForTimeout(400);
    t.ok(!(await p.isVisible('#tally')), '집계를 못 받으면 줄이 보이지 않는다');
    await p.click('#go');
    await p.waitForFunction(() => !document.getElementById('go').disabled, null, { timeout: 15000 });
    t.ok((await p.textContent('#flap')).trim().length > 0, '뽑기는 정상 동작한다');
    t.ok(!(await p.isVisible('#tally')), '뽑은 뒤에도 줄이 나타나지 않는다');
    t.ok(errs.length === 0, errs.length ? `런타임 에러: ${errs.join(' | ')}` : '런타임 에러 없음');
    await ctx.close();

    // ── 브라우저: 집계가 충분할 때 ──
    t.section('집계가 충분할 때');
    const ctx2 = await browser.newContext();
    await ctx2.route('**api.open-meteo.com/**', r => r.abort());
    let posted = null;
    await ctx2.route('**/api/count*', route => {
      const req = route.request();
      if (req.method() === 'POST') posted = new URL(req.url()).searchParams.get('to');
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ enabled: true, visible: true, total: 12847, top: { n: '강릉', count: 903 } }),
      });
    });
    const p2 = await ctx2.newPage();
    p2.on('pageerror', e => errs.push(e.message));
    await p2.goto(url);
    await p2.emulateMedia({ reducedMotion: 'reduce' });
    await p2.waitForFunction(() => {
      const el = document.getElementById('tally');
      return el && !el.hidden;
    }, null, { timeout: 8000 });
    const txt = (await p2.textContent('#tally')).replace(/\s+/g, ' ').trim();
    t.info(`표시: ${txt}`);
    t.ok(txt.includes('12,847'), '천 단위 구분기호가 들어간다');
    t.ok(txt.includes('강릉'), '최다 목적지가 표시된다');

    await p2.click('#go');
    await p2.waitForFunction(() => !document.getElementById('go').disabled, null, { timeout: 15000 });
    const picked = (await p2.textContent('#flap')).trim();
    await p2.waitForTimeout(300);
    t.info(`기록 요청: to=${posted}`);
    t.ok(posted === picked, `뽑은 목적지가 기록 요청에 담긴다 (${posted})`);

    // 공유 링크 진입은 뽑기가 아니므로 세지 않는다
    posted = null;
    const p3 = await ctx2.newPage();
    p3.on('pageerror', e => errs.push(e.message));
    await p3.goto(`${url}?to=${encodeURIComponent('경주')}`);
    await p3.waitForSelector('#passWrap.show');
    await p3.waitForTimeout(400);
    t.ok(posted === null, '공유 링크로 들어온 것은 뽑기로 세지 않는다');

    // ── 집계가 비활성이면 즉시 감춘다 ──
    t.section('저장소가 도중에 죽으면');
    await ctx2.unroute('**/api/count*');
    await ctx2.route('**/api/count*', route => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({ enabled: false }),
    }));
    const p4 = await ctx2.newPage();
    p4.on('pageerror', e => errs.push(e.message));
    await p4.goto(url);
    await p4.waitForTimeout(500);
    t.ok(!(await p4.isVisible('#tally')), 'enabled:false 면 줄을 그리지 않는다');
    t.ok(errs.length === 0, errs.length ? `런타임 에러: ${errs.join(' | ')}` : '런타임 에러 없음');
    await ctx2.close();

    if (saved[0]) process.env.UPSTASH_REDIS_REST_URL = saved[0];
    if (saved[1]) process.env.UPSTASH_REDIS_REST_TOKEN = saved[1];
  },
};
