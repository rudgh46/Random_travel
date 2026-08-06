// 노선 상세 페이지의 동적 부분 — 오늘 배차(TAGO)와 목적지 날씨(Open-Meteo).
//
// 페이지에 필요한 값은 각 HTML 의 window.RT_PAGE 에 그 목적지 것만 박혀 있다.
// 여기서는 로직만 담당한다. 검색엔진에 보여야 하는 내용(요금·소요시간·볼거리)은
// 이미 HTML 에 들어 있으므로, 이 스크립트가 실패해도 페이지는 온전하다.
(function () {
  'use strict';
  var P = window.RT_PAGE;
  if (!P) return;

  var $ = function (id) { return document.getElementById(id); };
  var pad = function (n) { return String(n).padStart(2, '0'); };
  var won = function (n) { return n.toLocaleString('ko-KR') + '원'; };
  var todayIso = function () {
    var d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  };

  // ── 오늘 배차 ──
  // depPlandTime 은 "202608060600" 형태이며 숫자로 오는 경우가 있어 문자열로 맞춘다.
  var tagoTime = function (v) { return v == null ? '' : String(v); };
  var hhmm = function (v) {
    var s = tagoTime(v);
    return s.length >= 12 ? s.slice(8, 10) + ':' + s.slice(10, 12) : s;
  };

  var KOBUS = '<a href="https://www.kobus.co.kr" target="_blank" rel="noopener">코버스</a>';

  function liveFail(el) {
    el.className = 'live';
    el.innerHTML = '지금은 실시간 배차를 불러오지 못했습니다. 출발편과 잔여석은 ' + KOBUS + '에서 확인하세요.';
  }

  function renderLive(el, trips) {
    var now = new Date();
    var nowKey = todayIso().replace(/-/g, '') + pad(now.getHours()) + pad(now.getMinutes());
    var all = trips
      .map(function (t) { return { dep: tagoTime(t.dep), arr: tagoTime(t.arr), grade: t.grade, charge: t.charge }; })
      .filter(function (t) { return t.dep; })
      .sort(function (a, b) { return a.dep.localeCompare(b.dep); });
    if (!all.length) { liveFail(el); return; }

    var upcoming = all.filter(function (t) { return t.dep >= nowKey; });
    var fares = all.map(function (t) { return t.charge; }).filter(Boolean);
    var minF = fares.length ? Math.min.apply(null, fares) : null;
    var maxF = fares.length ? Math.max.apply(null, fares) : null;

    var head = [];
    if (upcoming.length) {
      var next = upcoming[0], arr = hhmm(next.arr);
      head.push('다음 출발 <b>' + hhmm(next.dep) + '</b>'
        + (arr ? ' → <b>' + arr + '</b> 도착' : '')
        + (next.grade ? ' (' + next.grade + ')' : ''));
    } else {
      head.push('오늘 남은 편이 없습니다');
    }
    if (minF) head.push('요금 <b>' + (minF === maxF ? won(minF) : won(minF) + '~' + won(maxF)) + '</b>');
    head.push('오늘 <b>' + all.length + '</b>편');

    // 남은 편을 최대 8개까지 시각표로 보여 준다(없으면 오늘 전체의 앞부분).
    var list = (upcoming.length ? upcoming : all).slice(0, 8);
    var rows = list.map(function (t) {
      var arr = hhmm(t.arr);
      return '<li><span>' + hhmm(t.dep) + '</span>'
        + (arr ? '<span>→ ' + arr + '</span>' : '')
        + (t.grade ? '<span class="g">' + t.grade + '</span>' : '')
        + (t.charge ? '<span class="c">' + won(t.charge) + '</span>' : '')
        + '</li>';
    }).join('');

    el.className = 'live';
    el.innerHTML = '<span class="badge">실제 배차</span>' + head.join(' · ')
      + '<ul class="trips">' + rows + '</ul>';
  }

  function loadLive() {
    var el = $('live');
    if (!el) return;
    var q = new URLSearchParams({
      mode: 'route',
      depHint: P.depHint,
      arr: P.arr,
      date: todayIso().replace(/-/g, ''),
    });
    if (P.depId) q.set('depId', P.depId);
    if (P.arrId) q.set('arrId', P.arrId);

    fetch('/api/tago?' + q)
      .then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.json(); })
      .then(function (d) {
        if (!d.trips || !d.trips.length) throw new Error('empty');
        renderLive(el, d.trips);
      })
      .catch(function () { liveFail(el); });
  }

  // ── 목적지 날씨 ──
  var WMO = [
    [[0], '☀️', '맑음'], [[1], '🌤', '대체로 맑음'], [[2], '⛅', '구름 조금'], [[3], '☁️', '흐림'],
    [[45, 48], '🌫', '안개'], [[51, 53, 55], '🌦', '이슬비'], [[56, 57], '🌧', '얼어붙는 비'],
    [[61, 63, 65], '🌧', '비'], [[66, 67], '🌧', '얼어붙는 비'], [[71, 73, 75], '❄️', '눈'],
    [[77], '🌨', '진눈깨비'], [[80, 81, 82], '🌦', '소나기'], [[85, 86], '🌨', '소나기눈'],
    [[95], '⛈', '뇌우'], [[96, 99], '⛈', '우박 뇌우'],
  ];
  var WET = [51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99];
  var SNOW = [71, 73, 75, 77, 85, 86];

  function wmo(code) {
    for (var i = 0; i < WMO.length; i++) if (WMO[i][0].indexOf(code) >= 0) return { icon: WMO[i][1], label: WMO[i][2] };
    return { icon: '🌡', label: '날씨' };
  }

  // 최저·최고와 강수확률이 모두 '오늘' 값이므로 상태 코드도 일별 값을 쓴다.
  // (현재 코드를 쓰면 "맑음 · 강수확률 82%" 같은 모순이 생긴다)
  function toW(r) {
    var day = r.daily || {}, cur = r.current || {};
    var code = (day.weather_code && day.weather_code[0] != null) ? day.weather_code[0]
      : (cur.weather_code != null ? cur.weather_code : null);
    var num = function (v) { return v == null ? null : Math.round(v); };
    var w = wmo(code);
    return {
      icon: w.icon, label: w.label, code: code,
      now: num(cur.temperature_2m),
      min: num(day.temperature_2m_min && day.temperature_2m_min[0]),
      max: num(day.temperature_2m_max && day.temperature_2m_max[0]),
      pop: day.precipitation_probability_max ? day.precipitation_probability_max[0] : null,
    };
  }

  function tip(w) {
    var rainy = w.pop != null && w.pop >= 60;
    if (SNOW.indexOf(w.code) >= 0) return '눈길 조심하세요. 이런 날엔 온천이 제철이에요.';
    if (WET.indexOf(w.code) >= 0 || rainy) return '실내 코스가 안전해요. 박물관·온천 쪽은 어때요?';
    if (w.max != null && w.max <= 5) return '많이 추워요. 온천·실내 위주로 계획해 보세요.';
    if (w.max != null && w.max >= 30) {
      return P.sea ? '더워요. 바다에 발 담그기 좋은 날이에요.' : '더워요. 계곡이나 물가 쪽이 시원할 거예요.';
    }
    if (w.code === 0 || w.code === 1) return P.sea ? '바다 보기 딱 좋은 날이에요.' : '나들이하기 좋은 날이에요.';
    return '무난한 날씨예요. 걷기 좋겠어요.';
  }

  function loadWeather() {
    var el = $('weather');
    if (!el) return;
    if (P.lat == null || P.lon == null) { el.remove(); return; }
    var iso = todayIso();
    var url = 'https://api.open-meteo.com/v1/forecast'
      + '?latitude=' + P.lat + '&longitude=' + P.lon
      + '&current=temperature_2m,weather_code'
      + '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max'
      + '&timezone=Asia%2FSeoul&start_date=' + iso + '&end_date=' + iso;

    fetch(url)
      .then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.json(); })
      .then(function (d) {
        var w = toW(d), parts = [];
        if (w.now != null) parts.push('지금 <b>' + w.now + '°</b>');
        if (w.min != null && w.max != null) parts.push(w.min + '° / ' + w.max + '°');
        if (w.pop != null) parts.push('강수확률 <b>' + w.pop + '%</b>');
        if (w.pop != null && w.pop >= 60) parts.push('우산 챙기세요');
        el.className = 'weather';
        el.innerHTML = '<span class="wbadge">' + w.icon + ' 오늘 ' + w.label + '</span>'
          + parts.join(' · ') + '<span class="wxtip">' + tip(w) + '</span>';
      })
      .catch(function () {
        el.className = 'weather';
        el.textContent = '날씨 정보를 불러오지 못했습니다.';
      });
  }

  loadLive();
  loadWeather();
})();
