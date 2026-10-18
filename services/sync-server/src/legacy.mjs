import { readFile, copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { openStorage } from './storage.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');
export function migrateLegacyState(legacy) {
  if (!Number.isSafeInteger(legacy.rev) || legacy.rev < 0 || !legacy.files || Array.isArray(legacy.files)) throw new Error('Invalid legacy database');
  const state = { seq: legacy.rev, files: {}, receipts: {}, config: { protocolVersion: 3, updatedAt: 0 } };
  for (const [id, record] of Object.entries(legacy.files)) {
    if (!/^[a-zA-Z0-9_.:-]{1,128}$/.test(id) || ['__proto__', 'constructor', 'prototype'].includes(id) || !Number.isSafeInteger(record.rev) || record.rev < 1 || record.rev > legacy.rev) throw new Error('Invalid legacy file identity or revision');
    const { fileId: _id, rev, updatedAt, ...body } = record;
    if (typeof body.content !== 'string') throw new Error('Missing legacy content');
    const bytes = body.compressed ? gunzipSync(Buffer.from(body.content, 'base64'), { maxOutputLength: 32 * 1024 * 1024 }) : Buffer.from(body.content);
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (bytes.length > 32 * 1024 * 1024 || body.checksum && body.checksum !== hash(bytes) || body.size !== undefined && body.size !== bytes.length) throw new Error('Invalid legacy file checksum or size');
    const doc = { ...body, fileId: id, rev, seq: rev, updatedAt, deleted: false, compressed: Boolean(body.compressed), size: bytes.length, checksum: hash(bytes), contentHash: hash(bytes), fileName: body.fileName || body.originalPath || id, deviceBindings: {} };
    state.files[id] = doc;
    if (body.mutationId) {
      if (state.receipts[body.mutationId] || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(body.mutationId) || ['__proto__', 'constructor', 'prototype'].includes(body.mutationId)) throw new Error('Invalid legacy mutation identity');
      const { content: _content, ...result } = doc;
      state.receipts[body.mutationId] = { fingerprint: hash(JSON.stringify({ method: 'PUT', path: `/sync/file/${encodeURIComponent(id)}`, body })), result };
    }
  }
  return state;
}

// Import once into a separate durable database. The original JSON stays intact.
export async function openLegacyStorage(directory) {
  await mkdir(directory, { recursive: true });
  const storage = await openStorage({ type: 'sqlite', filename: join(directory, 'sync-v3.sqlite') });
  try {
    if (!await storage.get('sync:default')) {
      let legacy;
      try { legacy = JSON.parse(await readFile(join(directory, 'documents.json'), 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const state = legacy ? migrateLegacyState(legacy) : { seq: 0, files: {}, receipts: {}, config: { protocolVersion: 3, updatedAt: 0 } };
      if (legacy) await copyFile(join(directory, 'documents.json'), join(directory, `documents.pre-v3-${Date.now()}.json`));
      await storage.mutate('sync:default', state, () => true);
    }
    return storage;
  } catch (error) { await storage.close(); throw error; }
}
