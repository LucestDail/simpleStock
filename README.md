# SimpleStock

개인 전용 **자산 현황 · 일별 변동 · 시세 연동 · AI 매니저** 통합 워크스페이스. 보유 자산을 한 화면(Workspace)에서 보고, Gemini 기반 채팅·매니저 브리핑·예약 작업으로 분석을 자동화합니다.

**저장소:** [github.com/LucestDail/simpleStock](https://github.com/LucestDail/simpleStock)

## 설계 원칙 (고정)

- **저장소 = 물리 파일만** — `data/*.json`이 유일한 DB입니다. SQLite·Postgres·Redis 등 **별도 DB 설치·연동은 하지 않습니다.**
- **프로젝트 단독 실행** — 이 저장소 + Node.js(또는 Docker)만으로 동작합니다.
- **배포 데이터** — `data/` 디렉터리 백업·복사가 곧 마이그레이션입니다.

## 핵심 기능

### 자산 · 스냅샷
- 분류별(예금 / 적금 / 주식 / 펀드 / 연금) 보유 CRUD, 종목·계좌·통화·시장 메타
- 일별 스냅샷 저장·삭제, 전일 대비 증감
- 브리핑 실행 시 당일 스냅샷 자동 저장 (`snapshotService`)
- 자유 텍스트 → 구조화 자산 일괄 등록 (`structuredImportService`, diff 미리보기·1회 undo)

### 시세 연동
- **Finnhub / Yahoo / 공공데이터포털** — US·KR·FX 프로바이더 분리
- 폴링·TTL(US 60초, KR 6시간), `POST /api/market/refresh`
- KR **quota 초과 시 30분 백오프**·영업일 조회 2일, 미등록 시 Yahoo `.KS` 폴백
- SSE로 시세·FX·세션 변경 브로드캐스트

### Workspace UI
- 단일 라우트 `/` — **3열**: 좌(Overview) · 중(Chat) · 우(Manager Hub)
- 상단 **LiveTickerBar**: KST + 미국 동부(ET) 시계, 보유 종목 시세(한국 종목은 **종목명 우선**), 실시간 갱신 시각
- **ManagerHubPanel**: 포트폴리오 시그널·브리핑·예약·활동 통합 (구 Insights/Brief/Snapshots/Activity는 패널 숨김·드로어 연동)
- `DetailDrawer`, SSE (`useRealtimeSubscription`)

### Gemini 채팅 · AI
- 멀티스레드, 동기·**NDJSON 스트림** (`thought` / `delta` / `action` / `done`)
- 자체 슈퍼바이저 파이프라인 → `actionService` (보유·프로필·예약 변경)
- 설정 UI: AI 프리셋·시세 프로바이더·토큰 사용량 (`data/settings.json`)

### Quant Manager · 예약
- 수동 브리핑: `POST /api/manager/run` (별칭 `/api/ai/run`)
- KST **평일 6회** 자동 보고: 22·23·06·09·10·18시 (`MANAGER_BRIEF_PRESET_SCHEDULE=true`)
- 예약 유형: `managerBrief`, `marketReview`, `indicatorCheck`, `custom`

### 보안 · 운영
- **`APP_ACCESS_TOKEN`** 설정 시 API·SSE Bearer 인증 (미설정 시 LAN 오픈 — 개인 서버에서도 토큰 권장)
- `LOG_REQUEST_BODY=false` 기본, `dataStore` 원자적 쓰기·`.bak` 복구
- `backup_simpleStock.sh` — `data/` tar 백업

## 포트

| 환경 | 포트 | 비고 |
|------|------|------|
| **simpleStock 기본** | **50000** | 3000·28080(my-computer)과 분리 |
| 로컬 Vite dev | 5173 | `/api` → 50000 프록시 |
| 개인 서버 예시 | `192.168.11.25:50000` | `.env`에 `PORT=50000` |

## 기술 스택

| 구분 | 기술 |
|------|------|
| 백엔드 | Node.js 20, Express, node-cron, `@google/genai` |
| 시세 | `marketDataService.js` — 멀티 프로바이더 + 캐시·백오프 |
| 프론트 | Vue 3, Vite 5, 패널형 워크스페이스 |
| 저장소 | `data/*.json` only |
| 컨테이너 | Docker Compose |

## 프로젝트 구조

```
simpleStock/
├── server.js
├── start_simpleStock.sh
├── backup_simpleStock.sh
├── scripts/deploy-remote.sh      # 원격 rsync + docker 재빌드
├── server/
│   ├── aiService.js, chatService.js, actionService.js
│   ├── managerService.js, managerBriefSchedule.js
│   ├── marketDataService.js, snapshotService.js
│   ├── taskService.js, settingsService.js, memoryService.js
│   ├── importPreviewService.js, dataStore.js
│   └── ...
├── frontend/src/
│   ├── views/WorkspaceView.vue
│   ├── components/workspace/     # LiveTickerBar, ManagerHubPanel, ChatPanel, ...
│   └── lib/                      # marketClock, holdingDisplay, cronSchedule, ...
├── tests/                        # node --test (15 tests)
├── Dockerfile, docker-compose.yml
└── data/                         # gitignored
```

## 실행

### 요구 사항
- Node.js ≥ 20

### 한 번에 기동
```bash
cp .env.example .env   # 키·PORT·APP_ACCESS_TOKEN
./start_simpleStock.sh
```

### 수동
```bash
npm run install:all && npm run build && npm start
# http://0.0.0.0:50000
```

### Docker
```bash
docker compose up -d --build
```

### 테스트
```bash
npm test
```

## 환경 변수

전체 목록은 [`.env.example`](./.env.example) 참고.

| 변수 | 설명 |
|------|------|
| `PORT` | HTTP 포트 (기본 **50000**) |
| `APP_ACCESS_TOKEN` | 설정 시 Bearer 인증 필수 |
| `GEMINI_*` | 모델·thought·타임아웃·재시도 |
| `MANAGER_BRIEF_PRESET_SCHEDULE` | 평일 6회 브리핑 (기본 true) |
| `MARKET_*` | 시세 프로바이더·폴링·TTL |
| `MARKET_KR_BAS_DT_LOOKBACK_DAYS` | KR 조회 영업일 수 (기본 2) |
| `MARKET_KR_QUOTA_BACKOFF_MS` | KR 한도 초과 백오프 (기본 30분) |
| `PUBLIC_DATA_API_KEY` | 공공데이터포털 (KR 시세) |
| `FINNHUB_API_KEY` | US 시세 |

## API 요약

| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET | `/api/portfolio` | 통합 페이로드 |
| PUT | `/api/portfolio` | 보유 목록 교체 |
| POST | `/api/snapshots` | 스냅샷 저장 |
| DELETE | `/api/snapshots/:date` | 스냅샷 삭제 |
| POST | `/api/market/refresh` | 시세 강제 갱신 |
| GET | `/api/market/status` | 시세·세션·환율 |
| GET | `/api/stream` | SSE |
| GET/PUT | `/api/profile` | 프로필 |
| GET/POST/DELETE | `/api/chat/threads/...` | 채팅·스트림 |
| POST | `/api/manager/run` | Quant Manager 브리핑 |
| GET | `/api/system/status` | 시스템·AI·시세 상태 |
| GET/PUT | `/api/system/settings` | 런타임 설정 |
| GET/POST/DELETE | `/api/memory/...` | 장기 기억·요약 |
| POST | `/api/import/preview` | 구조화 import 미리보기 |

## 배포

### 신규 서버
1. `git clone` → `cp .env.example .env`
2. `PORT=50000`, API 키, `APP_ACCESS_TOKEN` 설정
3. `./start_simpleStock.sh`
4. `curl http://127.0.0.1:50000/` → 200

### 원격 (예: 192.168.11.25)
```bash
# 로컬에서 (scripts/.env.remote 에 REMOTE_* 설정 가능)
./scripts/deploy-remote.sh
```
또는 서버에서 `git pull --ff-only && ./start_simpleStock.sh` (워킹트리 충돌 시 rsync 배포 권장).

### 데이터 백업
```bash
./backup_simpleStock.sh
```

### 데이터 이전
```bash
ssh source 'tar czf - -C ~/simpleStock data' \
  | ssh target 'cd ~/simpleStock && tar xzf -'
```

## 향후 과제

P0~P2(인증·워크스페이스 UX·AI 설정·시세 UI 등)는 2026-05-19 기준 반영 완료입니다.

### 알려진 이슈 (운영)

| 항목 | 설명 |
|------|------|
| **KR 시세 예외** | 공공데이터: 주식 `getStockPriceInfo` → ETF `getSecuritiesPriceInfo`. 미등록 종목(일부 ETF)은 **Yahoo `종목코드.KS`** 폴백. `PUBLIC_DATA_API_KEY`는 포털 **디코딩** 값 사용 |
| **API 키 로테이션** | 채팅·URL에 노출된 `PUBLIC_DATA_API_KEY` 등은 포털에서 재발급 권장 |
| **원격 git pull** | `192.168.11.25:~/simpleStock`에 로컬 수정이 쌓이면 `git pull` 충돌 가능 → `scripts/deploy-remote.sh` 또는 rsync 배포 권장 |

### 확장 (파일 DB 유지)

| # | 과제 | 설명 |
|---|------|------|
| P3-1 | **다중 프로필** | `data/profiles/{id}/` 디렉터리 분리 — JSON 파일만 |
| P3-2 | **대용량 완화** | 채팅·메모리 아카이브 분리, 오래된 스레드 gzip |
| P3-3 | **모바일 PWA** | 오프라인 읽기 전용, 홈 화면 추가 |
| P3-4 | **알림** | 브리핑·예약 완료 시 Telegram/이메일 webhook |
| P3-5 | **역프록시 템플릿** | Caddy/Nginx + TLS compose overlay 예시 |

### 선택

| # | 과제 | 설명 |
|---|------|------|
| P1-6+ | **브리핑보내기** | Quant Manager 리포트 PDF/Markdown 다운로드 |

### 배포 후 스모크 (수동)

- [ ] `http://<host>:50000/` — 대시보드·스냅샷
- [ ] `GET /api/system/status` — `aiConfigured`, `market`
- [ ] 채팅 스트림 — `thought` / `done`
- [ ] `POST /api/market/refresh` — US/KR 시세
- [ ] QUANT OPS **브리핑** — 스냅샷 저장·UI 갱신

## 라이선스

MIT
