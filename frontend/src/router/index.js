import { createRouter, createWebHistory } from 'vue-router';

/**
 * 🤖 자율형 트레이딩 앱 라우트 (2026-10-03~04 — 와이어프레임 10장 전부)
 * D-7(종목 상세)·D-9(전략 연구소)는 10-04 에 백엔드(백테스트 러너·감사 이력)와 함께 완성.
 */
const routes = [
  { path: '/', name: 'dashboard', component: () => import('../views/WorkspaceView.vue'), meta: { title: '대시보드' } },
  { path: '/approvals', name: 'approvals', component: () => import('../views/ApprovalsView.vue'), meta: { title: '승인 대기' } },
  { path: '/activity', name: 'activity', component: () => import('../views/ActivityView.vue'), meta: { title: '활동 로그' } },
  { path: '/risk', name: 'risk', component: () => import('../views/RiskView.vue'), meta: { title: '포트폴리오·리스크' } },
  { path: '/report', name: 'report', component: () => import('../views/ReportView.vue'), meta: { title: '성과 리포트' } },
  { path: '/rules', name: 'rules', component: () => import('../views/RulesView.vue'), meta: { title: '운용 규칙' } },
  { path: '/lab', name: 'lab', component: () => import('../views/StrategyView.vue'), meta: { title: '전략 연구소' } },
  { path: '/symbol/:code', name: 'symbol', component: () => import('../views/SymbolView.vue'), meta: { title: '종목 상세' } },
];

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes,
});

router.afterEach((to) => {
  document.title = to.meta?.title ? `${to.meta.title} · SimpleStock` : 'SimpleStock';
});

export default router;
