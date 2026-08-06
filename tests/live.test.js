// TAGO 실제 배차 정보 (/api/tago 프록시)
//
// TAGO_KEY 환경변수가 있어야 돌아갑니다. 없으면 건너뜁니다.
//   Windows PowerShell:  $env:TAGO_KEY="발급받은_인코딩_키"; npm run test:live
//   bash:                TAGO_KEY="발급받은_인코딩_키" npm run test:live
//
// TAGO 는 배차 정보를 오늘·내일까지만 제공합니다. 그 이후 날짜는 0편이 정상이며
// 그때는 실시간 줄이 숨겨지고 계산값("도착 예정")만 남습니다.
const path = require('path');
const { ROOT } = require('./lib/harness');

module.exports = {
  name: 'TAGO 실제 배차',
  needsBrowser: true,
  needsNetwork: true,
  needsFunction: true,

  skipReason() {
    return process.env.TAGO_KEY ? null : 'TAGO_KEY 환경변수가 없습니다';
  },

  async run(t, { browser, url }) {
    const errs = [];
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    p.on('pageerror', e => errs.push(e.message));

    // 실시간 줄이 결론(표시 또는 숨김)에 도달할 때까지 기다린다
    const settle = () => p.waitForFunction(() => {
      const l = document.getElementById('passLive');
      return l.hidden || !l.classList.contains('loading');
    }, null, { timeout: 30000 });

    const read = () => p.evaluate(() => {
      const l = document.getElementById('passLive');
      return { hidden: l.hidden, text: l.textContent.replace(/\s+/g, ' ').trim() };
    });

    t.section('프록시 응답');
    const api = await p.request.get(
      `${url.replace('/index.html', '')}/api/tago?mode=route&depHint=서울경부&arr=대전`);
    t.ok(api.ok(), `/api/tago 가 200 을 준다 (${api.status()})`);
    const body = await api.json();
    t.info(`대전: ${body.count}편, 시도 ${JSON.stringify(body.tried)}`);
    t.ok(body.count > 0, '오늘 대전행 배차를 받아온다');
    t.ok(body.depTerminal && /^NAEK/.test(body.depTerminal.id), `출발 터미널 ID (${body.depTerminal?.id})`);
    t.ok(Array.isArray(body.trips) && body.trips.every(x => typeof x.dep === 'string'),
      'dep/arr 이 문자열로 정규화되어 온다 (숫자면 .length·localeCompare 가 깨진다)');
    t.ok(body.trips.every(x => /^\d{12}$/.test(x.dep)), 'dep 이 YYYYMMDDHHmm 12자리다');

    t.section('이름이 겹치는 터미널 해석');
    // 실제로 "표가 없다"로 보이던 사례들. 회귀하면 사용자에게 그대로 노출된다.
    const route = qs => p.request.get(`${url.replace('/index.html', '')}/api/tago?${qs}`).then(r => r.json());
    const HN = 'depHint=센트럴시티,서울호남&depId=NAEK021';
    const GB = 'depHint=서울경부&depId=NAEK010';
    const cases = [
      ['목포', `${HN}&arr=목포`, 'NAEK505', '센트럴시티가 NAEK020/021 두 개'],
      ['여수', `${HN}&arr=여수`, 'NAEK510', '같은 사유'],
      ['광주', `${HN}&arr=광주`, 'NAEK500', '"광주(유·스퀘어)" 괄호 때문에 광주비아가 이기던 문제'],
      ['전주', `${HN}&arr=전주&arrId=NAEK602`, 'NAEK602', '"전주" 가 NAEK600~604 다섯 개'],
      ['청주', `${GB}&arr=청주`, 'NAEK400', '호남선이 아니라 경부터미널 출발'],
      ['동송', `${GB}&arr=철원`, 'NAEK148', 'TAGO 에 "동송" 이 없고 "철원" 으로 등록됨'],
      ['부산서부', `${GB}&arr=부산사상`, 'NAEK703', 'TAGO 에는 "부산사상" 으로 등록됨'],
    ];
    for (const [label, qs, expectId, why] of cases) {
      const j = await route(`mode=route&${qs}`);
      t.info(`${label}: ${j.count}편 → ${j.arrTerminal?.id} ${j.arrTerminal?.name} (${why})`);
      t.ok(j.count > 0 && j.arrTerminal?.id === expectId,
        `${label} 이 ${expectId} 로 해석되고 노선이 있다`);
    }

    t.section('터미널 ID 고정');
    const pinned = await route(`mode=route&${HN}&arr=광주`);
    t.info(`시도: ${JSON.stringify(pinned.tried)}`);
    t.ok(pinned.tried && pinned.tried.length === 1,
      `depId 를 주면 조합 시도가 1회로 끝난다 (${pinned.tried?.length}회)`);
    const bogus = await route('mode=route&depId=NOT_AN_ID&depHint=서울경부&arr=대전');
    t.ok(bogus.count > 0, '형식이 잘못된 depId 는 무시하고 이름 검색으로 넘어간다');

    t.section('오늘');
    await p.goto(`${url}?to=${encodeURIComponent('대전')}`);
    await p.waitForSelector('#passWrap.show');
    await settle();
    const today = await read();
    t.info(today.hidden ? '(숨김)' : today.text);
    t.ok(!today.hidden, '실시간 줄이 표시된다');
    t.ok(/\d{2}:\d{2}\s*→\s*\d{2}:\d{2}/.test(today.text), '출발 → 도착 시각이 함께 나온다');
    t.ok(/요금/.test(today.text), '요금 범위가 나온다');
    t.ok(/오늘 \d+편|남은 편이 없습니다/.test(today.text), '편수 또는 운행 종료가 안내된다');

    t.section('내일');
    const tomorrow = await p.evaluate(() => {
      const d = new Date(Date.now() + 86400000), pd = n => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pd(d.getMonth() + 1)}-${pd(d.getDate())}`;
    });
    await p.goto(`${url}?to=${encodeURIComponent('대전')}&d=${tomorrow}&t=09:00`);
    await p.waitForSelector('#passWrap.show');
    await settle();
    const tmr = await read();
    t.info(tmr.hidden ? '(숨김)' : tmr.text);
    t.ok(!tmr.hidden, '내일도 배차 정보가 있다');
    t.ok(/첫 출발/.test(tmr.text), '미래 날짜는 "첫 출발" 로 안내한다 ("다음 출발" 은 오늘에만 맞다)');
    t.ok(!/오늘/.test(tmr.text), '"오늘" 이라고 쓰지 않는다');

    t.section('배차 제공 범위를 넘는 날짜');
    const far = await p.evaluate(() => {
      const d = new Date(Date.now() + 5 * 86400000), pd = n => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pd(d.getMonth() + 1)}-${pd(d.getDate())}`;
    });
    await p.goto(`${url}?to=${encodeURIComponent('대전')}&d=${far}&t=09:00`);
    await p.waitForSelector('#passWrap.show');
    await settle();
    const farRes = await read();
    t.ok(farRes.hidden, 'TAGO 범위를 넘으면 실시간 줄을 숨긴다 (오늘·내일까지만 제공)');
    t.ok(await p.isVisible('#passSched'), '계산값 "도착 예정" 줄은 그대로 남는다');
    t.ok(await p.isVisible('#passFare'), '나머지 승차권 정보도 그대로다');

    t.section('프록시 장애 시');
    const ctx2 = await browser.newContext();
    await ctx2.route('**/api/tago**', r => r.abort());
    const p2 = await ctx2.newPage();
    p2.on('pageerror', e => errs.push(e.message));
    await p2.goto(`${url}?to=${encodeURIComponent('강릉')}`);
    await p2.waitForSelector('#passWrap.show');
    await p2.waitForTimeout(2500);
    t.ok(await p2.evaluate(() => document.getElementById('passLive').hidden),
      '프록시가 죽어도 실시간 줄만 조용히 숨긴다');
    t.ok(await p2.isVisible('#passFare'), '승차권은 내장 예상값으로 완성되어 있다');

    t.ok(errs.length === 0, errs.length ? `런타임 에러: ${errs.join(' | ')}` : '런타임 에러 없음');
    await ctx.close(); await ctx2.close();
  },
};
