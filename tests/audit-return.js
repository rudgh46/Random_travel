#!/usr/bin/env node
// 돌아오는 편(목적지 → 서울)을 전수 점검하는 도구.
//
//   TAGO_KEY="발급받은_인코딩_키" node audit-return.js
//
// npm test 에는 넣지 않았습니다. 목적지마다 API 를 호출해 2분쯤 걸리고,
// 동시 요청을 몰면 초당 제한("서비스 요청제한 횟수 초과")에 걸립니다.
//
// 보는 것
//   · index.html 의 RETURN 에 적힌 막차·편수가 지금도 맞는지
//   · 자료가 없던 목적지에 노선이 생겼는지
//   · 반대로, 있던 노선이 사라졌는지
//
// 막차는 요일·시기에 따라 달라지므로 30분 이상 차이 날 때만 보고합니다.
const path = require('path');
const { ROOT, readIndex } = require('./lib/harness');

if (!process.env.TAGO_KEY) {
  console.error('TAGO_KEY 환경변수가 필요합니다.');
  console.error('  PowerShell: $env:TAGO_KEY="키"; node audit-return.js');
  console.error('  bash:       TAGO_KEY="키" node audit-return.js');
  process.exit(2);
}
const { handler } = require(path.join(ROOT, 'netlify', 'functions', 'tago.js'));

const DELAY_MS = 850;
const DRIFT_MIN = 30;                 // 이만큼 넘게 어긋나면 보고
const sleep = ms => new Promise(r => setTimeout(r, ms));

const hhmm = v => { const s = String(v); return s.length >= 12 ? s.slice(8, 10) + ':' + s.slice(10, 12) : s; };
const toMin = hm => { const [h, m] = hm.split(':').map(Number); return h * 60 + m; };
const SEOUL_NAME = { NAEK010: '서울경부', NAEK020: '센트럴시티', NAEK021: '센트럴시티' };

function readMap(src, name) {
  const m = src.match(new RegExp(`const ${name} = \\{([\\s\\S]*?)\\n  \\};`));
  if (!m) return {};
  return Object.fromEntries([...m[1].matchAll(/"([^"]+)":\s*"([^"]+)"/g)].map(x => [x[1], x[2]]));
}

(async () => {
  const src = readIndex();
  const DEST = [...src.matchAll(/\{n:"([^"]+)",\s*r:"([^"]+)",\s*fare:(\d+),\s*dur:(\d+),\s*grade:"([^"]+)",\s*t:"(\w+)"/g)]
    .map(m => ({ n: m[1], dur: +m[4], t: m[6] }));
  const RETURN = Object.fromEntries([...src.slice(src.indexOf('const RETURN = {'))
    .matchAll(/"([^"]+)":\["(NAEK\d+)","(NAEK\d+)","(\d{1,2}:\d{2})",(\d+)\]/g)]
    .map(m => [m[1], { depId: m[2], seoulId: m[3], last: m[4], count: +m[5] }]));
  const ARR_NAME = readMap(src, 'TAGO_ARR');
  const ARR_ID = readMap(src, 'TAGO_ARR_ID');

  console.log(`목적지 ${DEST.length}곳 역방향 점검 (자료 있는 곳 ${Object.keys(RETURN).length}곳, 약 2분)\n`);

  const drift = [], gone = [], appeared = [];
  for (const d of DEST) {
    await sleep(DELAY_MS);
    const known = RETURN[d.n];
    // 아는 곳은 그 조합만, 모르는 곳은 서울 터미널 후보를 넓게 시도한다
    const cands = known ? [known.seoulId]
      : (d.t === 'gb' ? ['NAEK010'] : ['NAEK021', 'NAEK020']);
    const depId = (known && known.depId) || ARR_ID[d.n];
    const depHint = ARR_NAME[d.n] || d.n.split('·')[0];

    let hit = null;
    for (const sid of cands) {
      const q = { mode: 'route', depHint, arr: SEOUL_NAME[sid], arrId: sid };
      if (depId) q.depId = depId;
      let j;
      try { j = JSON.parse((await handler({ queryStringParameters: q })).body); }
      catch (e) { j = { error: e.message }; }
      if (j.count > 0) {
        const times = j.trips.map(t => String(t.dep)).filter(Boolean).sort();
        hit = { seoulId: sid, count: j.count, last: hhmm(times[times.length - 1]) };
        break;
      }
      if (cands.length > 1) await sleep(DELAY_MS);
    }

    if (known && !hit) { gone.push(d.n); process.stdout.write('X'); continue; }
    if (!known && hit) { appeared.push({ n: d.n, ...hit }); process.stdout.write('+'); continue; }
    if (!known) { process.stdout.write('-'); continue; }

    const diff = Math.abs(toMin(hit.last) - toMin(known.last));
    if (diff > DRIFT_MIN) drift.push({ n: d.n, was: known.last, now: hit.last, count: hit.count, wasCount: known.count });
    process.stdout.write(diff > DRIFT_MIN ? '!' : '.');
  }
  console.log('\n');

  if (gone.length) {
    console.log('── 노선이 사라졌습니다 (RETURN 에서 빼세요) ──');
    gone.forEach(n => console.log(`  ${n}`));
    console.log('');
  }
  if (appeared.length) {
    console.log('── 없던 노선이 생겼습니다 (RETURN 에 넣으세요) ──');
    appeared.forEach(a => console.log(`  "${a.n}":["?","${a.seoulId}","${a.last}",${a.count}],`));
    console.log('  → 출발 터미널 ID 는 TAGO_ARR_ID 를 참고하세요.\n');
  }
  if (drift.length) {
    console.log(`── 막차가 ${DRIFT_MIN}분 넘게 달라졌습니다 ──`);
    drift.forEach(x => console.log(`  ${x.n.padEnd(9)} ${x.was} → ${x.now}   편수 ${x.wasCount} → ${x.count}`));
    console.log('  → 요일·시기 차이일 수 있습니다. 여러 날 확인한 뒤 고치세요.\n');
  }

  console.log('='.repeat(56));
  console.log(`  이상 없음 ${DEST.length - gone.length - appeared.length - drift.length}곳`
    + ` / 사라짐 ${gone.length}곳 / 생김 ${appeared.length}곳 / 막차 변동 ${drift.length}곳`);
  console.log('='.repeat(56));
  process.exit(gone.length ? 1 : 0);
})();
