/**
 * Reverse proxy in front of the sync server.
 *
 * The client only talks to the proxy (no token in the app); the proxy injects
 * the Bearer token, so the real server can stay on a private port.
 *
 * Env: TARGET (default http://127.0.0.1:4319), PROXY_PORT (default 4320),
 *      SYNC_TOKEN (injected as Authorization).
 */
import http from 'node:http';

const TARGET = process.env.TARGET || 'http://127.0.0.1:4319';
const PORT = Number(process.env.PROXY_PORT || 4320);
const TOKEN = process.env.SYNC_TOKEN || '';

const server = http.createServer((req, res) => {
  const headers = { ...req.headers, host: new URL(TARGET).host };
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
  const upstream = http.request(new URL(req.url, TARGET), { method: req.method, headers }, (up) => {
    res.writeHead(up.statusCode || 502, up.headers);
    up.pipe(res);
  });
  upstream.on('error', (error) => {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: `Upstream error: ${error.message}` }));
  });
  req.pipe(upstream);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[sync-proxy] http://127.0.0.1:${PORT} -> ${TARGET} (token ${TOKEN ? 'injected' : 'off'})`);
});
