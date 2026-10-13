import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: 'ui',
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
