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
    const fs2 = require('fs'), p2 = require('path');
    t.ok(fs2.existsSync(p2.join(require('./lib/harness').ROOT, 'og.png')), 'og.png 파일이 저장소에 있다');
  },
};
