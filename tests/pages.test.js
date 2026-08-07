// 노선 상세 페이지(tools/build-pages.js 생성물) 검증.
//
// 가장 중요한 건 첫 번째 항목이다. 생성물을 저장소에 커밋하는 구조라
// index.html 을 고치고 재생성을 잊으면 배포된 페이지만 옛 데이터로 남는다.
// 그 상태를 여기서 잡는다.
const fs = require('fs');
const path = require('path');
const { ROOT, readIndex } = require('./lib/harness');
const { build, staleFiles, DIR, SITE, slug } = require(path.join(ROOT, 'tools', 'build-pages.js'));

const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = rel => fs.existsSync(path.join(ROOT, rel));
const pick = (html, re) => { const m = html.match(re); return m ? m[1] : null; };

module.exports = {
  name: '노선 페이지 생성물',
  needsBrowser: true,
  needsNetwork: false,

  async run(t, { browser, base }) {
    const { files, dest } = build();

    // ── 1. 저장소와 생성 결과가 같은가 ──
    t.section('생성물 최신 여부');
    const diff = [];
    for (const [rel, body] of files) {
      let cur = null;
      try { cur = read(rel); } catch { /* 없음 */ }
      if (cur !== body) diff.push(cur === null ? `없음: ${rel}` : `다름: ${rel}`);
    }
    const stale = staleFiles(new Set(files.keys()));
    t.ok(diff.length === 0, diff.length
      ? `index.html 과 어긋난 파일 ${diff.length}개 (${diff.slice(0, 3).join(', ')}…) → node tools/build-pages.js 실행 필요`
      : `생성물 ${files.size}개가 index.html 과 일치한다`);
    t.ok(stale.length === 0, stale.length
      ? `삭제되지 않은 옛 페이지: ${stale.join(', ')}` : '남아 있는 옛 페이지 없음');

    // ── 2. 파일 구성 ──
    t.section('파일 구성');
    const pageRels = dest.map(d => `${DIR}/${slug(d.n)}/index.html`);
    const missing = pageRels.filter(r => !exists(r));
    t.ok(missing.length === 0, missing.length
      ? `없는 페이지: ${missing.join(', ')}` : `목적지 ${dest.length}곳 페이지가 모두 있다`);
    t.ok(exists(`${DIR}/index.html`), '노선 목록 페이지가 있다');
    t.ok(exists('sitemap.xml') && exists('robots.txt'), 'sitemap.xml · robots.txt 가 있다');
    t.ok(exists('assets/dest.css') && exists('assets/dest.js'), '공용 css · js 가 있다');

    const pages = pageRels.map(rel => ({ rel, d: dest.find(x => `${DIR}/${slug(x.n)}/index.html` === rel), html: read(rel) }));

    // ── 3. 검색엔진이 보는 부분 ──
    // 제목·설명이 겹치면 중복 문서로 묶여 색인에서 빠진다. 페이지를 늘리는
    // 작업에서 가장 흔하게 나는 사고라 개수까지 확인한다.
    t.section('메타 정보');
    const titles = pages.map(p => pick(p.html, /<title>([^<]+)<\/title>/));
    t.ok(titles.every(Boolean), '모든 페이지에 title 이 있다');
    t.ok(new Set(titles).size === titles.length,
      `title 이 서로 다르다 (${new Set(titles).size}/${titles.length})`);
    const longTitle = titles.filter(s => s.length > 60);
    t.info(`title 최장 ${Math.max(...titles.map(s => s.length))}자`);
    t.ok(longTitle.length === 0, longTitle.length
      ? `60자를 넘는 title ${longTitle.length}개 (검색결과에서 잘립니다)` : 'title 길이가 모두 60자 이내');

    const descs = pages.map(p => pick(p.html, /<meta name="description" content="([^"]+)">/));
    t.ok(descs.every(Boolean), '모든 페이지에 description 이 있다');
    t.ok(new Set(descs).size === descs.length,
      `description 이 서로 다르다 (${new Set(descs).size}/${descs.length})`);
    t.ok(descs.every(s => s.length >= 60 && s.length <= 200),
      `description 길이가 60~200자 범위 (최소 ${Math.min(...descs.map(s => s.length))}자 / 최대 ${Math.max(...descs.map(s => s.length))}자)`);

    const badCanon = pages.filter(p => {
      const c = pick(p.html, /<link rel="canonical" href="([^"]+)">/);
      return decodeURIComponent(c || '') !== `${SITE}/${DIR}/${slug(p.d.n)}/`;
    });
    t.ok(badCanon.length === 0, badCanon.length
      ? `canonical 이 자기 주소와 다름: ${badCanon.map(p => p.d.n).join(', ')}` : 'canonical 이 모두 자기 주소를 가리킨다');
    t.ok(pages.every(p => p.html.includes(`<meta property="og:image" content="${SITE}/og.png">`)),
      'og:image 가 절대 URL 이다');
    t.ok(pages.every(p => /"@type":"BreadcrumbList"/.test(p.html)), '구조화 데이터(BreadcrumbList)가 있다');

    // ── 4. 본문 ──
    t.section('본문 내용');
    t.ok(pages.every(p => (p.html.match(/<h1>/g) || []).length === 1), 'h1 이 페이지마다 정확히 하나다');
    const noName = pages.filter(p => !new RegExp(`<h1>[^<]*${p.d.n.replace('·', '·')}`).test(p.html));
    t.ok(noName.length === 0, noName.length
      ? `h1 에 목적지 이름이 없음: ${noName.map(p => p.d.n).join(', ')}` : 'h1 에 목적지 이름이 들어 있다');

    // 요금·소요시간이 본문에 문자열로 있어야 검색결과 스니펫에 쓰인다
    const noFare = pages.filter(p => !p.html.includes(p.d.fare.toLocaleString('ko-KR') + '원'));
    t.ok(noFare.length === 0, noFare.length
      ? `요금이 본문에 없음: ${noFare.map(p => p.d.n).join(', ')}` : '요금이 모든 페이지 본문에 있다');

    // 막차는 검색 유입의 핵심 문구라 HTML 에 글자로 있어야 한다.
    // 자료가 없는 곳은 대신 안내가 있어야 하고, 빈 채로 두면 안 된다.
    const src2 = readIndex();
    const retNames = new Set([...src2.slice(src2.indexOf('const RETURN = {'))
      .matchAll(/"([^"]+)":\["NAEK/g)].map(m => m[1]));
    t.info(`역방향 자료 있는 목적지 ${retNames.size}곳`);
    const noLast = pages.filter(p => retNames.has(p.d.n) && !/서울 가는 막차/.test(p.html));
    t.ok(noLast.length === 0, noLast.length
      ? `막차 제목이 없음: ${noLast.map(p => p.d.n).join(', ')}` : '막차 자료가 있는 곳은 모두 막차 섹션이 있다');
    const noNotice = pages.filter(p => !retNames.has(p.d.n) && !/자료가 없습니다/.test(p.html));
    t.ok(noNotice.length === 0, noNotice.length
      ? `안내가 없음: ${noNotice.map(p => p.d.n).join(', ')}` : '자료가 없는 곳은 안내 문구로 대신한다');
    t.ok(pages.every(p => /<dt>서울행 막차<\/dt>/.test(p.html)), '정보 표에 막차 칸이 있다');

    const badSpots = pages.filter(p =>
      (p.html.match(/<li>\s*<a href="https:\/\/map\.naver\.com/g) || []).length < 2);
    t.ok(badSpots.length === 0, badSpots.length
      ? `볼거리 카드가 2개 미만: ${badSpots.map(p => p.d.n).join(', ')}` : '모든 페이지에 볼거리 카드가 2개 이상 있다');
    t.ok(pages.every(p => !/undefined|NaN|\[object Object\]/.test(p.html)),
      '템플릿이 새어 나온 흔적(undefined · NaN)이 없다');

    // 페이지 스크립트에 넘긴 값이 index.html 데이터와 같은지
    const badPayload = pages.filter(p => {
      const raw = pick(p.html, /window\.RT_PAGE=(\{.*?\});/);
      if (!raw) return true;
      const v = JSON.parse(raw);
      return v.n !== p.d.n || v.t !== p.d.t || v.dur !== p.d.dur || v.lat == null || v.lon == null;
    });
    t.ok(badPayload.length === 0, badPayload.length
      ? `RT_PAGE 값이 어긋남: ${badPayload.map(p => p.d.n).join(', ')}` : 'RT_PAGE 값이 목적지 데이터와 일치한다');

    // ── 5. 링크 ──
    // 깨진 내부 링크는 크롤러가 페이지를 버리는 이유가 된다.
    t.section('내부 링크');
    const allHtml = [...pages, { rel: `${DIR}/index.html`, html: read(`${DIR}/index.html`) }];
    const broken = new Set();
    for (const p of allHtml) {
      for (const m of p.html.matchAll(/href="(\/[^"#?]*)"/g)) {
        const href = decodeURIComponent(m[1]);
        if (href === '/') continue;
        const target = href.endsWith('/') ? href + 'index.html' : href;
        if (!exists(target.slice(1))) broken.add(`${p.rel} → ${href}`);
      }
    }
    t.ok(broken.size === 0, broken.size
      ? `깨진 내부 링크 ${broken.size}개: ${[...broken].slice(0, 3).join(', ')}` : '내부 링크가 모두 실제 파일을 가리킨다');
    t.ok(pages.every(p => p.html.includes(`href="/${DIR}/"`)), '모든 페이지가 노선 목록으로 돌아갈 수 있다');

    const hub = read(`${DIR}/index.html`);
    const linkedInHub = dest.filter(d => hub.includes(`/${DIR}/${encodeURIComponent(slug(d.n))}/`));
    t.ok(linkedInHub.length === dest.length,
      `노선 목록이 ${dest.length}곳을 모두 링크한다 (${linkedInHub.length}곳)`);
    t.ok(readIndex().includes(`href="/${DIR}/"`),
      '메인 페이지에서 노선 목록으로 가는 링크가 있다 (없으면 고아 문서가 된다)');

    // ── 6. sitemap · robots ──
    t.section('sitemap · robots');
    const sm = read('sitemap.xml');
    const locs = [...sm.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => decodeURIComponent(m[1]));
    t.info(`sitemap 항목 ${locs.length}개`);
    t.ok(locs.length === dest.length + 2, `홈·목록·목적지 ${dest.length}곳이 모두 올라 있다`);
    t.ok(new Set(locs).size === locs.length, 'sitemap 에 중복 주소가 없다');
    t.ok(locs.every(u => u.startsWith(SITE + '/')), '모든 주소가 절대 URL 이다');
    t.ok(!/<lastmod>/.test(sm), 'lastmod 를 넣지 않는다 (빌드마다 달라져 비교가 무의미해진다)');
    const rb = read('robots.txt');
    t.ok(/^User-agent: \*/m.test(rb) && rb.includes(`Sitemap: ${SITE}/sitemap.xml`),
      'robots.txt 가 sitemap 을 알려 준다');

    // ── 7. 브라우저에서 실제로 뜨는가 ──
    // 배차·날씨는 네트워크를 막고 본다. 외부 API 가 죽어도 페이지가
    // "불러오는 중…" 에서 멈추지 않고 안내 문구로 마무리돼야 한다.
    t.section('브라우저 동작');
    const ctx = await browser.newContext();
    await ctx.route('**api.open-meteo.com/**', r => r.abort());
    await ctx.route('**/api/tago*', r => r.abort());
    const errs = [];
    const page = await ctx.newPage();
    page.on('pageerror', e => errs.push(e.message));

    const sample = ['강릉', '고한·사북', '부산서부', '전주'].filter(n => dest.some(d => d.n === n));
    for (const n of sample) {
      await page.goto(`${base}/${DIR}/${encodeURIComponent(slug(n))}/`);
      const title = await page.title();
      t.ok(title.includes(n), `${n} 페이지가 열린다 (${title})`);
    }

    await page.waitForFunction(() => {
      const l = document.getElementById('live'), w = document.getElementById('weather');
      return l && !l.classList.contains('loading') && (!w || !w.classList.contains('loading'));
    }, null, { timeout: 10000 });
    const liveTxt = (await page.textContent('#live')).trim();
    t.info(`배차 실패 시 문구: ${liveTxt}`);
    t.ok(!liveTxt.includes('불러오는 중'), '배차 조회가 실패해도 "불러오는 중" 에서 멈추지 않는다');
    t.ok(liveTxt.includes('코버스'), '실패 시 코버스로 안내한다');
    t.ok(!(await page.textContent('#weather')).includes('불러오는 중'), '날씨 실패도 안내 문구로 마무리된다');

    const spotHrefs = await page.locator('.spots a').evaluateAll(as => as.map(a => a.getAttribute('href')));
    t.ok(spotHrefs.length > 0 && spotHrefs.every(h => h.startsWith('https://map.naver.com/p/search/')),
      `볼거리 ${spotHrefs.length}개가 지도 검색 링크다`);
    t.ok(await page.locator('.spots a').first().getAttribute('rel') === 'noopener',
      '외부 링크에 noopener 가 붙어 있다');

    await page.setViewportSize({ width: 390, height: 1200 });
    t.ok(!(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)),
      '모바일 390px 에서 가로 스크롤이 없다');

    await page.goto(`${base}/${DIR}/`);
    t.ok((await page.locator('.grid tbody tr').count()) === dest.length,
      `노선 목록 표에 ${dest.length}줄이 있다`);
    t.ok(!(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)),
      '노선 목록도 모바일에서 가로 스크롤이 없다');

    t.ok(errs.length === 0, errs.length ? `런타임 에러: ${errs.join(' | ')}` : '런타임 에러 없음');
    await ctx.close();
  },
};
