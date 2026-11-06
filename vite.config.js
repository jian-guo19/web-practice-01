import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    open: false,
    // 把前端的 /api 请求转发到后端 server.js（端口 3001）
    // 这样浏览器不用直连大模型（避免 CORS 和泄露 Key）
    proxy: {
      '/api': 'http://localhost:3001',
    },
  },
})
