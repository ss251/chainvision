import { defineConfig } from 'vite';

export default defineConfig({
  base: '/miniapp/',
  server: {
    host: '127.0.0.1',
    port: 5174,
    strictPort: true,
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
  },
});
