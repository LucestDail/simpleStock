# SimpleStock — 개발 계획 (PLAN)

> 기준일: 2026-05-18  
> 현재 버전: `2.0.0` (package.json)  
> 상세 기능·API·실행 방법은 [README.md](./README.md) 참고.

---

## 0. 설계 원칙 (변경하지 않음)

| 원칙 | 내용 |
|------|------|
| **물리 파일 DB** | 모든 영속 데이터는 `data/*.json`에만 저장. RDB/NoSQL/임베디드 DB 도입 **금지**. |
| **단독 프로젝트** | Redis, Postgres, 별도 검색엔진 등 **추가 설치 없이** 이 repo만으로 실행. |
| **실행 요건** | Node.js ≥ 20 + `npm` (또는 repo의 Docker Compose). API 키는 `.env`에만. |
| **확장 방식** | 스키마·용량·백업·파일 분할·원자적 쓰기는 **파일 레이어**(`dataStore`)에서 해결. |

이후 로드맵·제안에서 DB 마이그레이션 항목은 **범위 밖**으로 간주한다.

---

## 1. 현재 상태 요약 (구현 완료)

### 자산 · 기록
- [x] 5분류(예금/적금/주식/펀드/연금) 보유 CRUD, 스냅샷 일별 저장·삭제
- [x] `structuredImportService` — 자유 텍스트 → 보유/프로필/워크스페이스 패치 액션
- [x] JSON 파일 저장 (`dataStore` 뮤테이션 큐)

### 시세
- [x] Finnhub / Yahoo / 공공데이터포털 멀티 프로바이더 (US·KR·FX 분리)
- [x] `POST /api/market/refresh`, 폴링·TTL·세션 상태
- [x] SSE(`GET /api/stream`)로 시세·FX·세션 변경 브로드캐스트

### AI · 오케스트레이션
- [x] Gemini SDK (`gemini-3.1-flash-lite` 기본, `GEMINI_INCLUDE_THOUGHTS` / thinking budget)
- [x] 슈퍼바이저 파이프라인 — 의도 분석 → specialist → `actionService` 실행 → 메모리/프로필 갱신
- [x] 멀티스레드 채팅, 동기·**NDJSON 스트림** (`thought` / `delta` / `action` / `done`)
- [x] Quant Manager 일일 브리핑 + `AI_DAILY_CRON`
- [x] 예약 작업 4종: `managerBrief`, `marketReview`, `indicatorCheck`, `custom` (`taskService`)

### UI
- [x] 단일 라우트 `/` — `WorkspaceView` + 11개 워크스페이스 패널
- [x] 반응형 컬럼·포커스 모드·`DetailDrawer`
- [x] `useRealtimeSubscription` — SSE 연동

### 운영
- [x] Docker / `docker-compose.yml`, `start_simpleStock.sh`
- [x] 로컬 기본 포트 **50000** (`.env`로 변경 가능)
- [x] `.env.example`, `data/*.json` gitignore
- [x] 스모크 테스트 2종 (`tests/`)

---

## 2. README 최신화 점검 (2026-05-18)

| 항목 | README | 실제 코드 | 판정 |
|------|--------|-----------|------|
| 단일 Workspace 라우트 | O | `router/index.js` → `/` only | 일치 |
| 패널 목록 | O | `components/workspace/*` 12파일 | 일치 |
| API 엔드포인트 | O | `server.js` 라우트와 대응 | 일치 |
| Gemini env (`INCLUDE_THOUGHTS` 등) | O | `aiService.js` | 일치 |
| 포트 50000 기본 | O | `server.js`, compose, vite proxy | 일치 |
| LangGraph | “스타일” 표기 | npm에 `@langchain/langgraph` 없음, 자체 파이프라인 | 표현만 주의 |
| 레거시 뷰 | 삭제됨 | `WorkspaceView` 단일 라우트만 사용 | 일치 |
| 배포 `.env` 경로 | `~/.env` 오기 | 프로젝트 루트 `.env` | **수정함** |
| 보안(인증 없음) | 미기재 | API 전부 오픈 | PLAN에 과제로 이동 |
| 테스트 범위 | `npm test`만 | holdings + smoke 2파일 | README는 사실과 일치, 커버리지는 얇음 |

**결론:** README는 전반적으로 **최신 상태에 가깝고**, 배포 `.env` 경로·레거시 뷰·PLAN 링크만 이번에 보완했다.

---

## 3. 알려진 제약 · 기술 부채

1. **인증/인가 없음** — LAN에 포트만 열려 있으면 전체 API·`data/` 노출.
2. **로그에 채팅 프리뷰** — `server.js`가 메시지 본문 최대 120자를 로그에 남김.
3. ~~**레거시 프론트**~~ — 미사용 5 view 삭제 완료 (2026-05-19).
4. **테스트 부족** — AI·시세·스트림·액션 배치 경로 통합 테스트 없음.
5. **파일 DB 한계(의도적)** — 동시 쓰기는 `dataStore` 큐로 완화; 다중 서버·초대용량은 **파일 분할·백업·읽기 전용 복제**로 대응(DB 전환은 하지 않음).
6. **서버 배포 env 정리** — 구버전 `GEMINI_THINKING_LEVEL` 등 잔존 가능(신규는 `GEMINI_INCLUDE_THOUGHTS`).
7. **키 로테이션** — 과거 채팅/배포 과정에서 노출된 자격증명은 수동 재발급 권장.

---

## 4. 로드맵

우선순위: **P0** 즉시 · **P1** 단기(1~2주) · **P2** 중기 · **P3** 장기/선택

### P0 — 안정성 · 보안 (개인 서버라도 권장)

| # | 과제 | 설명 |
|---|------|------|
| P0-1 | **API 접근 제어** | 최소 `APP_ACCESS_TOKEN` 헤더 또는 Basic Auth; SSE·채팅 동일 적용 |
| P0-2 | **로그 민감정보 축소** | `contentPreview` 옵트아웃/마스킹; 에러 시 URL에 API token 미포함 확인 |
| P0-3 | **배포 env 템플릿 통일** | 원격 `.env`를 `.env.example`과 동기화, 구 env 키 제거 문서화 |
| P0-4 | **데이터 백업 루틴** | `backup_simpleStock.sh` — 완료 (2026-05-19, 11.25 배포) |
| P0-5 | **파일 저장 안정성** | `dataStore` temp→rename, corrupt `.bak` — 완료 (2026-05-19) |
| P0-1 | **API 접근 제어** | `APP_ACCESS_TOKEN` + 프론트 `apiClient` — 완료 (2026-05-19) |
| P0-2 | **로그 민감정보 축소** | `LOG_REQUEST_BODY=false` 기본 — 완료 (2026-05-19) |
| P0-3 | **배포 env 통일** | 11.25 `GEMINI_INCLUDE_THOUGHTS`, `PORT=3000` — 완료 (2026-05-19) |

### P1 — 제품 완성도

| # | 과제 | 설명 |
|---|------|------|
| P1-1 | **레거시 뷰 정리** | 완료 (2026-05-19) — 5 view 삭제 |
| P1-2 | **Holdings UX** | 완료 (2026-05-19) — `HoldingsPanel` 워크스페이스 연동·인라인 CRUD |
| P1-3 | **스냅샷 UX** | 완료 (2026-05-19) — Overview 막대 추이·오늘 저장·전일 대비 |
| P1-4 | **채팅 스트림 UI** | 완료 (2026-05-19) — thought 접기/펼치기·재시도 |
| P1-5 | **예약 작업 UI** | 완료 (2026-05-19) — Snapshots/System 패널·다음 실행 시각 |
| P1-6 | **Manager Brief** | 부분 완료 (2026-05-19) — 최근 히스토리 목록 (PDF/MD는 P2+) |
| P1-7 | **통합 테스트** | 완료 (2026-05-19) — NDJSON·dataStore·cron 테스트 8종 |

### P2 — AI · 데이터 품질

| # | 과제 | 설명 |
|---|------|------|
| P2-1 | **모델 설정 UI** | 완료 (2026-05-19) — System/설정 AI 프리셋, `data/settings.json` |
| P2-2 | **기억 관리** | 완료 (2026-05-19) — 장기 기억·스레드 요약 API/UI |
| P2-3 | **structured import 검증** | 완료 (2026-05-19) — diff 미리보기·1회 undo |
| P2-4 | **specialist 폴백 강화** | 완료 (2026-05-19) — research 폴백·사용자 안내 문구 |
| P2-5 | **시세 정확도** | 완료 (2026-05-19) — KR 실패율·프로바이더 설정 UI |
| P2-6 | **비용·토큰 메타** | 완료 (2026-05-19) — 월별 토큰 집계·System 표시 |

### P3 — 확장 (필요 시, **파일 DB 유지**)

| # | 과제 | 설명 |
|---|------|------|
| P3-1 | **다중 프로필(파일 분리)** | `data/profiles/{id}/` 등 디렉터리 분리 — 여전히 JSON 파일만 |
| P3-2 | **대용량 완화** | 채팅·메모리 아카이브 JSON 분리, 오래된 스레드 gzip 보관 |
| P3-3 | **모바일 PWA** | 오프라인 읽기 전용, 홈 화면 추가 |
| P3-4 | **알림** | 매니저 브리핑·예약 작업 완료 시 Telegram/이메일 webhook (HTTP만, 큐 서버 없음) |
| P3-5 | **역프록시 템플릿** | Caddy/Nginx + TLS 예시 compose overlay (선택, repo 외부 설치) |

---

## 5. 배포 · 운영 체크리스트

### 신규 서버
1. `git clone` → `cp .env.example .env` (키·`PORT` 설정)
2. `data/` 마이그레이션(필요 시 tar 파이프)
3. `./start_simpleStock.sh`
4. `curl http://127.0.0.1:${PORT}/` → 200

### 일상 배포
```bash
cd ~/simpleStock && git pull --ff-only && ./start_simpleStock.sh
```

### 배포 후 검증
- [ ] 대시보드 총액·스냅샷 로드
- [ ] `GET /api/system/status` — `ai.configured`, `market` 상태
- [ ] 채팅 스트림 1회 — `thought` / `done` 이벤트
- [ ] `POST /api/market/refresh` — 보유 티커 시세 반영
- [ ] (선택) `POST /api/manager/run` — 브리핑 생성

---

## 6. 완료 시 PLAN 갱신 규칙

- 섹션 1 체크박스: 기능 **머지·배포 확인 후** `[x]` 처리
- 섹션 4: 완료 항목은 **「완료 (YYYY-MM-DD)」** 로 옮기거나 삭제
- README와 API·env 변경이 있으면 **같은 PR/커밋에서 README 동기화**

---

## 7. 참고 링크

- [Gemini API 모델 목록](https://ai.google.dev/gemini-api/docs/models)
- [README — 환경 변수·API](./README.md)
