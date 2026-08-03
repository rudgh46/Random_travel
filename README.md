# 오늘의 랜덤 여행 🚌

서울고속버스터미널(경부·영동선)과 센트럴시티(호남선)에서 출발하는
랜덤 여행지를 뽑아주는 웹사이트입니다. 터미널·권역·예산·소요시간을 고르고
**출발!** 을 누르면 안내판이 돌아가다 목적지에서 멈추고, 탑승권 카드에
예상 요금·소요시간·등급·당일치기 여부를 보여줍니다.

Netlify에 배포하면 TAGO(공공데이터포털) API로 **오늘 실제 출발편·요금**을
탑승권에 실시간으로 얹습니다. 프록시가 없으면(로컬·GitHub Pages 등)
정적 예상값으로 조용히 동작합니다.

## 구조

```
index.html                    프론트 (정적, 그대로 열어도 동작)
netlify.toml                  Netlify 설정 (/api/tago → 함수)
netlify/functions/tago.js     TAGO 프록시 (API 키를 서버에만 보관)
```

## Netlify 배포

1. 이 저장소를 GitHub에 push
2. Netlify에서 **Add new site → Import an existing project** → 저장소 선택
3. 빌드 설정은 비워두면 됩니다 (`netlify.toml`이 publish=`.`, functions 경로를 지정)
4. **Site settings → Environment variables** 에 API 키 등록
   - Key: `TAGO_KEY`
   - Value: 공공데이터포털에서 발급받은 **Decoding(일반 인증키, 디코딩)** 값
5. 배포 후 함수는 `/api/tago` 로 호출됩니다.

> 키는 서버(함수)에서만 읽고 브라우저로는 절대 내려보내지 않습니다.
> 그래서 프론트 소스에 키가 노출되지 않습니다.

## 프록시 사용법 (`/api/tago`)

- 터미널 목록(디스커버리): `/api/tago?mode=terminals`
- 노선 운행정보(이름→ID 자동 해석):
  `/api/tago?mode=route&depHint=서울경부&arr=목포&date=YYYYMMDD`
- 통과 프록시(원하는 오퍼레이션 직접 호출):
  `/api/tago?op=getExpBusTrminlList&numOfRows=1000`

오퍼레이션 정확한 이름은 공공데이터포털
**국토교통부_(TAGO)_고속버스정보**(data.go.kr/data/15098522) 상세 페이지에서
확인할 수 있습니다. 함수의 `ALLOWED_OPS` 화이트리스트에 추가하면 통과 프록시로 쓸 수 있습니다.

## 로컬 실행

정적 파일이라 `index.html`을 브라우저로 열면 됩니다.
함수까지 로컬에서 테스트하려면 Netlify CLI:

```
npm i -g netlify-cli
export TAGO_KEY="발급받은_디코딩_키"
netlify dev
```

## 참고

경부·영동선 + 호남선(센트럴시티) 총 77개 대표 노선의 우등 기준 편도
예상 요금·소요시간을 내장했습니다. 실제 출발편·잔여석은 코버스(kobus.co.kr)에서
확인하세요. TAGO API는 배차·요금 정보를 제공하며, 실시간 잔여석·예매는 포함되지 않습니다.
