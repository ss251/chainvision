import path from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: {
    host: '127.0.0.1',
    port: 5175,
    strictPort: true,
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    rollupOptions: {
      input: {
        main: path.resolve(import.meta.dirname, 'index.html'),
        judge: path.resolve(import.meta.dirname, 'judge/index.html'),
      },
    },
  },
});
