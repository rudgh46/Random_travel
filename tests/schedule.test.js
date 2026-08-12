// 출발일·출발 시각 · 도착 예정 시각 계산 · 날짜별 날씨 · 링크 복원
//
// 날짜는 반드시 오늘 기준으로 계산한다. 예전에는 '2026-08-12' 처럼 박아 두었는데,
// 달이 넘어가면서 그 날짜가 "오늘"이 되어 앱이 정상적으로 '오늘' 이라고 표시하는데도
// 테스트만 실패했다. 미래 날짜를 쓰는 검사는 하드코딩하면 반드시 언젠가 깨진다.
const { weatherReady, landed, dryStatusSettled } = require('./lib/harness');

const pad = n => String(n).padStart(2, '0');
const DAY_KO = ['일', '월', '화', '수', '목', '금', '토'];
// 오늘 + n일 → { iso: "2026-08-14", ko: "8/14", koFull: "8/14(금)" }
function day(n) {
  const d = new Date();
  d.setHours(12, 0, 0, 0);           // 자정 부근 실행 시 날짜가 밀리지 않게
  d.setDate(d.getDate() + n);
  return {
    iso: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    ko: `${d.getMonth() + 1}/${d.getDate()}`,
    koFull: `${d.getMonth() + 1}/${d.getDate()}(${DAY_KO[d.getDay()]})`,
  };
}

module.exports = {
  name: '출발 일시 · 도착 예정',
  needsBrowser: true,
  needsNetwork: true,

  async run(t, { browser, url }) {
    // 오늘+1 / +3 / +5 — 모두 Open-Meteo 예보 범위(오늘+15일) 안이다
    const D1 = day(1), D3 = day(3), D5 = day(5);
    t.info(`기준 날짜: 오늘+1=${D1.iso}  오늘+3=${D3.iso}  오늘+5=${D5.iso}`);
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
    const calc = await p.evaluate((ISO) => {
      const cases = [
        ['09:00', 160], ['23:30', 160], ['22:00', 299], ['06:00', 52], ['00:10', 30],
      ];
      return cases.map(([hm, dur]) => {
        const a = arrivalOf(ISO, hm, dur);
        return { hm, dur, arr: a.hm, day: a.dayDiff };
      });
    }, D1.iso);
    calc.forEach(c => t.info(`${c.hm} + ${c.dur}분 → ${c.arr} (dayDiff=${c.day})`));
    const find = hm => calc.find(c => c.hm === hm);
    t.ok(find('09:00').arr === '11:40' && find('09:00').day === 0, '09:00 + 2시간40분 = 11:40');
    t.ok(find('23:30').arr === '02:10' && find('23:30').day === 1, '자정을 넘기면 익일로 계산한다');
    t.ok(find('22:00').arr === '02:59' && find('22:00').day === 1, '장거리 심야도 정확하다');
    t.ok(find('06:00').arr === '06:52' && find('06:00').day === 0, '단거리도 정확하다');
    t.ok(find('00:10').arr === '00:40' && find('00:10').day === 0, '자정 직후도 같은 날로 본다');

    t.section('승차권 표시');
    await p.selectOption('#region', '강원');
    await p.fill('#depDate', D1.iso);
    await p.fill('#depTime', '09:00');
    await p.click('#go');
    await p.waitForSelector('#passWrap.show');
    const sched = (await p.textContent('#passSched')).replace(/\s+/g, ' ').trim();
    t.info(sched);
    t.ok(sched.includes(D1.koFull), `날짜와 요일이 표시된다 (${D1.koFull})`);
    t.ok(/09:00.*→.*\d{2}:\d{2}/.test(sched), '출발 → 도착 시각이 표시된다');
    t.ok(sched.includes('도착 예정'), '계산값이므로 "예정"으로 표기한다');

    t.section('날짜별 날씨');
    await weatherReady(p);
    const future = (await p.textContent('#passWeather')).replace(/\s+/g, ' ').trim();
    t.info(future);
    t.ok(future.includes(D1.ko), `배지에 선택한 날짜가 나온다 (${D1.ko})`);
    t.ok(!future.includes('지금'), '미래 날짜에는 의미 없는 "지금 기온"을 숨긴다');
    t.ok(/강수확률\s*\d+%/.test(future), '그 날짜의 강수확률이 나온다');

    await p.fill('#depDate', init.min);
    await weatherReady(p);
    const today = (await p.textContent('#passWeather')).replace(/\s+/g, ' ').trim();
    t.ok(today.includes('오늘') && today.includes('지금'), '오늘로 되돌리면 "오늘 · 지금 기온"이 돌아온다');

    t.section('날짜 변경 시 갱신');
    const before = (await p.textContent('#passSched')).trim();
    await p.fill('#depDate', D3.iso);
    await p.waitForTimeout(400);
    const after = (await p.textContent('#passSched')).trim();
    t.ok(before !== after && after.includes(D3.ko), `카드가 새 날짜로 갱신된다 (${D3.ko})`);
    t.ok(await p.isVisible('#passWrap'), '카드를 다시 인쇄하지 않고 유지한다');

    t.section('비 필터 — 날짜 기준');
    let calls = 0;
    p.on('request', r => { if (r.url().includes('open-meteo')) calls++; });
    await p.check('#dryOnly');
    await dryStatusSettled(p, D3.ko);
    t.info(`${(await p.textContent('#wxStatus')).trim()} | ${(await p.textContent('#poolCount')).trim()}`);
    t.ok((await p.textContent('#wxStatus')).includes(D3.ko), `선택한 날짜 기준으로 안내된다 (${D3.ko})`);

    const c1 = calls;
    await p.fill('#depDate', D5.iso);
    await dryStatusSettled(p, D5.ko);
    t.info(`${(await p.textContent('#wxStatus')).trim()} | ${(await p.textContent('#poolCount')).trim()}`);
    t.ok((await p.textContent('#wxStatus')).includes(D5.ko), `날짜를 바꾸면 그 날짜로 다시 걸러낸다 (${D5.ko})`);
    t.ok(calls - c1 >= 1, `새 날짜는 새로 조회한다 (요청 ${calls - c1}회)`);

    // 전국에 비가 오는 날이면 후보가 0곳이 된다. 그것도 정상 동작이므로
    // 뽑기 검사는 후보가 남아 있을 때만 한다(실제로 99곳 전부 제외된 날이 있었다).
    const verify = await p.evaluate(() => {
      const iso = depDateVal();
      const wet = DEST.filter(d => !isDry(d, iso)).map(d => d.n);
      const left = DEST.length - wet.length;
      const picked = [];
      if (left > 0) {
        for (let i = 0; i < 8; i++) { spin(); picked.push(document.getElementById('flap').textContent.trim()); }
      }
      return { wet: wet.length, left, bad: picked.filter(x => wet.includes(x)) };
    });
    t.info(`비 예보 ${verify.wet}곳 / 남은 후보 ${verify.left}곳`);
    if (verify.left === 0) {
      t.ok(true, '전국에 비 예보인 날은 후보가 0곳이 된다 (정상 동작, 뽑기 검사는 건너뜀)');
    } else {
      t.ok(verify.bad.length === 0, `뽑힌 곳에 비 예보 지역이 없다 (비 ${verify.wet}곳)`);
    }

    t.section('링크에 일시 포함·복원');
    await p.uncheck('#dryOnly');
    await p.fill('#depDate', D1.iso);
    await p.fill('#depTime', '07:30');
    // #again 은 승차권 안에 있어 후보가 0곳이었으면 숨어 있다. 항상 보이는 #go 를 쓴다.
    await p.click('#go');
    await landed(p);
    await p.waitForTimeout(300);
    t.info(`주소: ${decodeURIComponent(p.url().split('?')[1] || '')}`);
    t.ok(p.url().includes('d=' + D1.iso), '주소창에 날짜가 반영된다');

    const p2 = await ctx.newPage();
    watch(p2);
    await p2.goto(`${url}?to=${encodeURIComponent('여수')}&d=${D1.iso}&t=07:30`);
    await p2.waitForSelector('#passWrap.show');
    const restored = await p2.evaluate(() => ({
      d: document.getElementById('depDate').value,
      t: document.getElementById('depTime').value,
      s: document.getElementById('passSched').textContent.replace(/\s+/g, ' ').trim(),
    }));
    t.info(JSON.stringify(restored));
    t.ok(restored.d === D1.iso && restored.t === '07:30', '링크로 들어오면 일시가 복원된다');
    t.ok(restored.s.includes(D1.ko) && restored.s.includes('07:30'), '복원된 일시로 카드가 그려진다');

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
