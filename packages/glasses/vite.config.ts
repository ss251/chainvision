import fs from 'node:fs';
import { defineConfig } from 'vite';

/** The backend origin is the first entry of the network whitelist in app.json: one value to change for a hosted backend. */
const manifest = JSON.parse(fs.readFileSync(new URL('./app.json', import.meta.url), 'utf8')) as {
  permissions: Array<{ name: string; whitelist?: string[] }>;
};
const backendOrigin = manifest.permissions.find((p) => p.name === 'network')?.whitelist?.[0];
if (!backendOrigin) throw new Error('app.json needs a network permission whose whitelist names the backend origin');

export default defineConfig({
  define: {
    'import.meta.env.VITE_CHAINVISION_BACKEND': JSON.stringify(backendOrigin),
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
  },
});
