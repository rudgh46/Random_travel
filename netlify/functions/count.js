// Netlify Function: 뽑기 횟수 카운터
//
//   GET  /api/count            현재 집계 조회
//   POST /api/count?to=강릉    한 번 뽑았다고 기록하고 집계 반환
//
// 저장소는 Upstash Redis 의 REST API 를 쓴다. 이유는 두 가지다.
//   · 이 저장소는 HTTP 로 직접 호출되므로 npm 의존성이 필요 없다. 저장소 루트에
//     package.json 을 두면 Netlify 가 배포할 때 npm install 을 돌리는데,
//     현재는 빌드 없이 파일만 올리는 구조라 그걸 유지하고 싶다.
//   · Redis 의 INCR·ZINCRBY 가 원자적이라 동시 요청에도 숫자가 어긋나지 않는다.
//
// 환경변수가 없으면 {enabled:false} 만 돌려준다. TAGO 프록시와 같은 규약으로,
// 프론트엔드는 이 경우 카운터 줄을 아예 그리지 않는다(없어도 사이트는 온전하다).
//   UPSTASH_REDIS_REST_URL
//   UPSTASH_REDIS_REST_TOKEN

const KEY_TOTAL = "spin:total";        // 누적 뽑기 횟수
const KEY_RANK = "spin:rank";          // 목적지별 횟수 (sorted set)
const KEY_THROTTLE = "spin:ip:";       // IP 별 연타 방지

// 이 횟수를 넘기 전에는 프론트엔드에 숫자를 내려보내지 않는다.
// 한 자리 수가 찍혀 있으면 없는 것보다 나쁘다.
const SHOW_FROM = 100;

const THROTTLE_SEC = 2;                // 같은 IP 의 연속 기록 최소 간격
const NAME_MAX = 20;

const json = (statusCode, body) => ({
  statusCode,
  headers: {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  },
  body: JSON.stringify(body),
});

const conf = () => ({
  url: (process.env.UPSTASH_REDIS_REST_URL || "").trim().replace(/\/+$/, ""),
  token: (process.env.UPSTASH_REDIS_REST_TOKEN || "").trim(),
});

// Upstash REST 는 명령을 경로로 받는다: /INCR/spin:total
// 파이프라인(/pipeline)에 배열을 넘기면 여러 명령을 한 번의 왕복으로 처리한다.
async function redis(cmds) {
  const { url, token } = conf();
  const res = await fetch(`${url}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmds),
  });
  if (!res.ok) throw new Error(`upstash http ${res.status}`);
  const out = await res.json();
  if (!Array.isArray(out)) throw new Error("upstash 응답 형태가 예상과 다름");
  return out.map(r => (r && r.error ? null : r && r.result));
}

// 목적지 이름 정규화. 집계 키에 들어가므로 길이와 문자를 제한한다.
function cleanName(v) {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s || s.length > NAME_MAX) return null;
  // 한글·영숫자·중점·띄어쓰기만 허용.
  // \s 를 쓰면 개행과 탭까지 통과해 Redis 키에 제어문자가 섞인다(테스트가 잡았다).
  return /^[가-힣A-Za-z0-9· ]+$/.test(s) ? s : null;
}

// 표시용 집계로 정리. 기준 미달이면 숫자를 감춘다.
function shape(total, top) {
  const n = Number(total) || 0;
  if (n < SHOW_FROM) return { enabled: true, visible: false, showFrom: SHOW_FROM };
  return {
    enabled: true, visible: true, total: n,
    top: top && top[0] ? { n: top[0], count: Number(top[1]) || 0 } : null,
  };
}

exports.handler = async (event) => {
  const { url, token } = conf();
  if (!url || !token) return json(200, { enabled: false });

  const method = (event.httpMethod || "GET").toUpperCase();
  if (method === "OPTIONS") {
    return { statusCode: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST", "Access-Control-Allow-Headers": "Content-Type" }, body: "" };
  }

  try {
    // 조회만
    if (method !== "POST") {
      const [total, top] = await redis([
        ["GET", KEY_TOTAL],
        ["ZREVRANGE", KEY_RANK, "0", "0", "WITHSCORES"],
      ]);
      return json(200, shape(total, top));
    }

    // 기록. 누구나 부를 수 있는 경로라 같은 IP 의 연타는 흘려보낸다.
    // 숫자를 부풀리려는 시도를 완전히 막지는 못하지만(재미용 집계다),
    // 실수로 뽑기를 연달아 눌렀을 때 과하게 세는 것은 막는다.
    const ip = (event.headers?.["x-nf-client-connection-ip"]
      || (event.headers?.["x-forwarded-for"] || "").split(",")[0]
      || "unknown").trim();
    const params = event.queryStringParameters || {};
    const name = cleanName(params.to);

    const [gate] = await redis([["SET", KEY_THROTTLE + ip, "1", "NX", "EX", String(THROTTLE_SEC)]]);
    if (gate === null || gate === undefined) {
      // 간격 안이면 세지 않고 현재 값만 돌려준다
      const [total, top] = await redis([
        ["GET", KEY_TOTAL],
        ["ZREVRANGE", KEY_RANK, "0", "0", "WITHSCORES"],
      ]);
      return json(200, { ...shape(total, top), throttled: true });
    }

    const cmds = [["INCR", KEY_TOTAL]];
    if (name) cmds.push(["ZINCRBY", KEY_RANK, "1", name]);
    cmds.push(["ZREVRANGE", KEY_RANK, "0", "0", "WITHSCORES"]);
    const out = await redis(cmds);
    const total = out[0];
    const top = out[out.length - 1];
    return json(200, shape(total, top));
  } catch (e) {
    // 저장소가 죽어도 사이트는 멀쩡해야 한다
    return json(200, { enabled: false, error: String(e && e.message) });
  }
};

module.exports.SHOW_FROM = SHOW_FROM;
module.exports.cleanName = cleanName;
module.exports.shape = shape;
