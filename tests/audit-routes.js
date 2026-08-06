#!/usr/bin/env node
// 내장 목적지 99곳이 실제로 TAGO 노선으로 해석되는지 전수 점검하는 점검용 도구.
//
//   TAGO_KEY="발급받은_인코딩_키" node audit-routes.js
//
// npm test 에는 넣지 않았습니다. 목적지마다 API 를 호출해 3분쯤 걸리고,
// 동시 요청을 몰면 초당 제한("서비스 요청제한 횟수 초과")에 걸립니다.
// 목적지·요금 데이터를 손봤을 때만 돌리면 됩니다.
//
// 보는 것
//   · 이름으로 터미널이 해석되는지 (해석 실패가 곧 "표가 없다"로 보인다)
//   · 해석된 터미널 이름이 우리 표기와 얼마나 다른지 (엉뚱한 곳을 잡았을 수 있다)
//   · 오늘 운행 편수
const path = require('path');
const { ROOT, readIndex } = require('./lib/harness');

if (!process.env.TAGO_KEY) {
  console.error('TAGO_KEY 환경변수가 필요합니다.');
  console.error('  PowerShell: $env:TAGO_KEY="키"; node audit-routes.js');
  console.error('  bash:       TAGO_KEY="키" node audit-routes.js');
  process.exit(2);
}
const { handler } = require(path.join(ROOT, 'netlify', 'functions', 'tago.js'));

const DELAY_MS = 900;   // 초당 제한 회피
const sleep = ms => new Promise(r => setTimeout(r, ms));
const HINT = { gb: '서울경부', hn: '센트럴시티,서울호남' };

// index.html 의 보정 맵을 그대로 읽어 실제 조회와 같은 조건으로 점검한다
function readMap(src, name) {
  const m = src.match(new RegExp(`const ${name} = \\{([\\s\\S]*?)\\n  \\};`));
  if (!m) return {};
  return Object.fromEntries([...m[1].matchAll(/"([^"]+)":\s*"([^"]+)"/g)].map(x => [x[1], x[2]]));
}

const norm = s => s.replace(/[·\s()]/g, '');

(async () => {
  const src = readIndex();
  const DEST = [...src.matchAll(/\{n:"([^"]+)",\s*r:"([^"]+)",\s*fare:(\d+),\s*dur:(\d+),\s*grade:"([^"]+)",\s*t:"(\w+)"/g)]
    .map(m => ({ n: m[1], r: m[2], fare: +m[3], dur: +m[4], t: m[6] }));
  const ARR_NAME = readMap(src, 'TAGO_ARR');
  const ARR_ID = readMap(src, 'TAGO_ARR_ID');
  const DEP_ID = readMap(src, 'DEP_ID');

  console.log(`목적지 ${DEST.length}곳 점검 (약 ${Math.ceil(DEST.length * DELAY_MS / 1000 / 60)}분)\n`);

  const rows = [];
  for (const d of DEST) {
    await sleep(DELAY_MS);
    const query = ARR_NAME[d.n] || d.n.split('·')[0];
    const q = { mode: 'route', depHint: HINT[d.t], arr: query };
    if (DEP_ID[d.t]) q.depId = DEP_ID[d.t];
    if (ARR_ID[d.n]) q.arrId = ARR_ID[d.n];
    let j;
    try {
      const r = await handler({ queryStringParameters: q });
      j = JSON.parse(r.body);
    } catch (e) { j = { error: e.message }; }
    rows.push({ ...d, query, count: j.count, arrTmn: j.arrTerminal, tried: j.tried, error: j.error });
    process.stdout.write(j.error ? 'E' : (j.count > 0 ? '.' : '0'));
  }
  console.log('\n');

  const unresolved = rows.filter(r => r.error || !r.arrTmn);
  const zero = rows.filter(r => !r.error && r.arrTmn && r.count === 0);
  const odd = rows.filter(r => r.arrTmn && !norm(r.arrTmn.name).includes(norm(r.query)));

  if (unresolved.length) {
    console.log('── 터미널을 해석하지 못함 (사용자에게는 "표가 없음"으로 보입니다) ──');
    unresolved.forEach(r => console.log(`  ${r.n.padEnd(10)} 검색어="${r.query}"  ${r.error || ''}`));
    console.log('  → index.html 의 TAGO_ARR 에 올바른 터미널 이름을 넣으세요.\n');
  }
  if (zero.length) {
    console.log('── 터미널은 찾았지만 오늘 0편 ──');
    zero.forEach(r => console.log(`  ${r.n.padEnd(10)} → ${r.arrTmn.id} ${r.arrTmn.name}`));
    console.log('  → 운행이 드문 노선일 수 있습니다. 며칠 뒤 다시 확인하세요.\n');
  }
  if (odd.length) {
    console.log('── 검색어와 해석된 터미널 이름이 다름 (엉뚱한 곳일 수 있으니 확인) ──');
    odd.forEach(r => console.log(`  ${r.n.padEnd(10)} 검색어="${r.query}" → ${r.arrTmn.id} ${r.arrTmn.name} (${r.count}편)`));
    console.log('');
  }

  const good = rows.filter(r => r.count > 0).length;
  console.log('='.repeat(56));
  console.log(`  노선 확인 ${good}곳 / 해석 실패 ${unresolved.length}곳 / 0편 ${zero.length}곳`);
  console.log('='.repeat(56));
  rows.filter(r => r.count > 0).forEach(r =>
    console.log(`  ${r.n.padEnd(10)} ${String(r.count).padStart(3)}편  ${r.arrTmn.id} ${r.arrTmn.name}`));
  console.log('');
  process.exit(unresolved.length ? 1 : 0);
})();
