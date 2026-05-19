# SimpleStock — 향후 과제

> P0~P2 로드맵은 2026-05-19 기준 **완료**되었습니다. 실행·API·배포는 [README.md](./README.md)를 기준으로 합니다.

## 알려진 이슈 (운영)

| 항목 | 설명 |
|------|------|
| **KR 시세 미매칭** | 일부 ETF(예: `411060`, `473580`)는 공공데이터 `getStockPriceInfo`에서 종목 미조회. **활용(운영) API 키** 승인 후에도 실패하면 `likeSrtnCd`/종목코드 정규화·대체 소스 검토 |
| **API 키 로테이션** | 채팅·URL에 노출된 `PUBLIC_DATA_API_KEY` 등은 포털에서 재발급 권장 |
| **원격 git pull** | `192.168.11.25:~/simpleStock`에 로컬 수정이 쌓여 `git pull` 충돌 가능 → 배포는 `scripts/deploy-remote.sh` 또는 rsync 권장 |

## P3 — 확장 (파일 DB 유지)

| # | 과제 | 설명 |
|---|------|------|
| P3-1 | **다중 프로필** | `data/profiles/{id}/` 디렉터리 분리 — JSON 파일만 |
| P3-2 | **대용량 완화** | 채팅·메모리 아카이브 분리, 오래된 스레드 gzip |
| P3-3 | **모바일 PWA** | 오프라인 읽기 전용, 홈 화면 추가 |
| P3-4 | **알림** | 브리핑·예약 완료 시 Telegram/이메일 webhook |
| P3-5 | **역프록시 템플릿** | Caddy/Nginx + TLS compose overlay 예시 |

## 선택 (P1 잔여)

| # | 과제 | 설명 |
|---|------|------|
| P1-6+ | **브리핑보내기** | Quant Manager 리포트 PDF/Markdown 다운로드 |

## 배포 후 스모크 (수동)

- [ ] `http://<host>:50000/` 대시보드·스냅샷
- [ ] `GET /api/system/status` — `aiConfigured`, `market`
- [ ] 채팅 스트림 — `thought` / `done`
- [ ] `POST /api/market/refresh` — US/KR 시세
- [ ] QUANT OPS **브리핑** — 스냅샷 저장·UI 갱신
