import { createRouter, createWebHistory } from 'vue-router';

/**
 * 🤖 자율형 트레이딩 앱 라우트 (2026-10-03 — 와이어프레임 10장 준용)
 *
 * ⚠️ D-7(종목 상세)·D-9(전략 연구소)는 **이번에 안 만든다** — 백테스트 실행·전략 배분의
 *    백엔드가 없다. 없는 데이터를 화면으로 지어내는 것이 이 저장소가 가장 꺼리는 일이라,
 *    사이드바에 "준비 중" 으로 정직하게 표시한다(AppShell 참조).
 */
const routes = [
  { path: '/', name: 'dashboard', component: () => import('../views/WorkspaceView.vue'), meta: { title: '대시보드' } },
  { path: '/approvals', name: 'approvals', component: () => import('../views/ApprovalsView.vue'), meta: { title: '승인 대기' } },
  { path: '/activity', name: 'activity', component: () => import('../views/ActivityView.vue'), meta: { title: '활동 로그' } },
  { path: '/risk', name: 'risk', component: () => import('../views/RiskView.vue'), meta: { title: '포트폴리오·리스크' } },
  { path: '/report', name: 'report', component: () => import('../views/ReportView.vue'), meta: { title: '성과 리포트' } },
  { path: '/rules', name: 'rules', component: () => import('../views/RulesView.vue'), meta: { title: '운용 규칙' } },
];

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes,
});

router.afterEach((to) => {
  document.title = to.meta?.title ? `${to.meta.title} · SimpleStock` : 'SimpleStock';
});

export default router;
