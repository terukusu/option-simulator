import { defineConfig } from 'vitest/config';
import { serveSyntheticFixtures } from './scripts/devFixtures.mjs';

export default defineConfig({
  root: 'ui',
  // 合成の板（fixtures/synthetic/）を dev サーバーでだけ /fixtures/<name>.json で配る（dist/ には入らない）
  plugins: [serveSyntheticFixtures()],
  server: {
    // 実データの dump（fixtures/local/）を dev サーバーの /@fs/ からも配らない（Vite の既定の拒否も残す）
    fs: { deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/fixtures/local/**'] },
    // 手元の API（api/ の Flask。`flask --app simulator_api.app run -p 8080`）へ /api を渡す（同一オリジンを保つ。8.3）
    proxy: { '/api': 'http://127.0.0.1:8080' },
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    // CSP（script-src 'self'）のため、modulepreload の polyfill（インライン script）を入れない
    modulePreload: { polyfill: false },
  },
  test: {
    root: '.',
    include: ['tests/**/*.test.ts'],
  },
});
