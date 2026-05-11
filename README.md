# SimpleStock

개인 전용 **자산 현황·일 단위 재산 변동** 추적 웹 앱입니다. 예금·적금·주식·펀드·연금으로 분류한 보유 자산을 입력하면, 포트폴리오 비중과 총액 대시보드를 보여 줍니다. 일별 스냅샷을 쌓아 두면 전일 대비 증감을 확인할 수 있습니다.

**저장소:** [github.com/LucestDail/simpleStock](https://github.com/LucestDail/simpleStock)

## 기능

- **자산 입력** — 분류별(예금 / 적금 / 주식 / 펀드 / 연금) 항목·평가금액(원) 등록·수정·삭제
- **대시보드** — 총 자산, 카테고리별 비중(도넛·카드·표), 최근 스냅샷 대비 증감 표시
- **일별 기록** — 선택한 날짜 기준으로 당시 보유 합계를 스냅샷으로 저장·삭제
- **멀티스레드 채팅** — Enter 전송 / Shift+Enter 줄바꿈, 스레드별 대화 기록과 요약 저장
- **장기 기억 / 프로필** — 대화 요약, 장기 기억, 사용자 성향 프로필을 JSON 파일로 유지
- **Quant Manager 브리핑** — Gemini + LangGraph 기반 일일 브리핑, 수동 실행 + KST 기준 일 1회 스케줄
- **설정** — 데이터 파일 경로, 시간대, AI 오케스트레이션 상태, 사용자 성향 프로필 편집

DB 없이 서버 파일 시스템의 JSON 파일로 저장합니다.

- `data/portfolio.json` — 보유 자산 / 스냅샷
- `data/chat.json` — 스레드 / 메시지
- `data/memory.json` — 대화 요약 / 장기 기억 / 매니저 브리핑
- `data/profile.json` — 사용자 입력 프로필 / AI 추론 프로필

## 디자인

Coinbase 공개 마케팅 서피스 톤을 준용합니다.

- **단일 액션 컬러:** Coinbase Blue `#0052ff` — 주요 CTA·브랜드 링크에만 사용
- **타이포:** Display/본문용 **Inter** (가이드의 CoinbaseDisplay/Sans 대체), 숫자는 **JetBrains Mono**
- **라운딩:** CTA·필은 pill, 카드는 24px(`rounded-xl`), 자산 아이콘 영역은 원형
- **시맨틱 색:** 상승 `#05b169` / 하락 `#cf202f` — 텍스트만, 버튼 배경에 사용하지 않음
- **레이아웃:** 밝은 캔버스 + 소프트 그레이 밴드, 대시보드 상단은 다크 히어로 + 플로팅 카드 스택

토큰은 `frontend/src/styles/tokens.css`에 CSS 변수로 정의되어 있습니다.

## 기술 스택

| 구분 | 기술 |
|------|------|
| 백엔드 | Node.js, Express, node-cron, Gemini SDK, LangGraph |
| 프론트엔드 | Vue 3, Vue Router 4, Vite 5 |
| 스타일 | 순수 CSS + 디자인 토큰 (Coinbase 톤 준용) |
| 저장소 | JSON 파일 (`portfolio`, `chat`, `memory`, `profile`) |
| 컨테이너 | Docker (Node 20 Alpine) |

## 프로젝트 구조

```
simpleStock/
├── package.json
├── server.js              # Express API + 정적 dist
├── server/
│   ├── aiService.js
│   ├── chatService.js
│   ├── contextBuilder.js
│   ├── dataStore.js
│   ├── managerService.js
│   ├── profileService.js
│   └── time.js
├── data/
│   ├── portfolio.json
│   ├── chat.json
│   ├── memory.json
│   └── profile.json
├── dist/                  # 프론트 빌드 산출물
├── frontend/
│   ├── index.html
│   ├── vite.config.js
│   └── src/
│       ├── App.vue
│       ├── router/
│       ├── styles/tokens.css
│       ├── composables/
│       │   ├── usePortfolio.js
│       │   ├── useChat.js
│       │   ├── useProfile.js
│       │   └── useUi.js
│       └── views/         # Dashboard, Holdings, History, Chat, Settings
├── Dockerfile
└── docker-compose.yml
```

## 실행

### 요구 사항

- Node.js ≥ 20

### 설치 및 로컬 실행

```bash
cp .env.example .env   # 필요 시 Gemini 키/시간대 설정
npm run install:all
npm run build
npm start    # http://0.0.0.0:3000
```

### 프론트 개발만 (API는 별도 터미널에서 npm start)

```bash
npm start
cd frontend && npm run dev   # http://127.0.0.1:5173 , /api 는 프록시
```

### Docker

```bash
docker compose up -d --build
```

`./data`가 컨테이너 `/app/data`에 마운트됩니다.

### 환경 변수

실제 키는 `.env`에만 넣고, Git에는 커밋하지 않습니다.

```bash
GEMINI_API_KEY=
GEMINI_MODEL=gemini-3.1-pro-preview
GEMINI_THINKING_LEVEL=high
APP_TIMEZONE=Asia/Seoul
AI_DAILY_CRON=5 21 * * *
TZ=Asia/Seoul
```

- `APP_TIMEZONE`: 앱 기준 날짜/시각 계산용. 기본값 `Asia/Seoul`
- `AI_DAILY_CRON`: 일일 Quant Manager 브리핑 스케줄. 기본값은 **매일 21:05 KST**
- `GEMINI_API_KEY`가 없으면 자산/히스토리/설정 화면은 정상 동작하고, 채팅/매니저 브리핑만 비활성화됩니다.

## API 요약

| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET | `/api/portfolio` | 전체 데이터 조회 |
| PUT | `/api/portfolio` | `{ "holdings": [...] }` 로 목록 전체 교체 |
| POST | `/api/snapshots` | 본문 `{ "date": "YYYY-MM-DD" }` 선택, 생략 시 오늘 — 현재 holdings 합계로 스냅샷 저장 |
| DELETE | `/api/snapshots/:date` | 해당 날짜 스냅샷 삭제 |
| GET | `/api/profile` | 사용자 프로필 / AI 추론 프로필 조회 |
| PUT | `/api/profile` | 사용자 성향 프로필 저장 |
| GET | `/api/chat/threads` | 대화 스레드 목록 조회 |
| POST | `/api/chat/threads` | 새 대화 스레드 생성 |
| GET | `/api/chat/threads/:threadId` | 특정 스레드의 메시지 조회 |
| POST | `/api/chat/threads/:threadId/messages` | LangGraph supervisor 기반 답변 생성 |
| DELETE | `/api/chat/threads/:threadId` | 스레드 및 관련 기억 삭제 |
| POST | `/api/chat/threads/:threadId/summarize` | 스레드 요약 수동 갱신 |
| POST | `/api/manager/run` | Quant Manager 브리핑 수동 생성 |
| POST | `/api/ai/run` | `/api/manager/run` 별칭 |
| GET | `/api/system/status` | 앱 시간대, 현재 서버 시각, AI 설정 상태 조회 |

## 라이선스

MIT
