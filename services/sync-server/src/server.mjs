import { createServer } from 'node:http';
import { createHash, timingSafeEqual, randomUUID } from 'node:crypto';
import { ApiError } from './errors.mjs';
import { cloudSyncPlugin } from './plugins/cloud-sync.mjs';

const digest = (text) => createHash('sha256').update(text).digest();
const MAX_BODY = 3.5 * 1024 * 1024;

async function readBody(req) {
  const chunks = [];
  let size = 0;
  await new Promise((resolve, reject) => {
    let tooLarge = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        if (!tooLarge) reject(new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Request exceeds 3.5 MiB'));
        tooLarge = true; return;
      }
      chunks.push(chunk);
    });
    req.on('end', resolve);
    req.on('error', reject);
    req.on('aborted', () => reject(new ApiError(408, 'REQUEST_ABORTED', 'Request aborted')));
  });
  if (!size) return {};
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw new ApiError(415, 'JSON_REQUIRED', 'Use Content-Type: application/json');
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || Array.isArray(body) || typeof body !== 'object') throw new Error();
    return body;
  } catch { throw new ApiError(400, 'INVALID_JSON', 'Expected a JSON object'); }
}

// A plugin only owns its routes; the host owns configuration, authentication,
// request bounds and the database. No dynamic code download or vendor service.
export function createPluginServer(config, storage, availablePlugins = [cloudSyncPlugin]) {
  const plugins = config.plugins.map((id) => {
    const plugin = availablePlugins.find((candidate) => candidate.id === id);
    if (!plugin) throw new Error(`Unknown plugin: ${id}`);
    return plugin;
  });
  const keys = config.accessKeys.map((entry) => ({ ...entry, digest: digest(entry.key) }));
  const server = createServer({ requestTimeout: 30000, headersTimeout: 15000, maxHeaderSize: 16384 }, async (req, res) => {
    const requestId = randomUUID();
    res.setHeader('X-Request-ID', requestId);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const send = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
    };
    try {
      const origin = req.headers.origin;
      if (origin) {
        if (!config.corsOrigins.includes(origin)) throw new ApiError(403, 'ORIGIN_DENIED', 'Origin is not allowed');
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Cache-Control, Pragma, Expires');
        res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, POST, DELETE, OPTIONS');
      }
      const url = new URL(req.url, 'http://localhost');
      const prefix = config.basePath || '';
      if (prefix && !url.pathname.startsWith(`${prefix}/`)) throw new ApiError(404, 'NOT_FOUND', 'Route not found');
      const path = url.pathname.slice(prefix.length);
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
      if (path === '/healthz' && req.method === 'GET') return send(200, { status: 'ok' });
      const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1] || '';
      const tokenHash = digest(token);
      const entry = keys.find((candidate) => timingSafeEqual(candidate.digest, tokenHash));
      if (!entry) throw new ApiError(401, 'ACCESS_KEY_REQUIRED', 'Provide a valid service access key');
      if (path === '/readyz' && req.method === 'GET') {
        await storage.get(`sync:${entry.namespace}`);
        return send(200, { status: 'ready' });
      }
      if (path === '/capabilities' && req.method === 'GET') return send(200, {
        service: 'mokidown-plugin-server', version: 1, instanceId: config.instanceId,
        namespace: entry.namespace, authentication: 'access-key', registration: false,
        plugins: plugins.map(({ id, version, protocolVersion }) => ({ id, version, protocolVersion })),
        limits: { requestBytes: MAX_BODY, decodedBytes: 32 * 1024 * 1024, stateBytes: storage.maxBytes },
      });
      const body = await readBody(req);
      for (const plugin of plugins) {
        const result = await plugin.handle({ method: req.method, path, query: url.searchParams, body, namespace: entry.namespace, storage });
        if (result !== undefined) return send(200, result);
      }
      throw new ApiError(404, 'NOT_FOUND', 'Route not found or plugin disabled');
    } catch (error) {
      const known = error instanceof ApiError;
      if (!known) console.error(JSON.stringify({ requestId, code: 'INTERNAL_ERROR', type: error.name }));
      if (!res.headersSent && !res.destroyed) send(known ? error.status : 503, {
        code: known ? error.code : 'SERVICE_UNAVAILABLE', message: known ? error.message : 'Storage or service unavailable',
        ...(known ? error.details : {}), requestId,
      });
    }
  });
  server.keepAliveTimeout = 5000;
  return server;
}
