import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: { port: 5173 },
  build: {
    rollupOptions: {
      // React y el router van en su propio fichero: cambian poco y el navegador los cachea.
      output: { manualChunks: { vendor: ['react', 'react-dom', 'react-router-dom', 'zustand'] } },
    },
  },
  test: { environment: 'node' },
} as any);
