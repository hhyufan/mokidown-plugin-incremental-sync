/**
 * Minimal sync server for the MokiDown incremental-sync plugin.
 *
 * Implements the protocol the plugin calls:
 *   GET    /capabilities
 *   PUT    /sync/file/:fileId
 *   GET    /sync/file/:fileId
 *   DELETE /sync/file/:fileId
 *   GET    /sync/changes?cursor=&limit=
 *
 * Auth: Bearer token from SYNC_TOKEN (except /capabilities, which is the
 * handshake). Storage: a JSON file under DATA_DIR.
 */
import http from 'node:http';
import crypto from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PORT = Number(process.env.PORT || 4319);
const TOKEN = process.env.SYNC_TOKEN || '';
const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), '.data');
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = join(DATA_DIR, 'documents.json');

function loadDb() {
  if (!existsSync(DB_FILE)) return { rev: 0, files: {} };
  try { return JSON.parse(readFileSync(DB_FILE, 'utf8')); } catch { return { rev: 0, files: {} }; }
}
const db = loadDb();
const saveDb = () => writeFileSync(DB_FILE, JSON.stringify(db, null, 2));

const send = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

function authorized(req) {
  if (!TOKEN) return true;
  const header = req.headers.authorization || '';
  return header === `Bearer ${TOKEN}`;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const chunks = [];
  let received = 0;
  let aborted = false;
  req.on('data', (chunk) => {
    if (aborted) return;
    received += chunk.length;
    if (received > 4 * 1024 * 1024) {
      aborted = true;
      send(res, 413, { message: 'Request body exceeds 4 MiB' });
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    let body = null;
    const raw = Buffer.concat(chunks).toString('utf8');
    if (raw) {
      try { body = JSON.parse(raw); } catch { return send(res, 400, { message: 'Invalid JSON' }); }
    }

    if (url.pathname === '/capabilities') {
      return send(res, 200, {
        service: 'mokidown-plugin-server',
        instanceId: 'mokidown-sync-local',
        namespace: 'default',
        name: 'mokidown-sync',
        version: '1.0.0',
        plugins: [
          { id: 'cloud-sync', protocolVersion: 3 },
          { id: 'mokidown.incremental-sync', protocolVersion: 1 },
        ],
        capabilities: ['incremental-sync', 'cloud-sync-v3'],
      });
    }
    if (!authorized(req)) return send(res, 401, { message: 'Unauthorized' });

    const fileMatch = url.pathname.match(/^\/sync\/file\/(.+)$/);
    if (fileMatch) {
      const fileId = decodeURIComponent(fileMatch[1]);
      if (req.method === 'PUT') {
        if (!body || typeof body.content !== 'string') return send(res, 400, { message: 'Missing content' });
        if (body.checksum) {
          const actual = crypto.createHash('sha256').update(body.content, 'utf8').digest('hex');
          if (body.compressed === false && actual !== body.checksum) {
            return send(res, 422, { message: 'Checksum mismatch' });
          }
        }
        db.rev += 1;
        db.files[fileId] = { ...body, fileId, rev: db.rev, updatedAt: Date.now() };
        saveDb();
        return send(res, 200, { fileId, rev: db.rev });
      }
      if (req.method === 'GET') {
        const entry = db.files[fileId];
        return entry ? send(res, 200, entry) : send(res, 404, { message: 'Not found' });
      }
      if (req.method === 'DELETE') {
        const existed = Boolean(db.files[fileId]);
        delete db.files[fileId];
        saveDb();
        return send(res, existed ? 200 : 404, { fileId, deleted: existed });
      }
      return send(res, 405, { message: 'Method not allowed' });
    }

    if (url.pathname === '/sync/changes' && req.method === 'GET') {
      const cursor = Number(url.searchParams.get('cursor') || 0);
      const limit = Math.min(Number(url.searchParams.get('limit') || 25), 200);
      const changes = Object.values(db.files)
        .filter((entry) => entry.rev > cursor)
        .sort((a, b) => a.rev - b.rev)
        .slice(0, limit)
        .map((entry) => ({ fileId: entry.fileId, path: entry.originalPath || entry.fileName, rev: entry.rev, deleted: false }));
      return send(res, 200, { changes, cursor: db.rev });
    }

    send(res, 404, { message: 'Not found' });
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[sync-server] listening on http://127.0.0.1:${PORT} (auth ${TOKEN ? 'on' : 'off'})`);
});
