import { defineConfig, loadEnv } from 'vite';
import vue from '@vitejs/plugin-vue';

// 통합 nginx 게이트웨이 뒤에서 prefix 경로(/simpleStock)로 서빙할 때는
// VITE_BASE_PATH=/simpleStock/ 로 빌드하세요. 단독 실행이면 빈 값(/) 사용.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const base = env.VITE_BASE_PATH || '/';
  return {
    base,
    plugins: [vue()],
    build: {
      outDir: '../dist',
      emptyOutDir: true,
    },
    server: {
      port: 5173,
      proxy: {
        '/api': { target: 'http://127.0.0.1:50000', changeOrigin: true },
      },
    },
  };
});
