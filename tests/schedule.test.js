// 출발일·출발 시각 · 도착 예정 시각 계산 · 날짜별 날씨 · 링크 복원
const { weatherReady, landed, dryStatusSettled } = require('./lib/harness');

module.exports = {
  name: '출발 일시 · 도착 예정',
  needsBrowser: true,
  needsNetwork: true,

  async run(t, { browser, url }) {
    const errs = [];
    const watch = page => page.on('pageerror', e => errs.push(e.message));
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    watch(p);
    await p.goto(url);
    await p.emulateMedia({ reducedMotion: 'reduce' });

    t.section('기본값과 선택 범위');
    const init = await p.evaluate(() => {
      const d = document.getElementById('depDate'), tm = document.getElementById('depTime');
      return {
        val: d.value, min: d.min, max: d.max,
        span: (new Date(d.max) - new Date(d.min)) / 86400000,
        time: tm.value, step: tm.step,
      };
    });
    t.info(JSON.stringify(init));
    t.ok(init.val === init.min, '출발일 기본값이 오늘이다');
    t.ok(init.span === 15, `선택 범위가 오늘+15일이다 (Open-Meteo 예보 한계, ${init.span}일)`);
    t.ok(/^\d{2}:(00|30)$/.test(init.time), `출발 시각 기본값이 30분 단위다 (${init.time})`);
    t.ok(init.step === '1800', '시각 입력이 30분 간격이다');

    t.section('도착 시각 계산');
    const calc = await p.evaluate(() => {
      const cases = [
        ['09:00', 160], ['23:30', 160], ['22:00', 299], ['06:00', 52], ['00:10', 30],
      ];
      return cases.map(([hm, dur]) => {
        const a = arrivalOf('2026-08-08', hm, dur);
        return { hm, dur, arr: a.hm, day: a.dayDiff };
      });
    });
    calc.forEach(c => t.info(`${c.hm} + ${c.dur}분 → ${c.arr} (dayDiff=${c.day})`));
    const find = hm => calc.find(c => c.hm === hm);
    t.ok(find('09:00').arr === '11:40' && find('09:00').day === 0, '09:00 + 2시간40분 = 11:40');
    t.ok(find('23:30').arr === '02:10' && find('23:30').day === 1, '자정을 넘기면 익일로 계산한다');
    t.ok(find('22:00').arr === '02:59' && find('22:00').day === 1, '장거리 심야도 정확하다');
    t.ok(find('06:00').arr === '06:52' && find('06:00').day === 0, '단거리도 정확하다');
    t.ok(find('00:10').arr === '00:40' && find('00:10').day === 0, '자정 직후도 같은 날로 본다');

    t.section('승차권 표시');
    await p.selectOption('#region', '강원');
    await p.fill('#depDate', '2026-08-08');
    await p.fill('#depTime', '09:00');
    await p.click('#go');
    await p.waitForSelector('#passWrap.show');
    const sched = (await p.textContent('#passSched')).replace(/\s+/g, ' ').trim();
    t.info(sched);
    t.ok(/8\/8\(토\)/.test(sched), '날짜와 요일이 표시된다');
    t.ok(/09:00.*→.*\d{2}:\d{2}/.test(sched), '출발 → 도착 시각이 표시된다');
    t.ok(sched.includes('도착 예정'), '계산값이므로 "예정"으로 표기한다');

    t.section('날짜별 날씨');
    await weatherReady(p);
    const future = (await p.textContent('#passWeather')).replace(/\s+/g, ' ').trim();
    t.info(future);
    t.ok(future.includes('8/8'), '배지에 선택한 날짜가 나온다');
    t.ok(!future.includes('지금'), '미래 날짜에는 의미 없는 "지금 기온"을 숨긴다');
    t.ok(/강수확률\s*\d+%/.test(future), '그 날짜의 강수확률이 나온다');

    await p.fill('#depDate', init.min);
    await weatherReady(p);
    const today = (await p.textContent('#passWeather')).replace(/\s+/g, ' ').trim();
    t.ok(today.includes('오늘') && today.includes('지금'), '오늘로 되돌리면 "오늘 · 지금 기온"이 돌아온다');

    t.section('날짜 변경 시 갱신');
    const before = (await p.textContent('#passSched')).trim();
    await p.fill('#depDate', '2026-08-10');
    await p.waitForTimeout(400);
    const after = (await p.textContent('#passSched')).trim();
    t.ok(before !== after && after.includes('8/10'), '카드가 새 날짜로 갱신된다');
    t.ok(await p.isVisible('#passWrap'), '카드를 다시 인쇄하지 않고 유지한다');

    t.section('비 필터 — 날짜 기준');
    let calls = 0;
    p.on('request', r => { if (r.url().includes('open-meteo')) calls++; });
    await p.check('#dryOnly');
    await dryStatusSettled(p, '8/10');
    t.info(`${(await p.textContent('#wxStatus')).trim()} | ${(await p.textContent('#poolCount')).trim()}`);
    t.ok(/8\/10/.test(await p.textContent('#wxStatus')), '선택한 날짜 기준으로 안내된다');

    const c1 = calls;
    await p.fill('#depDate', '2026-08-12');
    await dryStatusSettled(p, '8/12');
    t.info(`${(await p.textContent('#wxStatus')).trim()} | ${(await p.textContent('#poolCount')).trim()}`);
    t.ok(/8\/12/.test(await p.textContent('#wxStatus')), '날짜를 바꾸면 그 날짜로 다시 걸러낸다');
    t.ok(calls - c1 >= 1, `새 날짜는 새로 조회한다 (요청 ${calls - c1}회)`);

    const verify = await p.evaluate(() => {
      const iso = depDateVal();
      const wet = DEST.filter(d => !isDry(d, iso)).map(d => d.n);
      const picked = [];
      for (let i = 0; i < 8; i++) { spin(); picked.push(document.getElementById('flap').textContent.trim()); }
      return { wet: wet.length, bad: picked.filter(x => wet.includes(x)) };
    });
    t.ok(verify.bad.length === 0, `뽑힌 곳에 비 예보 지역이 없다 (비 ${verify.wet}곳)`);

    t.section('링크에 일시 포함·복원');
    await p.uncheck('#dryOnly');
    await p.fill('#depDate', '2026-08-09');
    await p.fill('#depTime', '07:30');
    await p.click('#again');
    await landed(p);
    await p.waitForTimeout(300);
    t.info(`주소: ${decodeURIComponent(p.url().split('?')[1] || '')}`);
    t.ok(p.url().includes('d=2026-08-09'), '주소창에 날짜가 반영된다');

    const p2 = await ctx.newPage();
    watch(p2);
    await p2.goto(`${url}?to=${encodeURIComponent('여수')}&d=2026-08-09&t=07:30`);
    await p2.waitForSelector('#passWrap.show');
    const restored = await p2.evaluate(() => ({
      d: document.getElementById('depDate').value,
      t: document.getElementById('depTime').value,
      s: document.getElementById('passSched').textContent.replace(/\s+/g, ' ').trim(),
    }));
    t.info(JSON.stringify(restored));
    t.ok(restored.d === '2026-08-09' && restored.t === '07:30', '링크로 들어오면 일시가 복원된다');
    t.ok(restored.s.includes('8/9') && restored.s.includes('07:30'), '복원된 일시로 카드가 그려진다');

    t.section('잘못된 링크 값 방어');
    const p3 = await ctx.newPage();
    watch(p3);
    await p3.goto(`${url}?to=${encodeURIComponent('경주')}&d=1999-01-01&t=99:99`);
    await p3.waitForSelector('#passWrap.show');
    const guard = await p3.evaluate(() => ({
      d: document.getElementById('depDate').value,
      t: document.getElementById('depTime').value,
    }));
    t.info(JSON.stringify(guard));
    t.ok(guard.d !== '1999-01-01', '범위 밖 날짜는 무시한다');
    // \d{2}:\d{2} 만 검사하면 "99:99" 가 통과해 브라우저가 값을 거부하고 칸이 비어버린다
    t.ok(/^([01]\d|2[0-3]):[0-5]\d$/.test(guard.t), `잘못된 시각은 기본값으로 되돌린다 (${guard.t})`);

    t.ok(errs.length === 0, errs.length ? `런타임 에러: ${errs.join(' | ')}` : '런타임 에러 없음');
    await ctx.close();
  },
};
