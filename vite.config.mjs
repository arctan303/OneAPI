import { defineConfig } from 'vite';

export default defineConfig({
  root: 'public',
  server: {
    port: 5173,
    host: '127.0.0.1',
    proxy: {
      '^/(admin|v1|health|access)': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq, req) => {
            // 重写同源检查标头以穿透 OneAPI 后端的 CSRF/Host 校验
            proxyReq.setHeader('Origin', 'http://127.0.0.1:8787');
            proxyReq.setHeader('Host', '127.0.0.1:8787');
            if (req.headers['sec-fetch-site']) {
              proxyReq.setHeader('Sec-Fetch-Site', 'same-origin');
            }
          });
        }
      }
    }
  }
});
