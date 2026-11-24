import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// The simulator has no database or playback backend. Only this loopback proxy
// translates its validated local origin into the production origin.
const upstream = process.env.HUB_UPSTREAM;
const target = upstream ? new URL(upstream) : null;
if (
  target &&
  (target.protocol !== 'https:' || target.username || target.password)
)
  throw Error(
    'HUB_UPSTREAM must be a trusted HTTPS origin without credentials',
  );
const hosts = new Set(['localhost:5173', '127.0.0.1:5173']);
function localRequest(
  req: import('node:http').IncomingMessage,
  websocket = false,
) {
  const origin = req.headers.origin;
  return (
    hosts.has(req.headers.host ?? '') &&
    req.headers['sec-fetch-site'] !== 'cross-site' &&
    (!origin ? !websocket : origin === `http://${req.headers.host}`)
  );
}
const guard: Plugin = {
  name: 'loopback-proxy-guard',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (!localRequest(req)) {
        res.writeHead(403).end('Local origin required');
        return;
      }
      next();
    });
  },
};
function proxy(ws = false) {
  return {
    target: target?.origin ?? 'http://127.0.0.1:3000',
    changeOrigin: !!target,
    secure: true,
    ws,
    configure(
      p: Parameters<NonNullable<import('vite').ProxyOptions['configure']>>[0],
    ) {
      if (!target) return;
      p.on('proxyReq', (outgoing) =>
        outgoing.setHeader('origin', target.origin),
      );
      p.on('proxyReqWs', (outgoing, req, socket) => {
        if (!localRequest(req, true)) {
          socket.destroy();
          outgoing.destroy();
          return;
        }
        outgoing.setHeader('origin', target.origin);
      });
      p.on('proxyRes', (response) => {
        // Only the loopback hop is HTTP. Preserve HttpOnly and SameSite=Strict;
        // the authoritative HTTPS server always emits Secure cookies.
        const cookies = response.headers['set-cookie'];
        if (cookies)
          response.headers['set-cookie'] = cookies.map((cookie) =>
            /^hub_(parent|child)=/.test(cookie)
              ? cookie.replace(/;\s*Secure\b/gi, '')
              : cookie,
          );
      });
    },
  };
}
export default defineConfig({
  plugins: [react(), ...(target ? [guard] : [])],
  build: { outDir: 'dist/client' },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: { '/api': proxy(true), '/artwork': proxy() },
  },
});
