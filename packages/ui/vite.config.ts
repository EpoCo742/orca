import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: false, host: '127.0.0.1' },
  build: { outDir: 'dist', emptyOutDir: true },
});
