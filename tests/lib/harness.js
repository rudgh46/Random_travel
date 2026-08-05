// 테스트 공용 도구: 정적 서버, 결과 리포터, 자주 쓰는 대기 헬퍼
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');   // 저장소 루트

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.png': 'image/png',
  '.md': 'text/markdown; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

// file:// 은 localStorage·clipboard·history 에 제약이 있어 로컬 서버로 띄운다.
// 포트는 0(OS 자동 할당)으로 열어 다른 프로세스와 충돌하지 않게 한다.
//
// withFunction: true 면 /api/tago 를 실제 Netlify 함수로 연결한다
// (netlify.toml 의 리다이렉트를 로컬에서 재현하는 셈).
function startServer({ withFunction = false } = {}) {
  let tago = null;
  if (withFunction) {
    tago = require(path.join(ROOT, 'netlify', 'functions', 'tago.js')).handler;
  }

  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://localhost');

    if (tago && u.pathname === '/api/tago') {
      try {
        const r = await tago({ queryStringParameters: Object.fromEntries(u.searchParams) });
        res.writeHead(r.statusCode, r.headers);
        res.end(r.body);
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(e && e.message) }));
      }
      return;
    }

    const file = path.join(ROOT, decodeURIComponent(u.pathname));
    // 저장소 밖 경로 요청 차단
    if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
    let body;
    try { body = fs.readFileSync(file); }
    catch { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(body);
  });
  return new Promise(resolve => {
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      resolve({ srv, base: `http://127.0.0.1:${port}`, url: `http://127.0.0.1:${port}/index.html` });
    });
  });
}

function reporter(title) {
  let pass = 0, fail = 0;
  const failures = [];
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 46 - title.length))}`);
  return {
    section(name) { console.log(`\n  [${name}]`); },
    info(msg) { console.log(`      ${msg}`); },
    ok(cond, label) {
      if (cond) { pass++; console.log(`    PASS  ${label}`); }
      else { fail++; failures.push(`${title} › ${label}`); console.log(`    FAIL  ${label}`); }
      return !!cond;
    },
    totals() { return { pass, fail, failures }; },
  };
}

// index.html 원문을 읽어 정적 데이터 블록을 추출한다.
// (브라우저 없이 데이터 정합성만 볼 때 사용)
function readIndex() {
  return fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
}

function extractDest(src) {
  return [...src.matchAll(/\{n:"([^"]+)",\s*r:"([^"]+)"[^}]*?fare:(\d+),\s*dur:(\d+)/g)]
    .map(m => ({ n: m[1], r: m[2], fare: +m[3], dur: +m[4] }));
}

function extractBlock(src, name, kind = 'const') {
  const re = new RegExp(`${kind} ${name} = (?:new Set\\(\\[|\\{|\\[)([\\s\\S]*?)\\n  (?:\\}|\\]\\)|\\])`);
  const m = src.match(re);
  if (!m) throw new Error(`${name} 블록을 index.html 에서 찾지 못했습니다`);
  return m[1];
}

// 페이지 공용 대기 헬퍼
const weatherReady = page => page.waitForFunction(() => {
  const el = document.getElementById('passWeather');
  return el && !el.hidden && !el.classList.contains('loading');
}, null, { timeout: 25000 });

const landed = page => page.waitForFunction(
  () => !document.getElementById('go').disabled, null, { timeout: 15000 });

const dryStatusSettled = (page, contains) => page.waitForFunction(sub => {
  const t = document.getElementById('wxStatus').textContent;
  return t && !t.includes('확인 중') && (!sub || t.includes(sub));
}, contains || null, { timeout: 25000 });

module.exports = {
  ROOT, startServer, reporter, readIndex, extractDest, extractBlock,
  weatherReady, landed, dryStatusSettled,
};
