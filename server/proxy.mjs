/**
 * Built-in reverse proxy for the sync plugin.
 *
 * The client only ever talks to this proxy. It forwards to a single fixed
 * upstream (TARGET) and nothing else: arbitrary hosts/ports supplied by a
 * plugin are unreachable. It also injects the Bearer token and applies a
 * per-client token-bucket rate limit.
 *
 * Env:
 *   TARGET             upstream origin (default http://127.0.0.1:4319)
 *   PROXY_PORT         listen port (default 4320)
 *   SYNC_TOKEN         Bearer token injected upstream
 *   PROXY_RATE_LIMIT   requests allowed per window per client (default 60)
 *   PROXY_RATE_WINDOW_MS window size in ms (default 60000)
 *   PROXY_ALLOW_PATHS  comma separated path prefixes (default /capabilities,/sync/)
 */
import http from 'node:http';

const TARGET = process.env.TARGET || 'http://127.0.0.1:4319';
const PORT = Number(process.env.PROXY_PORT || 4320);
const TOKEN = process.env.SYNC_TOKEN || '';
const RATE_LIMIT = Number(process.env.PROXY_RATE_LIMIT || 60);
const RATE_WINDOW = Number(process.env.PROXY_RATE_WINDOW_MS || 60000);
const ALLOW_PATHS = (process.env.PROXY_ALLOW_PATHS || '/capabilities,/sync/')
  .split(',')
  .map((prefix) => prefix.trim())
  .filter(Boolean);

const upstream = new URL(TARGET);

// Token bucket per client IP. The plugin can only reach this proxy, so this is
// the single choke point for throttling.
const buckets = new Map();
function takeToken(client) {
  const now = Date.now();
  const bucket = buckets.get(client) || { tokens: RATE_LIMIT, updated: now };
  const refill = ((now - bucket.updated) / RATE_WINDOW) * RATE_LIMIT;
  bucket.tokens = Math.min(RATE_LIMIT, bucket.tokens + refill);
  bucket.updated = now;
  if (bucket.tokens < 1) {
    buckets.set(client, bucket);
    return false;
  }
  bucket.tokens -= 1;
  buckets.set(client, bucket);
  return true;
}

function allowedPath(pathname) {
  return ALLOW_PATHS.some((prefix) => pathname === prefix || pathname.startsWith(prefix));
}

const server = http.createServer((req, res) => {
  const client = req.socket.remoteAddress || 'unknown';
  const url = new URL(req.url, 'http://localhost');

  if (TOKEN) {
    const provided = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (provided !== TOKEN) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'Unauthorized' }));
      return;
    }
  }
  if (!allowedPath(url.pathname)) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'Not found' }));
    return;
  }
  if (!takeToken(client)) {
    res.writeHead(429, {
      'Content-Type': 'application/json',
      'Retry-After': String(Math.ceil(RATE_WINDOW / 1000)),
    });
    res.end(JSON.stringify({ message: 'Too many requests' }));
    return;
  }

  const headers = { ...req.headers, host: upstream.host };
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
  const request = http.request(new URL(req.url, upstream), { method: req.method, headers }, (response) => {
    res.writeHead(response.statusCode || 502, response.headers);
    response.pipe(res);
  });
  request.on('error', (error) => {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: `Upstream error: ${error.message}` }));
  });
  req.pipe(request);
});

server.listen(PORT, process.env.PROXY_HOST || '127.0.0.1', () => {
  console.log(
    `[sync-proxy] http://127.0.0.1:${PORT} -> ${TARGET} ` +
      `(token ${TOKEN ? 'injected' : 'off'}, ${RATE_LIMIT} req/${RATE_WINDOW}ms)`,
  );
});
