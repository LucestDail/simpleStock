import { createRouter, createWebHistory } from 'vue-router';

/**
 * 📐 관측 도구 라우트 (2026-10-12 전면 개편 — `docs/wireframe-2026-10-12.html`)
 *
 * 🔴 **주문 집행이 사라졌다.** 그래서 화면 구성의 질문도 바뀌었다 —
 *    *"무엇을 살까"* 가 아니라 **"오늘 뭐라고 하나 · 내가 뭘 들고 있나"** 다.
 *
 * ## 2026-10-12 저녁 — 다섯 메뉴로 접었다 (사용자 지시)
 *
 * > *"리스크 / 전략 연구소 / 포트폴리오 메뉴를 합쳐서 포트폴리오 / 전략연구소로 합쳐.
 * >  리스크 내용이 거의 포트폴리오랑 연계되는 내용 같은데. 그리고 첫 페이지는 분석 리포트로 하고."*
 *
 * 🔴 **리스크는 독립된 주제가 아니라 포트폴리오를 보는 한 각도였다.** 둘로 갈라 두니
 *    같은 숫자를 두 화면이 각자 판정했고, **서로 다른 한도를 들고 다른 말을 했다**
 *    (리스크 화면은 `LIMITS = {leverage:30, single:20, cashMin:10}` 을 **복제**해 갖고 있어서
 *    포트폴리오가 *"기준 40%"* 라고 할 때 *"30%"* 라고 했다 — 사용자 스크린샷에서 드러났다).
 *    합치자 기준선을 쥐는 곳이 `server/portfolioRules.js` **하나**로 줄었다.
 *
 * 🔴 **첫 화면 = 분석 리포트.** 매일 바뀌는 것이 앞에 와야 한다 — 보유는 어제와 거의 같고,
 *    오늘의 판단은 매번 다르다. 포트폴리오가 첫 화면이던 동안 사용자는 **늘 한 번 더 눌러서**
 *    오늘 내용을 봤다.
 *
 * 메뉴 = 분석 리포트 · 포트폴리오 · 전략 연구소 · 활동 로그 · ⚙ 설정 (다섯)
 */
const routes = [
  { path: '/', name: 'analysis', component: () => import('../views/WorkspaceView.vue'), meta: { title: '분석 리포트' } },
  { path: '/portfolio', name: 'portfolio', component: () => import('../views/PortfolioView.vue'), meta: { title: '포트폴리오' } },
  { path: '/lab', name: 'lab', component: () => import('../views/StrategyView.vue'), meta: { title: '전략 연구소' } },
  { path: '/lab/run/:id', name: 'backtest', component: () => import('../views/BacktestView.vue'), meta: { title: '백테스트 결과' } },
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
  /**
   * 🔴 2026-10-12 — `/risk`(리스크) **제거, 포트폴리오에 흡수.** 같은 보유·같은 비중을 두 화면이
   *    각자 판정하면서 **한도가 복제돼 서로 다른 말을 했다.** 사라진 게 아니라 옮겨 간 것이므로
   *    옛 주소는 그 내용이 실제로 있는 자리로 보낸다.
   */
  { path: '/risk', redirect: { name: 'portfolio' } },
  { path: '/analysis', redirect: { name: 'analysis' } },
  { path: '/approvals', redirect: { name: 'activity' } },
  { path: '/rules', redirect: { name: 'settings' } },
  { path: '/watchlist', redirect: { name: 'settings' } },
  { path: '/:pathMatch(.*)*', redirect: { name: 'analysis' } },
];

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes,
});

router.afterEach((to) => {
  document.title = to.meta?.title ? `${to.meta.title} · SimpleStock` : 'SimpleStock';
});

export default router;
