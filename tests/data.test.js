// 정적 데이터 정합성 — 브라우저도 네트워크도 필요 없다.
// 목적지를 추가·수정할 때 가장 먼저 깨지는 곳이라 단독으로도 자주 돌릴 만하다.
const { readIndex, extractDest, extractBlock } = require('./lib/harness');

module.exports = {
  name: '정적 데이터 정합성',
  needsBrowser: false,
  needsNetwork: false,

  async run(t) {
    const src = readIndex();
    const dest = extractDest(src);
    const names = dest.map(d => d.n);

    t.section('목적지 목록');
    t.ok(dest.length > 0, `목적지 ${dest.length}곳을 읽었다`);
    const dup = names.filter((n, i) => names.indexOf(n) !== i);
    t.ok(dup.length === 0, dup.length ? `이름 중복: ${dup.join(', ')}` : '이름 중복 없음');
    const badFare = dest.filter(d => !(d.fare > 0 && d.fare < 100000));
    t.ok(badFare.length === 0, badFare.length ? `요금 이상: ${badFare.map(d => d.n).join(', ')}` : '요금이 모두 상식 범위');
    const badDur = dest.filter(d => !(d.dur > 0 && d.dur < 600));
    t.ok(badDur.length === 0, badDur.length ? `소요시간 이상: ${badDur.map(d => d.n).join(', ')}` : '소요시간이 모두 상식 범위');

    t.section('권역(REGION)');
    // DEST 의 권역과 선택 목록·코드·설명이 어긋나면 필터가 조용히 0곳이 된다
    const regions = [...new Set(dest.map(d => d.r))];
    const options = [...src.matchAll(/<option value="([^"]+)">/g)].map(m => m[1])
      .filter(v => v !== 'all');
    const codeKeys = [...extractBlock(src, 'REGION_CODE').matchAll(/"([^"]+)":"/g)].map(m => m[1]);
    const vibeKeys = [...extractBlock(src, 'REGION_VIBE').matchAll(/"([^"]+)":"/g)].map(m => m[1]);

    t.info(`권역 ${regions.length}개: ${regions.join(' / ')}`);
    const noOption = regions.filter(r => !options.includes(r));
    t.ok(noOption.length === 0, noOption.length ? `선택 목록에 없는 권역: ${noOption.join(', ')}` : '모든 권역이 선택 목록에 있다');
    const deadOption = options.filter(v => !regions.includes(v) && !/^(all|gb|hn|\d+)$/.test(v));
    t.ok(deadOption.length === 0, deadOption.length ? `해당 목적지가 없는 선택지: ${deadOption.join(', ')}` : '빈 선택지가 없다');
    const noCode = regions.filter(r => !codeKeys.includes(r));
    t.ok(noCode.length === 0, noCode.length ? `REGION_CODE 누락: ${noCode.join(', ')}` : '모든 권역에 영문 코드가 있다');
    const noVibe = regions.filter(r => !vibeKeys.includes(r));
    t.ok(noVibe.length === 0, noVibe.length ? `REGION_VIBE 누락: ${noVibe.join(', ')}` : '모든 권역에 설명이 있다');
    const counts = regions.map(r => `${r}:${dest.filter(d => d.r === r).length}`);
    t.info(`분포 → ${counts.join('  ')}`);
    t.ok(regions.every(r => dest.filter(d => d.r === r).length >= 3), '권역마다 최소 3곳 이상이다');

    t.section('좌표(COORD)');
    const coord = [...extractBlock(src, 'COORD').matchAll(/"([^"]+)":\[(-?[\d.]+),\s*(-?[\d.]+)\]/g)]
      .map(m => ({ n: m[1], lat: +m[2], lon: +m[3] }));
    const coordNames = coord.map(c => c.n);
    t.ok(coord.length === dest.length, `좌표 ${coord.length}개 / 목적지 ${dest.length}곳`);
    const noCoord = names.filter(n => !coordNames.includes(n));
    t.ok(noCoord.length === 0, noCoord.length ? `좌표 없는 목적지: ${noCoord.join(', ')}` : '모든 목적지에 좌표가 있다');
    const orphanCoord = coordNames.filter(n => !names.includes(n));
    t.ok(orphanCoord.length === 0, orphanCoord.length ? `짝 없는 좌표 키: ${orphanCoord.join(', ')}` : '짝 없는 좌표 키 없음');

    // 한반도 남부 범위 밖이면 오타를 의심한다
    const outside = coord.filter(c => c.lat < 33 || c.lat > 38.7 || c.lon < 125.5 || c.lon > 129.7);
    t.ok(outside.length === 0,
      outside.length ? `좌표 범위 이상: ${outside.map(c => `${c.n}(${c.lat},${c.lon})`).join(', ')}` : '좌표가 모두 한반도 범위 안');

    // 완전히 같은 좌표는 복사·붙여넣기 실수의 신호
    const seen = new Map(), sameSpot = [];
    for (const c of coord) {
      const k = `${c.lat},${c.lon}`;
      if (seen.has(k)) sameSpot.push(`${seen.get(k)}=${c.n}`); else seen.set(k, c.n);
    }
    t.ok(sameSpot.length === 0, sameSpot.length ? `좌표가 완전히 겹침: ${sameSpot.join(', ')}` : '중복 좌표 없음');

    t.section('볼거리(SPOTS)');
    const spotsBlock = extractBlock(src, 'SPOTS');
    const spotKeys = [...spotsBlock.matchAll(/\n\s{4}"([^"]+)":\s*\[\[/g)].map(m => m[1]);
    t.ok(spotKeys.length === dest.length, `볼거리 키 ${spotKeys.length}개 / 목적지 ${dest.length}곳`);
    const noSpots = names.filter(n => !spotKeys.includes(n));
    t.ok(noSpots.length === 0, noSpots.length ? `볼거리 없는 목적지: ${noSpots.join(', ')}` : '모든 목적지에 볼거리가 있다');
    const orphanSpots = spotKeys.filter(n => !names.includes(n));
    t.ok(orphanSpots.length === 0, orphanSpots.length ? `짝 없는 볼거리 키: ${orphanSpots.join(', ')}` : '짝 없는 볼거리 키 없음');

    // [이름, 설명, 분류] 3칸 구조가 지켜졌는지
    const entries = [...spotsBlock.matchAll(/\["([^"]*)","([^"]*)","([^"]*)"\]/g)];
    t.info(`볼거리 항목 ${entries.length}개`);
    t.ok(entries.length >= dest.length * 2, `항목 수가 충분하다 (${entries.length}개)`);
    const emptyField = entries.filter(m => !m[1].trim() || !m[2].trim() || !m[3].trim());
    t.ok(emptyField.length === 0, emptyField.length ? `빈 칸이 있는 항목 ${emptyField.length}개` : '빈 칸 없음');

    t.section('돌아오는 편(RETURN)');
    // [출발터미널ID, 서울도착터미널ID, 막차, 편수]
    const ret = [...extractBlock(src, 'RETURN')
      .matchAll(/"([^"]+)":\["(NAEK\d+)","(NAEK\d+)","(\d{1,2}:\d{2})",(\d+)\]/g)]
      .map(m => ({ n: m[1], depId: m[2], seoulId: m[3], last: m[4], count: +m[5] }));
    t.info(`역방향 자료 ${ret.length}곳 / 목적지 ${dest.length}곳`);
    t.ok(ret.length > 0 && ret.length <= dest.length, '항목 수가 목적지 수를 넘지 않는다');
    const badRet = ret.filter(r => !names.includes(r.n));
    t.ok(badRet.length === 0, badRet.length
      ? `DEST 에 없는 이름: ${badRet.map(r => r.n).join(', ')}` : '모두 실제 목적지 이름');
    const dupRet = ret.map(r => r.n).filter((n, i, a) => a.indexOf(n) !== i);
    t.ok(dupRet.length === 0, dupRet.length ? `중복: ${dupRet.join(', ')}` : '중복 없음');
    // 서울 쪽은 경부(NAEK010)나 센트럴시티(NAEK020/021) 중 하나여야 한다
    const oddSeoul = ret.filter(r => !['NAEK010', 'NAEK020', 'NAEK021'].includes(r.seoulId));
    t.ok(oddSeoul.length === 0, oddSeoul.length
      ? `서울 터미널 ID 가 이상함: ${oddSeoul.map(r => `${r.n}=${r.seoulId}`).join(', ')}`
      : '서울 도착 터미널이 모두 경부·센트럴시티');
    // 시각은 24:00 까지 허용한다(자정 출발). 25:00 같은 값은 오타다.
    const oddTime = ret.filter(r => {
      const [h, m] = r.last.split(':').map(Number);
      return h > 24 || m > 59 || (h === 24 && m !== 0);
    });
    t.ok(oddTime.length === 0, oddTime.length
      ? `막차 시각 이상: ${oddTime.map(r => `${r.n}=${r.last}`).join(', ')}` : '막차 시각이 모두 정상 범위');
    t.ok(ret.every(r => r.count > 0), '편수가 모두 1편 이상');
    // 도착 터미널 ID 를 이미 아는 곳은 역방향 출발 ID 와 같아야 한다(같은 터미널이다)
    const arrId = Object.fromEntries([...extractBlock(src, 'TAGO_ARR_ID')
      .matchAll(/"([^"]+)":\s*"(NAEK\d+)"/g)].map(m => [m[1], m[2]]));
    const mismatch = ret.filter(r => arrId[r.n] && arrId[r.n] !== r.depId);
    t.ok(mismatch.length === 0, mismatch.length
      ? `가는 편·오는 편 터미널 ID 가 다름: ${mismatch.map(r => `${r.n}(${arrId[r.n]}≠${r.depId})`).join(', ')}`
      : '고정해 둔 터미널 ID 와 어긋나지 않는다');

    t.section('해안 목적지(SEASIDE)');
    const seaside = [...extractBlock(src, 'SEASIDE').matchAll(/"([^"]+)"/g)].map(m => m[1]);
    t.ok(seaside.length > 0, `해안 목적지 ${seaside.length}곳`);
    const badSea = seaside.filter(n => !names.includes(n));
    t.ok(badSea.length === 0, badSea.length ? `DEST 에 없는 이름: ${badSea.join(', ')}` : '모두 실제 목적지 이름');
    const dupSea = seaside.filter((n, i) => seaside.indexOf(n) !== i);
    t.ok(dupSea.length === 0, dupSea.length ? `중복: ${dupSea.join(', ')}` : '중복 없음');

    t.section('지도 검색어 보정(SEARCH_CITY)');
    const cityBlock = extractBlock(src, 'SEARCH_CITY');
    const cities = [...cityBlock.matchAll(/"([^"]+)":"([^"]+)"/g)].map(m => ({ from: m[1], to: m[2] }));
    t.ok(cities.length > 0, `보정 항목 ${cities.length}개`);
    const badFrom = cities.filter(c => !names.includes(c.from));
    t.ok(badFrom.length === 0, badFrom.length ? `DEST 에 없는 키: ${badFrom.map(c => c.from).join(', ')}` : '모든 키가 실제 목적지');
    const selfMap = cities.filter(c => c.from === c.to);
    t.ok(selfMap.length === 0, selfMap.length ? `자기 자신으로 보정: ${selfMap.map(c => c.from).join(', ')}` : '무의미한 보정 없음');

    t.section('공유 메타');
    t.ok(/<meta property="og:image" content="https:\/\/[^"]+\/og\.png">/.test(src),
      'og:image 가 절대 URL 이다 (일부 크롤러는 상대 경로를 못 읽는다)');
    t.ok(/<meta property="og:url" content="https:\/\//.test(src), 'og:url 이 절대 URL 이다');
    t.ok(/<meta name="twitter:card"/.test(src), 'twitter:card 가 있다');
    // 뽑을 때마다 ?to=…&d=…&t= 이 주소에 붙으므로 canonical 이 없으면
    // 같은 페이지가 여러 주소로 색인된다
    t.ok(/<link rel="canonical" href="https:\/\/[^"?]+\/">/.test(src),
      'canonical 이 쿼리 없는 주소를 가리킨다');

    const fs2 = require('fs'), p2 = require('path');
    t.ok(fs2.existsSync(p2.join(require('./lib/harness').ROOT, 'og.png')), 'og.png 파일이 저장소에 있다');

    t.section('방문 통계(GA4)');
    // 측정 ID 가 index.html 과 생성기에서 갈라지면 노선 페이지만 다른 속성으로
    // 집계되거나 아예 안 잡힌다. 한쪽만 고치는 실수가 잦아 여기서 묶어 둔다.
    const gaMain = src.match(/gtag\/js\?id=(G-[A-Z0-9]+)/);
    t.ok(!!gaMain, gaMain ? `측정 ID ${gaMain[1]}` : 'index.html 에 GA4 태그가 없다');
    const builder = fs2.readFileSync(
      p2.join(require('./lib/harness').ROOT, 'tools', 'build-pages.js'), 'utf8');
    const gaGen = builder.match(/const GA_ID = '(G-[A-Z0-9]+)'/);
    t.ok(!!gaGen, gaGen ? '생성기에도 측정 ID 가 있다' : 'tools/build-pages.js 에 GA_ID 가 없다');
    t.ok(gaMain && gaGen && gaMain[1] === gaGen[1],
      '메인과 노선 페이지가 같은 측정 ID 를 쓴다');
    t.ok(/<script async src="https:\/\/www\.googletagmanager\.com/.test(src),
      'GA 스크립트가 async 다 (늦거나 차단돼도 페이지가 뜬다)');
    t.ok(/Google Analytics를 사용하며/.test(src),
      '쿠키 사용 안내가 하단에 있다');
  },
};
