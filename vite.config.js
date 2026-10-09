import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    chunkSizeWarningLimit: 1000
  },
  server: {
    // D36: the app calls the API at a relative /api/v1 so the browser only talks to its own origin. In production
    // Vercel rewrites /api/* to the API host; this does the same in development, so one code path runs in both.
    // 4000 is the backend's default PORT.
    proxy: {
      '/api': 'http://localhost:4000'
    }
  }
})
