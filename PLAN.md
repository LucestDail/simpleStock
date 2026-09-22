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
- [x] `server/watchlistService.js` 신설(그룹/티커 CRUD, dataStore 패턴 준수).
- [x] `data/watchlist.json` 스키마 + `dataStore` 정규화 함수.
- [x] `/api/watchlist/*` 라우트.
- [x] `listTrackedTickerConfigs()` watchlist 기반 전환(holdings 폴백은 마이그레이션 후 제거).
- [x] 마이그레이션 유틸: 기존 holdings→watchlist 티커 추출(개인필드 버림), 원본 백업.
- **완료 체커**: `npm test`(신규 watchlistService 테스트 GREEN + 기존 회귀) · 로컬 서버 스모크(`/api/watchlist` CRUD 왕복 curl).

### Phase 2 — AI 브리핑 범용화 + 개인 라우트 제거
- [x] 브리핑 입력을 watchlist·시장으로 교체, 개인 프로필 의존 제거.
- [x] 개인 라우트/서비스 제거(위 목록), 관련 테스트 정리.
- **완료 체커**: `npm test` GREEN · 브리핑 로컬 실행 시 개인정보 미참조 확인.

### Phase 3 — 프론트 재구성
- [x] WatchlistView·TickerDetail·BriefingPanel 신설, 개인 패널 제거.
- **완료 체커**: `npm run build`(vite) GREEN · 로컬 브라우저 스모크.

### Phase 4 — .25 배포
- [x] 데이터 마이그레이션(백업 필수) → docker rebuild → 게이트웨이(헤더 인증 하에) 검증.
- **완료 체커**: `.25` `/simpleStock/` 200(Basic 인증) · watchlist 실동작 · 회귀 없음.

## 데이터 안전 (필수)
- `.25`에 실제 개인 금융 데이터가 마운트됨(`~/simpleStock/data/*.json`). **삭제 금지 — 백업 후 마이그레이션.**
- 마이그레이션 = holdings에서 `{ticker,name,market,currency}`만 추출→watchlist 기본그룹. 개인필드(수량·평단·계좌·금액)는 버림. 원본 `data/*.json`은 `data/_archive-personal-20260901/`로 백업.
- 로컬 먼저 완성·검증 후 .25. 로컬↔.25 git 정합 확인(이전 드리프트 이력 있음 — 현재 둘 다 `f9071cc` 일치).

## 리스크·주의
- 8000+줄 리팩터 → 단계별 커밋·테스트로 회귀 관리.
- `marketDataService`는 건드리지 않는 게 원칙(추적소스 주입점만 교체).
- 커밋/배포는 사용자 승인 시점에.

## ✅ 완료 상태 (2026-09-01)
Phase 1~4 전부 완료 + 후속 완결. 커밋(푸시): `291d43c`(재설계)·`3557323`(X-Access-Token)·`3800e14`(브리핑키픽스)·`989bc94`(고아정리)·`a828e72`(개인결합 완전분리). .25 docker 재배포. 검증: 서버 36/36 + .25 통합 21/21 + HARU stock_portfolio 실WS + 외부 8030 게이팅 Lightsail 실측(401/200). HARU 연동 `43d597b`(/api/watchlist repoint). 잔여 없음.

---

# §16. 자동 매매 · 트리거 정의 (2026-09-22 확정 — 사용자 요청 ③④)

> 사용자: *"자동 매수/매도와 관련한 내용 정의 필요"* · *"모멘텀 이벤트 감지 및 장초/장중/장마감
> 매수/매도 요청 관련 부분 정의 필요"*. 아래는 **현재 구현 그대로**를 명문화한 것이다.
> 코드와 어긋나면 코드가 아니라 **이 문서가 틀린 것**이니 고칠 것.

## 16.1 "자동" 의 경계 — 무엇이 자동이고 무엇이 아닌가

```
자동인 것                                     자동이 아닌 것 (사람 필수)
──────────────────────────────────────        ─────────────────────────────────
분석 트리거(브리핑 6회 + 모멘텀)               🔴 주문 실행 — 예외 없음
종목 판단(stance BUY/SELL/HOLD + 확신도)       승인(폰/화면 1탭)
매수·매도 제안 생성 + 폰 알림                   전송(폰/화면 1탭 — 두 번째 탭)
계좌 사전검증(현금·매도가능수량)                 제안 만료 후 재산출 지시
가격 레벨·수량 산출(위험예산 기반)
```
- **자동 실행 경로는 0 개**다. `execute()` 호출부는 정확히 2곳(폰 `go:` 콜백 · 화면 버튼)이고
  둘 다 사람 입력이 방아쇠다. `orderExecuteRule` 계열 테스트가 구조로 잠근다.
- ⇒ **트리거가 오작동해도 사람이 안 누르면 돈은 움직이지 않는다.** 이것이 전체 안전 논리의 뿌리다.

## 16.2 제안이 만들어지는 조건 (전부 통과해야 폰에 온다)

```
① 모델 판단      stance ∈ {BUY, SELL} (HOLD 는 제안 없음 — 15:30 실증에서 {HOLD:2} → 제안 0)
② 매수 유의사항   정리매매·거래정지·투자경고·VI 종목은 점수 무관 매수 제안 금지
③ 계좌 사전검증   BUY → 매수가능금액 · SELL → 매도가능수량. 🔴 못 물어봤으면(unknown) 통과가 아니라 차단
④ 형식 검증      LIMIT 필수(가격 없으면 거부) · KR 호가단위 · 소수점 규칙 (orderRules)
⑤ 현금 0 이면    "신규 매수 제안을 내지 마세요" 가 프롬프트에 박힌다 (16.4 참조)
```
- 제안 TTL **10분**(토스 멱등키 유효기간과 맞물림 — `orderTtlRule` 테스트가 관계를 잠근다)
- 수량 = 위험예산 ÷ 주당손실. **위험예산 = 계좌평가액 × `riskPerTradePct`(사용자 설정)** —
  코드가 임의로 정하지 않는다

## 16.3 트리거 정의 — 언제 분석이 도는가

```
종류        발동 조건                              쿨다운   비고
──────      ─────────────────────────────          ──────   ─────────────────────────
개장(open)  세션 pre → open **전이**               우회     정규장(데이장) 시작. 프리마켓 아님
장중(mid)   정규장 **중간점 통과** (캘린더 유도)     우회     지나쳤으면 건너뜀(늦은 "중간보고" 금지)
마감(close) 세션 open → closed **전이**            우회     마감 요약은 늦으면 의미가 줄어 우회
모멘텀      감시 종목 일변동 z ≥ 2σ **돌파 순간**    30분     내려와야(z<1.4σ) 표시가 풀림 — 재돌파는 새 사건
```
- 전부 **전이(edge) 트리거**다 — 상태가 유지되는 동안 반복 발동하지 않는다
- 시각은 **거래소 캘린더에서 유도**(서머타임·조기폐장·공휴일 자동 추종). 고정 시각 없음
- 모멘텀 감시 대상 = **사용자가 별(watch)을 켠 종목만** + 보유 + 최근 매도(재진입 후보 20일)
- 쿨다운에 걸린 모멘텀은 **버리지 않고 쌓았다가** 다음 실행에 함께 넘긴다
- 겹침(분석 중 새 트리거): 예정 브리핑은 **이월**, 모멘텀은 폐기(지나간 돌파를 늦게 알리는 건 거짓)

## 16.4 장초/장중/장마감 매수·매도 요청의 성격 차이 (프롬프트 계약)

```
개장   직전 세션 흐름 + 시가 갭 → 오늘 관전 포인트 중심. 성급한 제안 억제
장중   개장 그림 대비 유지/변화 판정. **바뀐 게 없으면 없다고 말하라**(억지 제안 금지)
마감   결과 정리 + 다음 세션 지침. 🔴 장이 닫혔으므로 "지금 집행" 표현 금지 —
       제안이 나오면 다음 개장 대비용이며, TTL 10분이라 **사람이 즉시 판단할 때만 의미**
```
- 보유가 없는 시장(현재 국장)은 **종목 판단 대신 시황 브리핑**(지수 수급 4주체 포함)

## 16.5 아직 정의하지 않은 것 (일부러 — 사람 결정 대기)

```
- 자동 실행(사람 없이 체결)         → 하지 않기로 함. 바꾸려면 사용자 명시 지시 필요
- 마감 제안의 "다음 개장 예약 주문"  → 조건주문(스탑로스) API 는 배선돼 있으나 자동 발행은 미정의
- 물타기/분할매수 자동 제안 규칙     → 재진입(reentry) 후보 감시까지만 구현. 수량 분할 규칙 미정의
```
