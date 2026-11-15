# tabidori-web

타비도리 **검증 결과 화면**을 실제 스택으로 옮긴 첫 버전.
와이어프레임 `결과화면 v17`의 레이아웃(지도 전체 화면 · 하단 순서 스트립 · 어드바이저 캐릭터와 대화 패널 · 패턴 탭)을 그대로 따르고, 비교용 토글 4개(여백 없음 · 패널 반투명 · 패턴탭 헤더 · 어드바이저 마크)는 켠 상태로 고정했다.

## 스택

| 부분 | 기술 |
|---|---|
| 서버 | FastAPI (uv로 관리) |
| 화면 | Jinja2 템플릿 + htmx 2.0.4(`static/`에 포함) |
| 지도 | Google Maps JavaScript API (AdvancedMarkerElement, Polyline) |
| 이동시간 | Google Routes API `computeRoutes` (도보·자전거·자동차) |

## 실행

```bash
cp .env.example .env      # 키 입력
uv sync
uv run uvicorn app.main:app --reload
# → http://localhost:8000
```

### 필요한 Google Cloud 설정
- **Maps JavaScript API**, **Routes API** 사용 설정
- 지금은 `GOOGLE_MAPS_API_KEY` 하나로 지도와 Routes API를 같이 쓴다. 이 키는 페이지 소스에 노출되므로 콘솔에서 **API 제한**(Maps JavaScript API·Routes API만)을 걸어둔다.
- 키에 **HTTP 리퍼러 제한**을 걸면 서버의 Routes API 호출이 거부된다. 그때는 `GOOGLE_MAPS_BROWSER_KEY`(리퍼러 제한 `http://localhost:8000/*`)와 `GOOGLE_MAPS_SERVER_KEY`(Routes API만)로 나눈다 — 값이 있으면 공용 키보다 우선한다.

### Routes API 호출과 비용
- 서버를 켤 때 스팟 4곳의 6개 구간 × 3개 수단 = **최대 18회** 호출하고, 결과를 `.cache/routes.json`에 저장한다. 다음 실행부터는 캐시를 쓰므로 다시 호출하지 않는다.
- 다시 받고 싶으면 `.cache/routes.json`을 지운다. 호출을 끄려면 `.env`에 `USE_ROUTES_API=0`.
- 호출에 실패한 구간은 고정값으로 대신하고, 서버 콘솔에 `Routes API 실패 → 고정값 사용`으로 이유를 출력한다.

## 무엇이 실제로 동작하고, 무엇이 아직 데모인가

| 기능 | 상태 |
|---|---|
| 지도·핀·경로선 | **실제** (Google Maps) |
| 도보·자전거·자동차 이동시간과 경로 | **실제** (Routes API, 실패 시 고정값) |
| 일정 계산(도착·출발·종료 예상, 마감 후 도착 판정) | **실제** — 서버 `app/schedule.py` |
| 순서 드래그·체류시간·이동수단 변경 후 재계산 | **실제** — `/api/schedule` 호출 |
| 이동수단 자동 배정 | **실제** — 도보 15분 이하면 도보, 아니면 가장 빠른 수단(실측값끼리 비교). `app/schedule.py`의 `WALK_FIRST_MAX_MIN` |
| 패턴 비교(내 패턴/A/B 독립 편집), 되돌리기, 확정 모달 | 실제 (프론트 상태) |
| 큐레이션 목록·태그 필터·휴무 숨기기 | 실제 (htmx로 서버 조각 렌더) — 데이터는 데모용 5곳 |
| 자전거 이동시간 | **고정값** — Routes API가 일본 구간에 자전거 경로를 돌려주지 않음(실측: 6개 구간 모두 경로 없음) |
| 전철 이동시간 | **고정값** — Google API는 일본 대중교통 경로를 주지 않는 사례가 있어, 설계대로 NAVITIME 연결 예정 |
| 어드바이저 대화 응답 | 데모 (LangGraph Agent 미연결) |
| 스팟 추가 후 지도 반영, 확정 후 캘린더 연동 | 미구현 |
| 하드 제약 중 휴관일·총시간 초과·강수 시 실외 | 미구현 (마감 후 도착만 판정) |

데모 데이터: 교토 4곳(기온거리·야사카진자·마루야마공원·청수사), 9/20(일) 16:00 시작. 청수사 마감 17:10, 니시키시장 일요일 휴무는 **시연용 값**이다.

## 구조

```
app/
  main.py           # 라우트: 페이지, /api/schedule, htmx 조각
  schedule.py       # 일정 계산·제약 판정
  routes_client.py  # Routes API 호출 + 캐시 + 고정값 폴백
  data.py           # 데모 데이터
templates/
  result.html
  partials/         # htmx 조각 (큐레이션 그리드, 채팅)
static/             # app.css, app.js, htmx.min.js
```
