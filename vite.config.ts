import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  root: 'frontend',
  plugins: [react()],
  server: {
    port: 5174, strictPort: true, host: true,
    allowedHosts: ['lumina.com.br'],
    proxy: { '/api': 'http://127.0.0.1:4000' }
  },
  build: { outDir: '../dist/frontend', emptyOutDir: true }
});
