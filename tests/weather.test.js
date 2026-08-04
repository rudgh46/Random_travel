// 날씨 표시 · 캐시 · 실패 처리 · "비 안 오는 곳만" 필터 · 추천 문구
// Open-Meteo 를 실제로 호출한다. 그날 날씨에 따라 값이 달라지므로
// "숫자가 맞는지"가 아니라 "형식과 동작이 맞는지"만 검사한다.
const { weatherReady, landed, dryStatusSettled } = require('./lib/harness');

module.exports = {
  name: '날씨 · 비 필터 · 추천 문구',
  needsBrowser: true,
  needsNetwork: true,

  async run(t, { browser, url }) {
    const errs = [];
    const watch = page => page.on('pageerror', e => errs.push(e.message));
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    watch(p);
    await p.emulateMedia({ reducedMotion: 'reduce' });

    t.section('승차권 날씨');
    await p.goto(`${url}?to=${encodeURIComponent('강릉')}`);
    await p.waitForSelector('#passWrap.show');
    await weatherReady(p);
    const wx = (await p.textContent('#passWeather')).replace(/\s+/g, ' ').trim();
    t.info(wx);
    t.ok(/\d+°/.test(wx), '기온이 표시된다');
    t.ok(/강수확률\s*\d+%/.test(wx), '강수확률이 표시된다');
    t.ok(await p.isVisible('.wbadge'), '날씨 상태 배지가 있다');
    t.ok(await p.isVisible('.wxtip'), '추천 문구가 있다');
    t.ok(wx.includes('오늘') && wx.includes('지금'), '오늘이면 "오늘"과 "지금 기온"을 보여준다');

    t.section('캐시');
    let calls = 0;
    p.on('request', r => { if (r.url().includes('open-meteo')) calls++; });
    await p.evaluate(() => printPass(DEST.find(x => x.n === '강릉')));
    await p.waitForTimeout(1200);
    t.ok(calls === 0, `같은 목적지·날짜는 재요청하지 않는다 (요청 ${calls}회)`);
    t.ok(!(await p.getAttribute('#passWeather', 'class')).includes('loading'), '캐시는 로딩 표시 없이 즉시 그린다');

    t.section('경합 처리');
    await p.evaluate(() => {
      printPass(DEST.find(x => x.n === '여수'));
      printPass(DEST.find(x => x.n === '목포'));   // 곧바로 다른 목적지
    });
    await p.waitForTimeout(3000);
    t.ok((await p.textContent('#passPlace')).trim() === '목포', '오래된 응답이 최신 카드를 덮지 않는다');

    t.section('실패·예외 처리');
    const ctxOff = await browser.newContext();
    await ctxOff.route('**api.open-meteo.com/**', r => r.abort());
    const pOff = await ctxOff.newPage();
    watch(pOff);
    await pOff.goto(`${url}?to=${encodeURIComponent('경주')}`);
    await pOff.waitForSelector('#passWrap.show');
    await pOff.waitForTimeout(2500);
    t.ok(!(await pOff.isVisible('#passWeather')), '조회 실패 시 날씨 줄만 조용히 숨긴다');
    t.ok(await pOff.isVisible('#passFare'), '나머지 승차권 정보는 그대로 남는다');

    const noCoord = await p.evaluate(() => {
      printPass({ n: '가상터미널', r: '강원', fare: 10000, dur: 100, grade: '우등', t: 'gb' });
      return new Promise(res => setTimeout(() => res(document.getElementById('passWeather').hidden), 600));
    });
    t.ok(noCoord === true, '좌표가 없는 목적지는 날씨 줄을 감춘다');

    t.section('비 안 오는 곳만');
    const p2 = await ctx.newPage();
    watch(p2);
    await p2.goto(url);
    await p2.emulateMedia({ reducedMotion: 'reduce' });
    let batchCalls = 0;
    p2.on('request', r => { if (r.url().includes('open-meteo')) batchCalls++; });

    const num = s => parseInt(s.replace(/[^0-9]/g, ''), 10);
    const before = num(await p2.textContent('#poolCount'));
    await p2.check('#dryOnly');
    await dryStatusSettled(p2);
    const st = (await p2.textContent('#wxStatus')).trim();
    const after = num(await p2.textContent('#poolCount'));
    t.info(`${st}  (${before} → ${after}곳)`);
    t.ok(/제외|비 예보가 없어요/.test(st), '결과가 안내된다');
    t.ok(batchCalls === 1, `전국 조회가 배치 1회로 끝난다 (요청 ${batchCalls}회)`);
    t.ok(after <= before, '후보가 줄거나 같다');

    const verify = await p2.evaluate(() => {
      const iso = depDateVal();
      const wet = DEST.filter(d => !isDry(d, iso)).map(d => d.n);
      const picked = [];
      for (let i = 0; i < 10; i++) { spin(); picked.push(document.getElementById('flap').textContent.trim()); }
      return { wet: wet.length, bad: picked.filter(x => wet.includes(x)) };
    });
    t.ok(verify.bad.length === 0, `뽑힌 곳에 비 예보 지역이 없다 (비 ${verify.wet}곳)`);

    const c1 = batchCalls;
    await p2.uncheck('#dryOnly');
    await p2.waitForTimeout(200);
    t.ok((await p2.textContent('#wxStatus')).trim() === '', '끄면 안내 문구가 사라진다');
    t.ok(num(await p2.textContent('#poolCount')) === before, '끄면 후보 수가 원복된다');
    await p2.check('#dryOnly');
    await dryStatusSettled(p2);
    t.ok(batchCalls === c1, `같은 날짜 재토글은 캐시를 쓴다 (추가 요청 ${batchCalls - c1}회)`);

    const pFail = await ctxOff.newPage();
    watch(pFail);
    await pFail.goto(url);
    await pFail.check('#dryOnly');
    await dryStatusSettled(pFail);
    t.ok(!(await pFail.isChecked('#dryOnly')), '조회 실패 시 토글이 자동 해제된다');
    t.ok((await pFail.textContent('#wxStatus')).includes('불러오지 못'), '실패 이유를 알려준다');
    t.ok(num(await pFail.textContent('#poolCount')) > 0, '후보가 0곳으로 죽지 않는다');

    t.section('추천 문구');
    const tips = await p.evaluate(() => {
      const cases = [
        ['눈', { code: 73, pop: 80, max: 0, min: -5 }, '평창'],
        ['비', { code: 63, pop: 90, max: 20, min: 15 }, '전주'],
        ['추위', { code: 3, pop: 10, max: 2, min: -6 }, '안동'],
        ['더위+해안', { code: 0, pop: 5, max: 33, min: 25 }, '여수'],
        ['더위+내륙', { code: 0, pop: 5, max: 33, min: 25 }, '안동'],
        ['맑음+해안', { code: 0, pop: 5, max: 22, min: 14 }, '양양'],
        ['맑음+내륙', { code: 0, pop: 5, max: 22, min: 14 }, '경주'],
        ['흐림', { code: 3, pop: 20, max: 18, min: 10 }, '경주'],
        ['맑지만 강수확률 높음', { code: 2, pop: 75, max: 20, min: 14 }, '경주'],
      ];
      return cases.map(([label, w, n]) => [label, weatherTip(w, { n })]);
    });
    tips.forEach(([label, tip]) => t.info(`${label} → ${tip}`));
    const byLabel = Object.fromEntries(tips);
    t.ok(byLabel['눈'].includes('온천'), '눈이면 온천을 권한다');
    t.ok(byLabel['비'].includes('실내'), '비면 실내를 권한다');
    t.ok(byLabel['추위'].includes('온천') || byLabel['추위'].includes('실내'), '추우면 실내·온천을 권한다');
    t.ok(byLabel['더위+해안'].includes('바다') && !byLabel['더위+내륙'].includes('바다'),
      '해안 여부에 따라 문구가 달라진다');
    t.ok(byLabel['맑음+해안'].includes('바다'), '맑은 해안은 바다를 권한다');
    t.ok(byLabel['맑지만 강수확률 높음'].includes('실내'),
      '날씨 코드가 맑아도 강수확률이 높으면 실내를 권한다');
    t.ok(new Set(tips.map(x => x[1])).size >= 6, `문구가 상황별로 다양하다 (${new Set(tips.map(x => x[1])).size}종)`);

    t.ok(errs.length === 0, errs.length ? `런타임 에러: ${errs.join(' | ')}` : '런타임 에러 없음');
    await ctx.close(); await ctxOff.close();
  },
};
