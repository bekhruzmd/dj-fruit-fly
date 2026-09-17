import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Python analyzes uploads locally; the browser stays on the Vite origin.
  server: { proxy: {
    '/api/analysis': { target: 'http://127.0.0.1:8765', changeOrigin: true, timeout: 180000, proxyTimeout: 180000 },
    '/api/lesson-builder': { target: 'http://127.0.0.1:8766', changeOrigin: true, timeout: 180000, proxyTimeout: 180000 },
  } },
})

// Module summary: This config serves the interface and forwards analysis and lesson requests to Python.
// The three-minute timeout allows a cold librosa/Numba run without moving DSP into the UI thread.
// The proxy is development-only; a hosted build requires its own /api/analysis routing.
