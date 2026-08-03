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

const SERVICE_BASE = "http://apis.data.go.kr/1613000/ExpBusInfoService";
const OP_TERMINALS = "getExpBusTrminlList";
const OP_ROUTE = "getStrtpntAlocFndExpbusInfo";

// 허용 오퍼레이션 화이트리스트 (임의 URL 프록시 남용 방지)
const ALLOWED_OPS = new Set([
  OP_TERMINALS,
  OP_ROUTE,
  "getExpBusGradList",
  "getCtyCodeList",
]);

// 웜 컨테이너 동안 터미널 목록을 캐시 (호출 절약)
let TERMINAL_CACHE = null;

const json = (statusCode, body) => ({
  statusCode,
  headers: {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "public, max-age=60",
    "Access-Control-Allow-Origin": "*",
  },
  body: JSON.stringify(body),
});

async function callTago(op, params, key) {
  const qs = new URLSearchParams({
    serviceKey: key, // Decoding 키 사용 → URLSearchParams가 인코딩 처리
    _type: "json",
    numOfRows: "200",
    pageNo: "1",
    ...params,
  });
  const url = `${SERVICE_BASE}/${op}?${qs.toString()}`;
  const res = await fetch(url);
  const text = await res.text();
  // 공공데이터포털은 오류 시 XML을 반환하기도 하므로 방어적으로 파싱
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    const e = new Error("TAGO 응답을 JSON으로 파싱하지 못했습니다.");
    e.raw = text.slice(0, 500);
    throw e;
  }
  const items = data?.response?.body?.items?.item;
  const header = data?.response?.header;
  if (header && header.resultCode && header.resultCode !== "00") {
    const e = new Error(header.resultMsg || "TAGO 오류");
    e.code = header.resultCode;
    throw e;
  }
  return items == null ? [] : Array.isArray(items) ? items : [items];
}

async function getTerminals(key) {
  if (TERMINAL_CACHE) return TERMINAL_CACHE;
  const items = await callTago(OP_TERMINALS, { numOfRows: "1000" }, key);
  TERMINAL_CACHE = items.map((t) => ({
    id: t.terminalId,
    name: t.terminalNm,
  }));
  return TERMINAL_CACHE;
}

// 이름으로 터미널 찾기: 정확히 시작 > 포함 > 종합/고속 선호 > 짧은 이름
function findTerminal(terminals, query, prefer) {
  const q = query.replace(/[·\s]/g, "");
  let cand = terminals.filter((t) => (t.name || "").replace(/\s/g, "").includes(q));
  if (cand.length === 0) return null;
  const score = (t) => {
    const n = (t.name || "").replace(/\s/g, "");
    let s = 0;
    if (n.startsWith(q)) s += 5;
    if (prefer && n.includes(prefer)) s += 3;
    if (/(종합|고속|터미널)/.test(n)) s += 1;
    s -= n.length * 0.05; // 짧을수록 가점
    return s;
  };
  cand.sort((a, b) => score(b) - score(a));
  return cand[0];
}

exports.handler = async (event) => {
  const key = process.env.TAGO_KEY;
  if (!key) {
    return json(500, { error: "TAGO_KEY 환경변수가 설정되지 않았습니다." });
  }

  const p = event.queryStringParameters || {};

  try {
    // ── 편의 모드: 터미널 목록 ──
    if (p.mode === "terminals") {
      const terminals = await getTerminals(key);
      return json(200, { count: terminals.length, terminals });
    }

    // ── 편의 모드: 출발지-도착지 운행정보 (이름 → ID 해석) ──
    if (p.mode === "route") {
      if (!p.arr) return json(400, { error: "arr(도착지 이름) 파라미터가 필요합니다." });
      const terminals = await getTerminals(key);

      // 출발지 힌트: 여러 후보를 순서대로 시도 (예: 서울경부, 센트럴시티)
      const depHints = (p.depHint || "서울경부").split(",").map((s) => s.trim());
      let dep = null;
      for (const h of depHints) {
        dep = findTerminal(terminals, h, "서울");
        if (dep) break;
      }
      const arr = findTerminal(terminals, p.arr);
      if (!dep || !arr) {
        return json(404, {
          error: "터미널 ID를 찾지 못했습니다.",
          depResolved: dep || null,
          arrResolved: arr || null,
        });
      }

      const params = { depTerminalId: dep.id, arrTerminalId: arr.id };
      if (p.date) params.depPlandTime = p.date; // YYYYMMDD (미지정 시 API 기본)

      const items = await callTago(OP_ROUTE, params, key);
      const trips = items.map((it) => ({
        dep: it.depPlandTime, // 보통 YYYYMMDDHHmm
        arr: it.arrPlandTime,
        grade: it.gradeNm,
        charge: Number(it.charge) || null,
        routeId: it.routeId,
      }));
      return json(200, {
        depTerminal: dep,
        arrTerminal: arr,
        count: trips.length,
        trips,
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
