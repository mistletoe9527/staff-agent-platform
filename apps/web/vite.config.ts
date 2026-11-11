import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * 管理后台构建配置。
 * 开发时把 /api 与 /bind 代理到本地平台，生产由 Fastify 直接托管 dist。
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8787',
      '/bind': 'http://127.0.0.1:8787',
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
