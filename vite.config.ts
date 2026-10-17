import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

// https://vite.dev/config/
// demo: GitHub Pages 용 정적 데모(브라우저 저장소, 상대 경로). 그 외: 서버가 / 에서 서빙, /api 는 개발 때 프록시.
// 개발 서버에서 /m/... 경로에 member.html 을 돌려준다(운영은 서버가 한다)
const memberDev = (): Plugin => ({
  name: 'member-dev',
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      if (req.url?.startsWith('/m/')) req.url = '/member.html'
      next()
    })
  },
})

export default defineConfig(({ mode }) => ({
  plugins: [react(), memberDev()],
  base: mode === 'demo' ? './' : '/',
  server: {
    proxy: { '/api': 'http://localhost:8787' },
  },
  build: {
    rollupOptions: {
      input: { main: 'index.html', member: 'member.html' },
    },
  },
}))
