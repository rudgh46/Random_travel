// Netlify Function: TAGO 고속버스정보 프록시
// - API 키(TAGO_KEY)는 서버에만 두고, 브라우저에는 절대 노출하지 않는다.
// - 기본은 "통과(passthrough)" 프록시: ?op=<오퍼레이션명>&<그 외 파라미터>
// - 편의 모드:
//     ?mode=terminals                        → 터미널 목록(디스커버리용)
//     ?mode=route&depHint=서울&arr=목포&date=YYYYMMDD
//                                            → 이름으로 터미널 ID를 찾아 운행정보 조회
//
// TAGO 고속버스정보 서비스 기본 URL (data.go.kr 15098522)
//   http://apis.data.go.kr/1613000/ExpBusInfoService/<operation>
// 대표 오퍼레이션(계정 화면의 "활용신청 상세"에서 정확한 이름 확인 가능):
//   getExpBusTrminlList              고속버스 터미널 목록
//   getStrtpntAlocFndExpbusInfo      출/도착지 기반 고속버스 운행정보
//   getExpBusGradList                고속버스 등급 목록
//   getCtyCodeList                   도시코드 목록

const SERVICE_BASE = "https://apis.data.go.kr/1613000/ExpBusInfo";
const OP_TERMINALS = "GetExpBusTrminlList";
const OP_ROUTE = "GetStrtpntAlocFndExpbusInfo";

// probe 모드에서 시험할 서비스/오퍼레이션 후보 (계정마다 철자가 다를 수 있어 자동 탐색)
const PROBE_BASES = [
  "https://apis.data.go.kr/1613000/ExpBusInfo",
  "https://apis.data.go.kr/1613000/ExpBusInfoService",
];
const PROBE_OPS = [
  "getExpBusTrminlList",
  "getExpBusTmnList",
  "getExpBusTerminalList",
  "getExpBusTrminl",
];

// 인증키 정규화: 이미 인코딩된(Encoding) 키(%2B 등)는 한번 디코딩해서
// URLSearchParams가 이중 인코딩(%252B)하지 않도록 한다.
function normalizeKey(key) {
  if (key && key.includes("%")) {
    try { return decodeURIComponent(key); } catch { return key; }
  }
  return key;
}

// 게이트웨이는 "인코딩 키"(%2B... 형태)만 인식한다.
// 환경변수에 디코딩 키(+, /, = 원문)를 넣었거나 앞뒤 공백/줄바꿈이 섞여도 동작하게 보정.
function encodedKey(key) {
  if (!key) return key;
  const k = key.trim();
  return k.includes("%") ? k : encodeURIComponent(k);
}

// 노선 조회 시 시도할 터미널 ID 후보 수 상한.
// 같은 이름에 ID가 여러 개라 조합을 시도해야 하지만, 요청이 무한히 늘지 않게 제한한다.
// 도착지는 같은 이름이 여러 개인 경우가 흔하다. 전주는 NAEK600~604 다섯 개가
// 모두 "전주"인데 실제 노선은 NAEK602 에만 있어, 후보를 넉넉히 시도해야 한다.
const MAX_DEP_CANDS = 3;
const MAX_ARR_CANDS = 4;
const MAX_ROUTE_TRIES = 8;

// 허용 오퍼레이션 화이트리스트 (임의 URL 프록시 남용 방지)
const ALLOWED_OPS = new Set([
  OP_TERMINALS,
  OP_ROUTE,
  "GetExpBusGradList",
  "GetCtyCodeList",
]);

const json = (statusCode, body) => ({
  statusCode,
  headers: {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "public, max-age=60",
    "Access-Control-Allow-Origin": "*",
  },
  body: JSON.stringify(body),
});

// 요청 URL 조립: serviceKey는 이미 인코딩된 값이므로 그대로 붙이고
// 나머지 파라미터만 encodeURIComponent 처리한다(이중 인코딩/키 유실 방지).
function buildUrl(base, op, key, params) {
  const extra = Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  return `${base}/${op}?serviceKey=${key}${extra ? "&" + extra : ""}`;
}

async function callTago(op, params, key) {
  const url = buildUrl(SERVICE_BASE, op, key, {
    _type: "json",
    numOfRows: "200",
    pageNo: "1",
    ...params,
  });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  let res, text;
  try {
    res = await fetch(url, { signal: ctrl.signal });
    text = await res.text();
  } catch (err) {
    const e = new Error(
      err.name === "AbortError"
        ? "TAGO 응답이 8초 내에 오지 않았습니다(타임아웃)."
        : "TAGO 호출 실패: " + err.message
    );
    e.code = err.name;
    throw e;
  } finally {
    clearTimeout(timer);
  }
  // 공공데이터포털은 오류 시 XML을 반환하기도 하므로 방어적으로 파싱
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    const e = new Error("TAGO 응답을 JSON으로 파싱하지 못했습니다.");
    e.raw = text.slice(0, 500);
    throw e;
  }
  // 게이트웨이 레벨 오류(서비스 경로/키 문제)는 여기로 온다
  const gw = data?.OpenAPI_ServiceResponse?.cmmMsgHeader;
  if (gw && gw.returnReasonCode && gw.returnReasonCode !== "00") {
    const e = new Error(gw.returnAuthMsg || gw.errMsg || "게이트웨이 오류");
    e.code = gw.returnReasonCode;
    e.errMsg = gw.errMsg;
    throw e;
  }
  // 응답 래핑이 두 가지다:
  //   구형: { response: { header, body: { items: { item: [...] } } } }
  //   신형: { header, body: { items: [...] } }   ← 현재 ExpBusInfo 서비스
  const env = data?.response ?? data;
  const header = env?.header;
  if (header && header.resultCode && header.resultCode !== "00") {
    const e = new Error(header.resultMsg || "TAGO 오류");
    e.code = header.resultCode;
    throw e;
  }
  const raw = env?.body?.items;
  const items = raw?.item ?? raw;
  return items == null ? [] : Array.isArray(items) ? items : [items];
}

// 이름(terminalNm)으로 터미널 검색 → 점수 순 후보 목록
// 이 API는 terminalNm 파라미터로 부분일치 검색을 지원한다(전체 목록 조회는 안 됨).
//
// 중요: 같은 이름에 터미널 ID가 여러 개 있고, 노선에 따라 유효한 ID가 다르다.
//   NAEK020 센트럴시티(서울) → 목포 0편
//   NAEK021 센트럴시티(서울) → 목포 15편
//   동서울은 NAEK030/031/032/035 네 개
// 그래서 하나만 고르면 노선 조회가 빈 결과로 나온다. 후보를 돌려주고
// 호출부에서 결과가 있는 조합을 찾는다.
// 괄호 안 부가 표기와 가운뎃점을 떼고 비교한다.
// "광주(유·스퀘어)" 가 광주 고속버스터미널인데, 괄호를 그대로 두고 비교하면
// 정확일치로 인정되지 않아 "광주비아" 같은 짧은 정류소가 이긴다.
const baseName = (s) => (s || "").replace(/\([^)]*\)/g, "").replace(/[·\s]/g, "");

async function searchTerminals(query, key, prefer, limit = 3) {
  const q = baseName(query);
  const items = await callTago(OP_TERMINALS, { terminalNm: q, numOfRows: "50" }, key);
  const seen = new Set();
  const cand = [];
  for (const t of items) {
    if (!t.terminalId || seen.has(t.terminalId)) continue;
    // "_수수료" 는 정산용 더미 항목, "시외" 는 다른 서비스의 터미널이다
    if (/_수수료|시외/.test(t.terminalNm || "")) continue;
    seen.add(t.terminalId);
    cand.push({ id: t.terminalId, name: t.terminalNm });
  }
  if (cand.length === 0) return [];
  const score = (t) => {
    const b = baseName(t.name);
    let s = 0;
    if (b === q) s += 10;
    else if (b.startsWith(q)) s += 5;
    else if (b.includes(q)) s += 2;
    if (prefer && (t.name || "").includes(prefer)) s += 3;
    if (/고속/.test(t.name || "")) s += 1;
    s -= b.length * 0.05; // 같은 점수면 짧은 쪽을 먼저
    return s;
  };
  cand.sort((a, b) => score(b) - score(a));
  return cand.slice(0, limit);
}

exports.handler = async (event) => {
  const rawKey = process.env.TAGO_KEY;
  if (!rawKey) {
    return json(500, { error: "TAGO_KEY 환경변수가 설정되지 않았습니다." });
  }
  const key = encodedKey(rawKey);

  const p = event.queryStringParameters || {};

  try {
    // ── 진단: 함수가 만드는 실제 요청 URL을 그대로 반환(브라우저 비교용) ──
    if (p.showurl === "1") {
      const op = p.op || OP_TERMINALS;
      const { showurl: _s, op: _o, mode: _m, ...extra } = p;
      const fullUrl = buildUrl(SERVICE_BASE, op, key, {
        _type: "json",
        numOfRows: p.numOfRows || "10",
        pageNo: "1",
        ...extra,
      });
      return json(200, { note: "이 URL을 브라우저 주소창에 그대로 붙여 결과를 비교하세요.", fullUrl });
    }

    // ── 키 점검: 값은 노출하지 않고 존재/길이/형태만 ──
    if (p.keycheck === "1") {
      const nk = normalizeKey(rawKey);
      return json(200, {
        hasKey: !!rawKey,
        rawLen: rawKey.length,
        normLen: nk ? nk.length : 0,
        sentLen: key.length,              // 실제로 URL에 붙는 길이
        rawHasPercent: rawKey.includes("%"),
        rawHasWhitespace: /\s/.test(rawKey), // 환경변수에 줄바꿈/공백이 섞였는지
        head: rawKey.slice(0, 4),
        tail: rawKey.slice(-4),
      });
    }
    // ── 탐색 모드: 서비스/오퍼레이션 후보를 자동 시험 ──
    if (p.probe === "1") {
      const results = [];
      for (const base of PROBE_BASES) {
        for (const op of PROBE_OPS) {
          const url = buildUrl(base, op, key, { _type: "json", numOfRows: "1", pageNo: "1" });
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 6000);
          let note;
          try {
            const r = await fetch(url, { signal: ctrl.signal });
            const t = await r.text();
            let code = null, msg = null;
            try {
              const j = JSON.parse(t);
              const h = (j?.response ?? j)?.header;
              code = h?.resultCode ?? null;
              msg = h?.resultMsg ?? null;
            } catch {
              const m1 = t.match(/returnReasonCode>?\"?:?\s*\"?(\d+)/);
              const m2 = t.match(/(errMsg|returnAuthMsg)\"?:?\s*\"?([^\"<]+)/);
              code = m1 ? m1[1] : "?";
              msg = m2 ? m2[2] : t.slice(0, 80);
            }
            note = { ok: code === "00", code, msg };
          } catch (e) {
            note = { ok: false, code: e.name, msg: e.message };
          } finally {
            clearTimeout(timer);
          }
          results.push({ base: base.replace("https://apis.data.go.kr/1613000/", ""), op, ...note });
        }
      }
      const hit = results.find((r) => r.ok);
      return json(200, { hit: hit || null, results });
    }

    // ── 진단 모드: TAGO 원본 응답을 그대로 반환 ──
    if (p.debug === "1") {
      const op = p.op || OP_TERMINALS;
      const { debug: _d, op: _o, mode: _m, ...extra } = p;
      const url = buildUrl(SERVICE_BASE, op, key, {
        _type: "json",
        numOfRows: p.numOfRows || "10",
        pageNo: "1",
        ...extra,
      });
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      let raw;
      try {
        const r = await fetch(url, { signal: ctrl.signal });
        raw = await r.text();
      } finally {
        clearTimeout(timer);
      }
      return json(200, { op, sentUrlMasked: url.replace(key, "***KEY***"), raw: raw.slice(0, 1500) });
    }
    // ── 편의 모드: 터미널 검색 (terminalNm 필수) ──
    if (p.mode === "terminals") {
      const nm = (p.q || p.terminalNm || "").trim();
      if (!nm) return json(400, { error: "q(터미널명) 파라미터가 필요합니다. 예: ?mode=terminals&q=센트럴" });
      const items = await callTago(OP_TERMINALS, { terminalNm: nm, numOfRows: "50" }, key);
      const terminals = items.map((t) => ({ id: t.terminalId, name: t.terminalNm }));
      return json(200, { count: terminals.length, terminals });
    }

    // ── 편의 모드: 출발지-도착지 운행정보 (이름 → ID 해석) ──
    if (p.mode === "route") {
      if (!p.arr) return json(400, { error: "arr(도착지 이름) 파라미터가 필요합니다." });

      // depId / arrId 로 터미널을 직접 지정하면 검색과 조합 시도를 건너뛴다.
      // 서울 출발은 NAEK010(경부) · NAEK021(호남)로 고정할 수 있어 호출이 줄어든다.
      // (같은 이름의 NAEK020 은 노선이 없어 매번 헛시도가 된다)
      const ID_RE = /^NAEK\d{3,4}$/;
      const depCands = [];
      const arrCands = [];

      if (p.depId && ID_RE.test(p.depId)) {
        depCands.push({ id: p.depId, name: p.depHint || p.depId });
      } else {
        // 출발지 힌트를 순서대로 검색해 후보를 모은다 (예: 센트럴시티, 서울호남)
        const depHints = (p.depHint || "서울경부").split(",").map((s) => s.trim()).filter(Boolean);
        const seenDep = new Set();
        for (const h of depHints) {
          for (const c of await searchTerminals(h, key, "서울")) {
            if (seenDep.has(c.id)) continue;
            seenDep.add(c.id);
            depCands.push(c);
          }
          if (depCands.length >= MAX_DEP_CANDS) break;
        }
      }

      if (p.arrId && ID_RE.test(p.arrId)) {
        arrCands.push({ id: p.arrId, name: p.arr || p.arrId });
      } else {
        arrCands.push(...await searchTerminals(p.arr, key, null, MAX_ARR_CANDS));
      }

      if (depCands.length === 0 || arrCands.length === 0) {
        return json(404, {
          error: "터미널 ID를 찾지 못했습니다.",
          depCandidates: depCands,
          arrCandidates: arrCands,
        });
      }

      // 같은 이름에 ID가 여러 개이므로, 결과가 나오는 조합을 찾을 때까지 시도한다.
      let hit = null;
      const tried = [];
      outer:
      for (const dep of depCands.slice(0, MAX_DEP_CANDS)) {
        for (const arr of arrCands) {
          const params = { depTerminalId: dep.id, arrTerminalId: arr.id };
          if (p.date) params.depPlandTime = p.date; // YYYYMMDD (미지정 시 API 기본)
          const items = await callTago(OP_ROUTE, params, key);
          tried.push(`${dep.id}>${arr.id}:${items.length}`);
          if (items.length > 0) { hit = { dep, arr, items }; break outer; }
          if (tried.length >= MAX_ROUTE_TRIES) break outer;
        }
      }

      const dep = hit ? hit.dep : depCands[0];
      const arr = hit ? hit.arr : arrCands[0];
      const items = hit ? hit.items : [];

      // depPlandTime 은 숫자(202608050600)로 오기도 한다. 문자열로 고정해
      // 프론트엔드가 길이·정렬을 안전하게 다룰 수 있게 한다.
      const trips = items.map((it) => ({
        dep: it.depPlandTime == null ? null : String(it.depPlandTime), // YYYYMMDDHHmm
        arr: it.arrPlandTime == null ? null : String(it.arrPlandTime),
        grade: it.gradeNm,
        charge: Number(it.charge) || null,
        routeId: it.routeId,
      }));
      return json(200, {
        depTerminal: dep,
        arrTerminal: arr,
        count: trips.length,
        trips,
        tried, // 진단용: 어떤 ID 조합을 몇 편으로 확인했는지
      });
    }

    // ── 기본: 통과 프록시 ──
    const op = p.op;
    if (!op || !ALLOWED_OPS.has(op)) {
      return json(400, {
        error: "허용되지 않은 op 입니다.",
        allowed: [...ALLOWED_OPS],
      });
    }
    const { op: _omit, mode: _m, ...rest } = p;
    const items = await callTago(op, rest, key);
    return json(200, { count: items.length, items });
  } catch (err) {
    return json(502, { error: err.message, code: err.code, raw: err.raw });
  }
};