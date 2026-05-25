import { createRouter, createWebHistory } from 'vue-router';

const routes = [
  {
    path: '/',
    name: 'workspace',
    component: () => import('../views/WorkspaceView.vue'),
    meta: { title: 'Workspace' },
  },
];

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes,
});

router.afterEach((to) => {
  document.title = to.meta?.title ? `${to.meta.title} · SimpleStock` : 'SimpleStock';
});

export default router;
