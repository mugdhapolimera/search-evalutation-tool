/// <reference types="vitest" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The build lands inside the Python package, so Flask serves the page and the
// API from one process. In development, `npm run dev` proxies /api to Flask.
export default defineConfig({
  plugins: [react()],
  build: { outDir: '../search_eval/frontend_dist', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:8181' },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
  },
});
