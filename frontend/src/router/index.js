import { createRouter, createWebHistory } from 'vue-router';

/**
 * 📐 관측 도구 라우트 (2026-10-12 전면 개편 — `docs/wireframe-2026-10-12.html`)
 *
 * 🔴 **주문 집행이 사라졌다.** 첫 화면이 *"무엇을 살까"* 에서 **"무엇을 들고 있나"** 로 바뀌면서
 *    `/`(대시보드)가 **포트폴리오**가 되고, 분석 리포트는 `/analysis` 로 내려간다.
 *
 * 제거된 라우트: `/approvals`(승인 대기 — 승인할 것이 없다).
 * ⚠️ `/rules`(운용 규칙)는 **`/watchlist`(감시 목록)로 이름과 내용이 바뀐다** — 주문 규칙·
 *    자율 단계·AI 예산을 들어내면 남는 것이 감시 목록 관리뿐이다.
 */
const routes = [
  { path: '/', name: 'portfolio', component: () => import('../views/PortfolioView.vue'), meta: { title: '포트폴리오' } },
  { path: '/analysis', name: 'analysis', component: () => import('../views/WorkspaceView.vue'), meta: { title: '분석 리포트' } },
  { path: '/lab', name: 'lab', component: () => import('../views/StrategyView.vue'), meta: { title: '전략 연구소' } },
  { path: '/lab/run/:id', name: 'backtest', component: () => import('../views/BacktestView.vue'), meta: { title: '백테스트 결과' } },
  { path: '/risk', name: 'risk', component: () => import('../views/RiskView.vue'), meta: { title: '리스크' } },
  {
    /**
     * 🔴 2026-10-12 — `/watchlist` → `/settings`. 사용자: *"감시목록 이런거 다 설정창으로 빼.
     *    이런거 그냥 너가 설정값으로 가지는거지 내가 건들일 이유가 없잖아."*
     *    매일 보는 화면과 **한 번 정하는 설정**을 메뉴에서 섞지 않는다.
     */
    path: '/settings', name: 'settings', component: () => import('../views/RulesView.vue'), meta: { title: '설정' },
  },
  { path: '/activity', name: 'activity', component: () => import('../views/ActivityView.vue'), meta: { title: '활동 로그' } },
  { path: '/symbol/:code', name: 'symbol', component: () => import('../views/SymbolView.vue'), meta: { title: '종목 상세' } },

  /**
   * ⚠️ 옛 주소를 **404 로 떨어뜨리지 않는다** — 브라우저 북마크·폰의 옛 링크가 남아 있다.
   *    조용히 홈으로 보내면 "왜 다른 화면이 뜨지" 가 되므로, 사라진 화면은 그 사실을 아는
   *    자리로 보낸다(`/activity` 에 개편 안내가 있다).
   */
  /**
   * 🔴 2026-10-12 — `/report`(성과) **제거.** 7단계 수명주기 중 **3.5단계가 박제**였다
   *    (제안 54 · 승인 10 · 실주문 0 · 정산 0 — 주문 집행이 사라져 영원히 안 움직인다).
   *    그 화면에만 있던 **벤치마크 비교**는 `BenchChart` 로 떼어 포트폴리오에 넣었다.
   */
  { path: '/report', redirect: { name: 'portfolio' } },
  { path: '/approvals', redirect: { name: 'activity' } },
  { path: '/rules', redirect: { name: 'settings' } },
  { path: '/watchlist', redirect: { name: 'settings' } },
  { path: '/:pathMatch(.*)*', redirect: { name: 'portfolio' } },
];

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes,
});

router.afterEach((to) => {
  document.title = to.meta?.title ? `${to.meta.title} · SimpleStock` : 'SimpleStock';
});

export default router;
