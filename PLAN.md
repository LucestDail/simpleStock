# simpleStock 재설계 — 종합 주식·ETF 추적 관리 플랫폼

> 2026-09-01 계약(contract) 문서. "개인 자산 워크스페이스"(v2) → **개인정보를 뺀 범용 한국/미국 주식·ETF 티커 추적 관리 플랫폼**(v3)으로 전환.
> 진행은 이 문서에 기록한다(컨텍스트보다 오래 산다).

## 배경·목표

- 현재(v2): 개인 보유종목·평단가·계좌·투자자 프로필 기반의 **개인 자산 매니저**(Gemini 개인화 채팅/브리핑).
- 목표(v3): **개인정보 제거 + 관심종목(watchlist) 중심의 범용 종합 추적 플랫폼**. 한국/미국 주식·ETF 티커를 테마별로 묶어 시세·변동·비교 추적. myapi를 데이터 허브로 활용.

## 확정 결정 (2026-09-01)

1. **개인 자산 데이터** → **완전 제거(순수 트래커)**. 보유수량·평단가·계좌·자산평가 개념 폐기. 기존 보유데이터는 티커만 추출해 watchlist로 마이그레이션 후 개인필드 폐기.
2. **Gemini AI** → **범용 시장 브리핑으로 전환**. 개인 포트폴리오 대신 watchlist·시장 전반 분석. (.25 gateway 경유, 비용 발생 → 예약/수동 게이팅 유지)
3. **Watchlist 구조** → **테마별 그룹**. 예: "반도체", "미국 ETF", "배당주". 그룹 단위 관리·비교.

## 현재 구조 (코드 근거)

- 진입점: `server.js`(642줄, Express :50000) + `server/`(23모듈, ~8325줄). 파일기반 JSON 영속(`data/*.json`, `server/dataStore.js` 원자적 write+mutationQueue).
- **재활용(핵심자산, 그대로 유지)**:
  - `server/marketDataService.js`(1086줄): KR(myapi→공공데이터포털→Yahoo)·US(myapi/Finnhub/Yahoo)·FX·**ETF 별도조회**(`getSecuritiesPriceInfo`), TTL캐시·백오프·폴백. `listTrackedTickerConfigs()`가 추적대상 산출.
  - `server/tickerLookupService.js`(347줄): 종목명→코드 3단계(공공데이터→Yahoo→Gemini grounded)+실시세 검증.
  - `/api/market/status`·`/api/market/refresh`·`/api/stream`(SSE)·`server/realtimeService.js`.
  - 프론트 `LiveTickerBar.vue`·`MarketHeatmap.vue`.
- **제거(개인정보)**: `portfolio.json`(holdings 금액/수량/평단/계좌·snapshots)·`profile.json`(투자자 프로필)·`chat.json`(개인 채팅)·`memory.json`의 개인부(threadSummaries·longTermMemories·managerReports)·관련 서비스(`profileService`·`chatService`·`snapshotService`·`actionService`의 holding CRUD·`importPreviewService`/`structuredImportService`).
- ⚠️ 현 모델의 함정: "관찰용 종목"을 **수량 0 holding**으로 표현(watchlist=holdings 오버로드). v3에서 **독립 watchlist 엔티티**로 분리.

## 목표 아키텍처 (v3)

### 데이터 모델
- **신설 `data/watchlist.json`**: `{ groups: [ { id, name, order, tickers: [ { symbol, name, market('KR'|'US'|'ETF'), currency, addedAt } ] } ] }`
- **유지 `data/memory.json`**: `market`(시세캐시·fx·sessions)·`tickerLookup`만. 개인부 제거.
- **유지 `data/settings.json`**: 시세 프로바이더·AI 프리셋·토큰사용량.
- **폐기**: `portfolio.json`·`profile.json`·`chat.json`(백업 후 제거).

### 백엔드 API
- 신설 `server/watchlistService.js` + 라우트:
  - `GET /api/watchlist` — 전체 그룹+티커(+최신 시세 조인)
  - `POST /api/watchlist/groups` / `PUT /api/watchlist/groups/:id` / `DELETE /api/watchlist/groups/:id` / 순서변경
  - `POST /api/watchlist/groups/:id/tickers` — 종목 추가(입력=심볼 또는 종목명→`tickerLookupService`로 해석+실시세 검증)
  - `DELETE /api/watchlist/groups/:id/tickers/:symbol`
- `marketDataService.listTrackedTickerConfigs()` → **watchlist 그룹 기반**으로 소스 전환(holdings 의존 제거).
- 브리핑(`managerService`/`aiService`) → 입력을 watchlist·시장 데이터로 교체(개인 프로필 주입 제거). 라우트 `/api/briefing/run`(구 `/api/manager/run`).
- 제거 라우트: `/api/portfolio`·`/api/snapshots`·`/api/profile`·`/api/chat/*`·`/api/import/*`.

### 프론트엔드
- 제거: OverviewPanel(자산)·HoldingsPanel(금액)·ProfilePanel·ChatPanel·ManagerBriefPanel(포트폴리오)·ActivityPanel·SnapshotsPanel·InsightsPanel·관련 composables(usePortfolio·useProfile·useChat·useMemory).
- 신설: **WatchlistView**(테마 그룹 보드, 그룹별 종목카드+시세/등락)·**TickerDetail**(종목 상세)·**BriefingPanel**(범용 시장 브리핑).
- 유지·강화: LiveTickerBar·MarketHeatmap.

## 단계별 계획 (각 단계 "완료"=검증 체커)

### Phase 1 — 백엔드 코어 전환 (추가적·저위험)
- [ ] `server/watchlistService.js` 신설(그룹/티커 CRUD, dataStore 패턴 준수).
- [ ] `data/watchlist.json` 스키마 + `dataStore` 정규화 함수.
- [ ] `/api/watchlist/*` 라우트.
- [ ] `listTrackedTickerConfigs()` watchlist 기반 전환(holdings 폴백은 마이그레이션 후 제거).
- [ ] 마이그레이션 유틸: 기존 holdings→watchlist 티커 추출(개인필드 버림), 원본 백업.
- **완료 체커**: `npm test`(신규 watchlistService 테스트 GREEN + 기존 회귀) · 로컬 서버 스모크(`/api/watchlist` CRUD 왕복 curl).

### Phase 2 — AI 브리핑 범용화 + 개인 라우트 제거
- [ ] 브리핑 입력을 watchlist·시장으로 교체, 개인 프로필 의존 제거.
- [ ] 개인 라우트/서비스 제거(위 목록), 관련 테스트 정리.
- **완료 체커**: `npm test` GREEN · 브리핑 로컬 실행 시 개인정보 미참조 확인.

### Phase 3 — 프론트 재구성
- [ ] WatchlistView·TickerDetail·BriefingPanel 신설, 개인 패널 제거.
- **완료 체커**: `npm run build`(vite) GREEN · 로컬 브라우저 스모크.

### Phase 4 — .25 배포
- [ ] 데이터 마이그레이션(백업 필수) → docker rebuild → 게이트웨이(헤더 인증 하에) 검증.
- **완료 체커**: `.25` `/simpleStock/` 200(Basic 인증) · watchlist 실동작 · 회귀 없음.

## 데이터 안전 (필수)
- `.25`에 실제 개인 금융 데이터가 마운트됨(`~/simpleStock/data/*.json`). **삭제 금지 — 백업 후 마이그레이션.**
- 마이그레이션 = holdings에서 `{ticker,name,market,currency}`만 추출→watchlist 기본그룹. 개인필드(수량·평단·계좌·금액)는 버림. 원본 `data/*.json`은 `data/_archive-personal-20260901/`로 백업.
- 로컬 먼저 완성·검증 후 .25. 로컬↔.25 git 정합 확인(이전 드리프트 이력 있음 — 현재 둘 다 `f9071cc` 일치).

## 리스크·주의
- 8000+줄 리팩터 → 단계별 커밋·테스트로 회귀 관리.
- `marketDataService`는 건드리지 않는 게 원칙(추적소스 주입점만 교체).
- 커밋/배포는 사용자 승인 시점에.
