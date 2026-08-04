#!/usr/bin/env node
// 전체 검증 실행기
//   node run.js            전부 실행
//   node run.js data       이름에 'data' 가 들어간 스위트만
//   node run.js ui weather 여러 개 지정
const { startServer, reporter } = require('./lib/harness');

const SUITES = [
  require('./data.test.js'),
  require('./ui.test.js'),
  require('./weather.test.js'),
  require('./schedule.test.js'),
];

const FILES = ['data', 'ui', 'weather', 'schedule'];

(async () => {
  const args = process.argv.slice(2).map(s => s.toLowerCase());
  const picked = args.length
    ? SUITES.filter((_, i) => args.some(a => FILES[i].includes(a)))
    : SUITES;

  if (!picked.length) {
    console.error(`실행할 스위트가 없습니다. 사용 가능: ${FILES.join(', ')}`);
    process.exit(2);
  }

  const needsBrowser = picked.some(s => s.needsBrowser);
  let browser, server;

  if (needsBrowser) {
    let chromium;
    try { ({ chromium } = require('playwright')); }
    catch {
      console.error('\nplaywright 가 없습니다. tests 폴더에서 `npm install` 을 먼저 실행하세요.');
      process.exit(2);
    }
    server = await startServer();
    try { browser = await chromium.launch(); }
    catch (e) {
      console.error(`\n브라우저를 띄우지 못했습니다: ${e.message}`);
      console.error('`npx playwright install chromium` 으로 브라우저를 받아 주세요.');
      server.srv.close();
      process.exit(2);
    }
  }

  const started = Date.now();
  const results = [];

  for (const suite of picked) {
    const t = reporter(suite.name);
    try {
      await suite.run(t, needsBrowser ? { browser, url: server.url, base: server.base } : {});
    } catch (e) {
      t.ok(false, `스위트가 중단되었습니다: ${e.message}`);
    }
    results.push({ name: suite.name, ...t.totals() });
  }

  if (browser) await browser.close();
  if (server) server.srv.close();

  const pass = results.reduce((a, r) => a + r.pass, 0);
  const fail = results.reduce((a, r) => a + r.fail, 0);
  const secs = ((Date.now() - started) / 1000).toFixed(1);

  console.log(`\n${'='.repeat(52)}`);
  for (const r of results) {
    const mark = r.fail ? 'FAIL' : ' OK ';
    console.log(`  [${mark}] ${r.name.padEnd(28)} ${r.pass} 통과${r.fail ? ` / ${r.fail} 실패` : ''}`);
  }
  console.log('='.repeat(52));
  console.log(`  합계 ${pass} 통과 / ${fail} 실패 · ${secs}초`);

  if (fail) {
    console.log('\n실패 목록:');
    results.flatMap(r => r.failures).forEach(f => console.log(`  · ${f}`));
  }
  console.log('');
  process.exit(fail ? 1 : 0);
})();
