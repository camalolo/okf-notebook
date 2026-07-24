import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: '/',
  build: {
    outDir: '/srv/notebook',
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
