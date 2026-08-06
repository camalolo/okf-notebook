import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: '/',
  build: {
    outDir: 'dist/public',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api/notebook': {
        target: 'http://localhost:3002',
        changeOrigin: true,
      },
    },
  },
})
