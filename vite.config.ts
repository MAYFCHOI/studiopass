import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
// demo: GitHub Pages 용 정적 데모(브라우저 저장소, 상대 경로). 그 외: 서버가 / 에서 서빙, /api 는 개발 때 프록시.
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  base: mode === 'demo' ? './' : '/',
  server: {
    proxy: { '/api': 'http://localhost:8787' },
  },
  build: {
    rollupOptions: {
      // Task 9 에서 member: 'member.html' 을 더한다
      input: { main: 'index.html' },
    },
  },
}))
