import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `npm run build` writes straight into the Spring Boot static folder, and that output is committed,
// so the demo laptop needs only Java. `npm run dev` proxies the API to a running Control Centre.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '../src/main/resources/static',
    emptyOutDir: true,
    assetsDir: 'assets',
    chunkSizeWarningLimit: 800,
  },
  server: {
    port: 5173,
    proxy: { '/api': { target: 'http://localhost:7070', changeOrigin: true } },
  },
});
