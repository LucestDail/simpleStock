# SimpleStock

개인 전용 **자산 현황 · 일별 변동 · 시세 연동 · AI 매니저** 통합 워크스페이스. 보유 자산을 한 화면(Workspace)에서 보고, Gemini 기반 채팅·매니저 브리핑·예약 작업으로 분석을 자동화합니다.

**저장소:** [github.com/LucestDail/simpleStock](https://github.com/LucestDail/simpleStock)  
**로드맵:** [PLAN.md](./PLAN.md)

## 설계 원칙 (고정)

- **저장소 = 물리 파일만** — `data/*.json`이 유일한 DB입니다. SQLite·Postgres·Redis 등 **별도 DB 설치·연동은 하지 않습니다.**
- **프로젝트 단독 실행** — 이 저장소 + Node.js(또는 포함된 Docker 이미지)만으로 동작합니다. DB·메시지 큐·외부 미들웨어는 요구하지 않습니다.
- **배포 데이터** — `data/` 디렉터리 백업·복사가 곧 마이그레이션입니다.

## 핵심 기능

### 자산 · 스냅샷
- 분류별(예금 / 적금 / 주식 / 펀드 / 연금) 보유 자산 등록·수정·삭제, 종목 단위 메타(계좌, 통화, 티커, 시장, 수량, 평균/현재가 등) 보관
- 일별 스냅샷 저장·삭제로 전일 대비 자산 증감 추적
- AI 또는 수기 입력으로 자유 텍스트(주문 메모, 자산 블록)를 구조화 자산으로 일괄 등록(`structuredImportService`)

### 시세 연동
- **Finnhub / Yahoo Finance / 공공데이터포털** 다중 프로바이더 자동 라우팅 (US/KR/FX 별도 설정 가능)
- 보유 종목 일괄 시세 갱신(`POST /api/market/refresh`), 백그라운드 폴링·세션 상태 추적
- USD↔KRW 환율 캐시, 시세/세션/환율 변경 시 SSE로 실시간 전파

### Workspace UI
- 단일 라우트 `/`에서 다중 패널 워크스페이스 구성
- 패널: `StatusStrip`, `Overview`, `Holdings`, `Snapshots`, `Chat`, `Insights`, `Activity`, `ManagerBrief`, `Profile`, `System`
- 화면 폭에 따라 1~3컬럼 자동 재배치, 포커스 모드(`balanced` / 패널 단독) 전환, `DetailDrawer`로 상세 진입
- SSE 구독으로 시세·매니저·예약 작업 변화에 즉시 반응

### Gemini 채팅
- 멀티스레드 채팅, 스레드별 대화/요약/장기 기억 유지
- 동기 응답(`/messages`)과 **NDJSON 스트림**(`/messages/stream`) 모두 지원, 단계별 이벤트(`thought`, `delta`, `action`, `done`) 표시
- LangGraph 스타일 슈퍼바이저: 사용자 의도 → 전문가 노드(리서치/포트폴리오/액션 등) → 실행 → 메모리 적재 파이프라인
- `actionService`로 보유/프로필/스케줄 변경을 채팅에서 직접 적용

### Quant Manager · 예약 작업
- 일일 매니저 브리핑(`POST /api/manager/run`, 별칭 `/api/ai/run`) — Gemini로 포트폴리오·시세·기억 통합 리뷰
- KST 평일(월–금) 6회 자동 일일 보고: **22·23·06·09·10·18시** (`MANAGER_BRIEF_PRESET_SCHEDULE=true`, 기본). 레거시 단일 cron은 `MANAGER_BRIEF_PRESET_SCHEDULE=false` + `AI_DAILY_CRON`으로 사용.
- 채팅에서 예약한 작업 종류: `managerBrief`, `marketReview`, `indicatorCheck`, `custom` — 실행 결과는 장기 기억(`schedule_run`)으로 누적

### 프로필 · 기억
- 사용자 입력 프로필(`displayName`, `investorType`, `riskTolerance` 등) + AI 추론 프로필(`summary`, `inferredTraits`)
- 대화 요약 / 장기 기억 / 매니저 리포트를 모두 **`data/` JSON 파일**로 보관 (외부 DB 없음)

### 데이터 파일
- `data/portfolio.json` — 보유 자산 / 스냅샷
- `data/chat.json` — 스레드 / 메시지
- `data/memory.json` — 대화 요약 · 장기 기억 · 매니저 리포트 · 예약 작업 · 시세 상태
- `data/profile.json` — 사용자 / AI 프로필

## 디자인

Coinbase 공개 마케팅 서피스 톤을 준용합니다.

- 단일 액션 컬러 Coinbase Blue `#0052ff` (CTA·브랜드 링크 한정)
- 타이포: 본문 **Inter**, 숫자 **JetBrains Mono**
- 라운딩: CTA·필 pill, 카드 24px, 자산 아이콘 원형
- 시맨틱 색: 상승 `#05b169` / 하락 `#cf202f` (텍스트만, 버튼 배경 X)
- 레이아웃: 밝은 캔버스 + 소프트 그레이 밴드, 다크 히어로 + 플로팅 카드 스택

토큰은 `frontend/src/styles/tokens.css`에 CSS 변수로 정의되어 있습니다.

## 기술 스택

| 구분 | 기술 |
|------|------|
| 백엔드 | Node.js 20, Express, node-cron, `@google/genai` (Gemini SDK), 자체 LangGraph 스타일 슈퍼바이저 |
| 시세 | Finnhub / Yahoo Finance / 공공데이터포털 어댑터, SSE 실시간 전파 |
| 프론트엔드 | Vue 3, Vue Router 4, Vite 5, 패널형 워크스페이스 |
| 스타일 | 순수 CSS + 디자인 토큰 (Coinbase 톤) |
| 저장소 | **`data/` 물리 JSON 파일** (`portfolio`, `chat`, `memory`, `profile`) — DB 엔진 없음 |
| 컨테이너 | Docker (Node 20 Alpine) |

## 프로젝트 구조

```
simpleStock/
├── package.json
├── server.js                       # Express + SSE + 라우트 + cron 부팅
├── start_simpleStock.sh            # Docker / Node 자동 분기 기동 스크립트
├── server/
│   ├── aiService.js                # Gemini 호출, 슈퍼바이저, 스케줄 실행
│   ├── chatService.js              # 멀티스레드 채팅, NDJSON 스트림
│   ├── actionService.js            # 보유/프로필/스케줄 변경 액션
│   ├── managerService.js           # Quant Manager 브리핑
│   ├── taskService.js              # 예약 작업 동기화·실행
│   ├── marketDataService.js        # Finnhub/Yahoo/공공데이터 시세 어댑터
│   ├── realtimeService.js          # SSE 구독·브로드캐스트
│   ├── structuredImportService.js  # 자유 텍스트 → 구조화 자산
│   ├── payloadService.js           # 화면용 응답 빌더
│   ├── contextBuilder.js           # 카테고리 비중·요약 컨텍스트
│   ├── dataStore.js                # JSON 파일 저장·뮤테이션 큐
│   ├── profileService.js
│   ├── time.js
│   └── logger.js
├── data/                           # 런타임 JSON (gitignored)
├── dist/                           # 프론트 빌드 산출물
├── frontend/
│   ├── index.html
│   ├── vite.config.js
│   └── src/
│       ├── App.vue
│       ├── router/                 # 단일 라우트 → WorkspaceView
│       ├── styles/tokens.css
│       ├── views/
│       │   └── WorkspaceView.vue   # 실제 라우트 (/) — 아래 legacy 뷰는 미사용
│       ├── components/workspace/   # StatusStrip, OverviewPanel, ChatPanel ...
│       └── composables/            # usePortfolio, useChat, useProfile,
│                                   #   useUi, useWorkspace, useRealtimeSubscription
├── tests/                          # node --test 스모크 테스트
├── Dockerfile
└── docker-compose.yml
```

## 실행

### 요구 사항
- Node.js ≥ 20

### 한 번에 기동 (권장)
```bash
./start_simpleStock.sh
```
- Docker가 설치돼 있으면 `docker compose up -d --build`로 띄우고, 없으면 의존성 설치 → 프론트 빌드 → `npm start`까지 순차 실행합니다.
- 스크립트는 호출 위치와 무관하게 프로젝트 루트로 이동하며, 같은 위치의 `.env`를 읽어 `PORT` 등을 반영합니다.

### 수동 로컬 실행
```bash
cp .env.example .env
npm run install:all
npm run build
npm start    # http://0.0.0.0:50000 (PORT 변경 시 .env 사용)
```

### 프론트 개발만 (별도 터미널에서 백엔드 동시 기동)
```bash
npm start
cd frontend && npm run dev   # http://127.0.0.1:5173 , /api → 백엔드 50000
```

### Docker
```bash
docker compose up -d --build
```
`./data`가 컨테이너 `/app/data`에 마운트되어 데이터가 호스트에 유지됩니다.

### 테스트
```bash
npm test   # node --test tests
```

## 환경 변수

실제 키는 `.env`에만 넣고, Git에는 커밋하지 않습니다 (`.gitignore` 처리됨).

```bash
PORT=50000
GEMINI_API_KEY=
GEMINI_MODEL=gemini-3.1-flash-lite
GEMINI_INCLUDE_THOUGHTS=true
GEMINI_THINKING_BUDGET=2048
GEMINI_TIMEOUT_MS=90000
GEMINI_MAX_RETRIES=2
GEMINI_RETRY_BASE_MS=1500
APP_TIMEZONE=Asia/Seoul
MANAGER_BRIEF_PRESET_SCHEDULE=true
AI_DAILY_CRON=
TZ=Asia/Seoul

# 시세
MARKET_DATA_ENABLED=true
MARKET_DATA_PROVIDER=finnhub
MARKET_US_PROVIDER=finnhub
MARKET_KR_PROVIDER=public-data-portal
MARKET_FX_PROVIDER=yahoo-finance
MARKET_REFRESH_INTERVAL_MS=60000
MARKET_QUOTE_TTL_MS=60000
MARKET_KR_QUOTE_TTL_MS=21600000
FINNHUB_API_KEY=
PUBLIC_DATA_API_KEY=
USD_KRW_FALLBACK_RATE=1360
```

### 핵심 변수 메모
- `PORT`: HTTP 포트. 기본 **50000** (로컬 3000 충돌 회피). 서버에서 3000을 유지하려면 `.env`에 `PORT=3000`.
- `GEMINI_MODEL`: 기본 Stable **`gemini-3.1-flash-lite`** ([공식 모델 목록](https://ai.google.dev/gemini-api/docs/models)). Latest 별칭(`gemini-flash-latest`)은 가리키는 빌드가 바뀔 수 있어 동작 변화 가능.
- `GEMINI_INCLUDE_THOUGHTS`: `true`면 응답 스트림에 추론(thought) 토큰 포함, `GEMINI_THINKING_BUDGET`으로 상한 제어(최대 8192).
- `GEMINI_TIMEOUT_MS` / `MAX_RETRIES` / `RETRY_BASE_MS`: 한 호출 타임아웃과 백오프 재시도.
- `APP_TIMEZONE`, `MANAGER_BRIEF_PRESET_SCHEDULE`: 매니저 일일 보고 스케줄(평일 6회). 단일 cron만 쓸 때는 `AI_DAILY_CRON`.
- `MARKET_*_PROVIDER`: 시장/통화별 시세 소스 분리. 키가 없으면 자동으로 Yahoo로 폴백.
- `GEMINI_API_KEY`가 비어 있으면 자산/히스토리/설정 화면은 정상이고, 채팅 / 매니저 / 자동 액션만 비활성화됩니다.

## API 요약

| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET | `/api/portfolio` | 자산·스냅샷·시세·매니저 등 통합 페이로드 |
| PUT | `/api/portfolio` | `{ "holdings": [...] }`로 목록 전체 교체 |
| POST | `/api/snapshots` | `{ "date": "YYYY-MM-DD" }` (옵션) — 현재 합계로 스냅샷 저장 |
| DELETE | `/api/snapshots/:date` | 해당 날짜 스냅샷 삭제 |
| POST | `/api/market/refresh` | 보유 종목 시세 강제 갱신 |
| GET | `/api/market/status` | 시세 갱신 상태/세션/환율 스냅샷 |
| GET | `/api/stream` | SSE 스트림 (시세·매니저·예약 변화) |
| GET | `/api/profile` | 사용자 + AI 추론 프로필 |
| PUT | `/api/profile` | 사용자 성향 프로필 저장 |
| GET | `/api/chat/threads` | 스레드 목록 |
| POST | `/api/chat/threads` | 새 스레드 생성 |
| GET | `/api/chat/threads/:threadId` | 스레드 메시지 조회 |
| POST | `/api/chat/threads/:threadId/messages` | 슈퍼바이저 응답(동기) |
| POST | `/api/chat/threads/:threadId/messages/stream` | 슈퍼바이저 응답(NDJSON 스트림) |
| POST | `/api/chat/threads/:threadId/summarize` | 대화 요약 수동 갱신 |
| DELETE | `/api/chat/threads/:threadId` | 스레드 + 관련 기억 삭제 |
| POST | `/api/manager/run` | Quant Manager 브리핑 수동 실행 |
| POST | `/api/ai/run` | `/api/manager/run` 별칭 |
| GET | `/api/system/status` | 시간대·AI 설정·시세·매니저 최신 리포트·데이터 파일 상태 |

## 배포 메모

- 프로젝트 루트의 **`.env`** 는 `.gitignore` 대상이므로 `git pull` / 신규 클론 후에도 보존됩니다.
- 처음 배포 시: `git clone` → `.env` 작성(또는 마이그레이션) → `./start_simpleStock.sh`.
- 데이터 마이그레이션 예시(원본 → 대상):
  ```bash
  ssh source 'tar czf - -C ~/simpleStock data' \
    | ssh target 'cd ~/simpleStock && tar xzf - && chown -R $USER:$USER data'
  ```
- 다음 배포부터는 서버에서 다음 한 줄이면 됩니다:
  ```bash
  cd ~/simpleStock && git pull --ff-only && ./start_simpleStock.sh
  ```

## 라이선스

MIT
