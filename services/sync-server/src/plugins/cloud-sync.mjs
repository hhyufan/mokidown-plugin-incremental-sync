import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { ApiError, requireValue } from '../errors.mjs';

const empty = () => ({ seq: 0, files: {}, receipts: {}, config: { protocolVersion: 3, updatedAt: 0 } });
const hash = (value) => createHash('sha256').update(value).digest('hex');
const safeId = (value) => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value);
const metadata = ({ content: _content, ...doc }) => doc;

function validateBody(body) {
  requireValue(typeof body.content === 'string' && typeof body.compressed === 'boolean', 'content and compressed are required');
  let bytes;
  try {
    bytes = body.compressed
      ? gunzipSync(Buffer.from(body.content, 'base64'), { maxOutputLength: 32 * 1024 * 1024 })
      : Buffer.from(body.content, 'utf8');
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch { throw new ApiError(400, 'INVALID_CONTENT', 'Invalid UTF-8 or gzip content, or decoded content exceeds 32 MiB'); }
  requireValue(bytes.length <= 32 * 1024 * 1024 && body.size === bytes.length, 'Invalid size');
  requireValue(body.checksum === hash(bytes), 'SHA-256 checksum mismatch');
  for (const key of ['fileName', 'encoding', 'lineEnding', 'deviceId', 'devicePath', 'originalPath']) {
    requireValue(body[key] === undefined || (typeof body[key] === 'string' && body[key].length <= 4096), `Invalid ${key}`);
  }
}

export const cloudSyncPlugin = {
  id: 'cloud-sync', version: '1.0.0', protocolVersion: 3,
  async handle({ method, path, query, body, namespace, storage }) {
    if (!path.startsWith('/sync/')) return undefined;
    const key = `sync:${namespace}`;
    if (path === '/sync/config') {
      if (method === 'GET') return (await storage.get(key) || empty()).config;
      if (method === 'PUT') {
        requireValue(Number.isFinite(body.updatedAt) && body.updatedAt >= 0, 'updatedAt must be a timestamp in milliseconds');
        requireValue(Buffer.byteLength(JSON.stringify(body)) <= 256 * 1024, 'Config exceeds 256 KiB');
        // Connection settings and secrets must never cross devices.
        const { serverUrl: _url, syncEnabled: _enabled, accessKey: _key, workspacePath: _path, ...settings } = body;
        return storage.mutate(key, empty(), (state) => {
          if (settings.updatedAt >= state.config.updatedAt) state.config = { ...settings, protocolVersion: 3 };
          return state.config;
        });
      }
    }
    if (path === '/sync/changes' && method === 'GET') {
      const state = await storage.get(key) || empty();
      const cursor = query.get('cursor') || '0';
      requireValue(/^\d+$/.test(cursor) && Number.isSafeInteger(Number(cursor)) && Number(cursor) <= state.seq, 'Invalid cursor');
      const limit = Number(query.get('limit') || 25);
      requireValue(Number.isInteger(limit) && limit >= 1 && limit <= 100, 'limit must be 1..100');
      // Latest snapshot per document is sufficient; tombstones are retained.
      const pending = Object.values(state.files).filter((doc) => doc.seq > Number(cursor)).sort((a, b) => a.seq - b.seq);
      const changes = pending.slice(0, limit).map(metadata);
      return { changes, nextCursor: String(changes.at(-1)?.seq ?? state.seq), hasMore: pending.length > limit };
    }
    const match = path.match(/^\/sync\/(file|bindings)\/([^/]+)$/);
    if (!match) return undefined;
    const [, kind, rawId] = match;
    let fileId;
    try { fileId = decodeURIComponent(rawId); } catch { throw new ApiError(400, 'INVALID_REQUEST', 'Invalid file ID'); }
    requireValue(safeId(fileId), 'Invalid file ID');
    if (kind === 'file' && method === 'GET') {
      const doc = (await storage.get(key))?.files[fileId];
      if (!doc) throw new ApiError(404, 'FILE_NOT_FOUND', 'Document not found');
      return doc;
    }
    const binding = kind === 'bindings' && method === 'POST';
    if (!(binding || (kind === 'file' && ['PUT', 'DELETE'].includes(method)))) return undefined;
    requireValue(safeId(body.mutationId), 'A stable mutationId is required');
    if (!binding) requireValue(Number.isSafeInteger(body.baseRev) && body.baseRev >= 0, 'baseRev must be a non-negative integer');
    if (method === 'PUT') validateBody(body);
    if (binding) requireValue(safeId(body.deviceId) && typeof body.devicePath === 'string' && body.devicePath.length <= 4096, 'deviceId and devicePath are required');
    const fingerprint = hash(JSON.stringify({ method, path, body }));
    return storage.mutate(key, empty(), (state) => {
      const previous = state.receipts[body.mutationId];
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new ApiError(409, 'MUTATION_REUSED', 'mutationId was already used for another request');
        return previous.result;
      }
      const current = state.files[fileId];
      if (binding && (!current || current.deleted)) throw new ApiError(404, 'FILE_NOT_FOUND', 'Document not found');
      if (!binding && (current?.rev || 0) !== body.baseRev) throw new ApiError(409, 'REV_CONFLICT', 'Document changed on another device', { current: current || null });
      let doc;
      if (binding) {
        doc = { ...current, deviceBindings: { ...current.deviceBindings, [body.deviceId]: body.devicePath } };
      } else {
        doc = {
          fileId, rev: (current?.rev || 0) + 1, seq: ++state.seq,
          updatedAt: new Date().toISOString(), deleted: method === 'DELETE',
          ...(method === 'PUT' ? {
            content: body.content, compressed: body.compressed, size: body.size,
            checksum: body.checksum, contentHash: body.checksum,
            name: body.fileName || fileId, fileName: body.fileName || fileId,
            encoding: body.encoding || 'UTF-8', lineEnding: body.lineEnding || 'LF',
            originalPath: body.originalPath || '',
          } : { name: current?.name || fileId }),
          deviceBindings: { ...current?.deviceBindings },
        };
        if (body.deviceId && safeId(body.deviceId) && body.devicePath) doc.deviceBindings[body.deviceId] = body.devicePath;
      }
      state.files[fileId] = doc;
      const result = metadata(doc);
      // Keep receipts permanently: retries must never create a second revision.
      state.receipts[body.mutationId] = { fingerprint, result };
      return result;
    });
  },
};
