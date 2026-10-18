const encoder = new TextEncoder();
// Preserve UTF-8 BOM as U+FEFF so decoding cannot change the hashed content.
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const MAX_DECODED = 32 * 1024 * 1024;
export const sha256 = async (value) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))).map((byte) => byte.toString(16).padStart(2, '0')).join('');
export function validPath(path) {
  return typeof path === 'string' && path.length <= 4096 && !path.includes('\\')
    && path.split('/').every((part) => part && part !== '.' && part !== '..' && !part.includes(':') && !part.startsWith('.'))
    && /\.(md|markdown|txt)$/i.test(path);
}

export async function decodeDocument(doc) {
  if (typeof doc.content !== 'string') throw new Error('Missing remote document content');
  let bytes;
  if (doc.compressed) {
    const compressed = Uint8Array.from(atob(doc.content), (char) => char.charCodeAt(0));
    const reader = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
    const chunks = []; let size = 0;
    try {
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        size += chunk.value.length;
        if (size > MAX_DECODED) throw new Error('Remote document exceeds 32 MiB');
        chunks.push(chunk.value);
      }
    } finally { await reader.cancel(); }
    bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  } else bytes = encoder.encode(doc.content);
  if (bytes.length > MAX_DECODED || bytes.length !== doc.size) throw new Error('Remote document size mismatch');
  const content = decoder.decode(bytes);
  if (await sha256(content) !== (doc.contentHash || doc.checksum)) throw new Error('Remote document checksum mismatch');
  return content;
}

async function encodeDocument(content) {
  const raw = encoder.encode(content);
  if (raw.length > MAX_DECODED) throw new Error('Document exceeds 32 MiB');
  const checksum = await sha256(content);
  if (raw.length < 16384) return { content, compressed: false, size: raw.length, checksum };
  const bytes = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  return { content: btoa(binary), compressed: true, size: raw.length, checksum };
}

export class IncrementalSync {
  constructor(rpc, report = () => {}) { this.rpc = rpc; this.report = report; this.running = false; this.stopped = false; }
  stop() { this.stopped = true; }
  async call(method, args) {
    if (this.stopped) throw new Error('Plugin stopped');
    const result = await this.rpc(method, args);
    if (this.stopped) throw new Error('Plugin stopped');
    return result;
  }
  async request(path, method = 'GET', body) {
    const response = await this.call('net.request', { path, method, body });
    if (response.status >= 400) {
      const error = new Error(response.data.message || `HTTP ${response.status}`);
      Object.assign(error, { status: response.status, data: response.data }); throw error;
    }
    return response.data;
  }
  async initialize() {
    const context = await this.call('context');
    if (!context.endpoint || !context.workspace) throw new Error('请先在语言服务 → 服务插件中配置服务地址、访问密钥和目录。');
    const capability = await this.request('/capabilities');
    if (capability.service !== 'mokidown-plugin-server' || !capability.plugins?.some((entry) => entry.id === 'cloud-sync' && entry.protocolVersion === 3)) throw new Error('服务未启用 cloud-sync v3 插件');
    if (!capability.instanceId || !capability.namespace) throw new Error('服务缺少实例或工作区标识');
    // LAN and tunnel URLs can point at the same service. Keep its incremental
    // cursor and pending mutation across endpoint changes.
    this.storageKey = `state-${await sha256(`${context.workspaceId}:${capability.instanceId}:${capability.namespace}`)}`;
    this.state = await this.call('storage.get', { key: this.storageKey });
    if (!this.state) {
      const legacyKey = `state-${await sha256(`${context.endpoint}:${context.workspaceId}:${capability.instanceId}:${capability.namespace}`)}`;
      this.state = await this.call('storage.get', { key: legacyKey }) || { version: 1, cursor: '', files: {}, conflicts: {}, pending: null };
      await this.save();
    }
  }
  save() { return this.call('storage.set', { key: this.storageKey, value: this.state }); }
  async replayPending() {
    const pending = this.state.pending;
    if (!pending) return;
    try {
      const doc = await this.request(`/sync/file/${encodeURIComponent(pending.fileId)}`, pending.method, pending.body);
      this.state.files[pending.fileId] = { path: pending.path, rev: doc.rev, checksum: pending.body.checksum || '', deleted: pending.method === 'DELETE' };
      delete this.state.conflicts[pending.fileId];
      this.state.pending = null;
      await this.save();
    } catch (error) {
      if (error.status !== 409 || error.data.code !== 'REV_CONFLICT') throw error;
      const disk = await this.call('fs.read', { path: pending.path });
      this.state.conflicts[pending.fileId] = { path: pending.path, localHash: disk.checksum, remoteRev: error.data.current?.rev || 0 };
      this.state.pending = null; await this.save();
    }
  }
  async enqueue(fileId, path, rev, disk) {
    const body = disk.content === null ? {} : { ...await encodeDocument(disk.content), fileName: path, encoding: 'UTF-8', lineEnding: disk.content.includes('\r\n') ? 'CRLF' : 'LF' };
    Object.assign(body, { baseRev: rev, mutationId: crypto.randomUUID() });
    if (encoder.encode(JSON.stringify(body)).length > 3.5 * 1024 * 1024) throw new Error(`文件请求超过 3.5 MiB: ${path}`);
    this.state.pending = { fileId, path, method: disk.content === null ? 'DELETE' : 'PUT', body };
    // Persist the immutable operation before its first network request.
    await this.save(); await this.replayPending();
  }
  async applyRemote(doc, { force = false } = {}) {
    const record = this.state.files[doc.fileId];
    if (doc.deleted && !record) return;
    const path = record?.path || doc.fileName;
    if (!validPath(path)) throw new Error(`远端文档路径无效: ${path}`);
    const collision = Object.entries(this.state.files).some(([id, other]) => id !== doc.fileId && !other.deleted && other.path === path);
    const disk = await this.call('fs.read', { path });
    const remoteHash = doc.deleted ? null : doc.contentHash || doc.checksum;
    const localChanged = record ? disk.checksum !== (record.deleted ? null : record.checksum) : disk.content !== null;
    if (!force && (collision || (localChanged && disk.checksum !== remoteHash))) {
      this.state.conflicts[doc.fileId] = { path, localHash: disk.checksum, remoteRev: doc.rev };
      await this.save(); return;
    }
    if (force && collision) throw new Error('Another document already owns this local path');
    if (doc.deleted) {
      if (disk.content !== null) await this.call('fs.delete', { path, expectedHash: disk.checksum });
    } else {
      const content = await decodeDocument(doc);
      if (disk.checksum !== remoteHash) await this.call('fs.write', { path, content, expectedHash: disk.checksum });
    }
    this.state.files[doc.fileId] = { path, rev: doc.rev, checksum: remoteHash || '', deleted: !!doc.deleted };
    delete this.state.conflicts[doc.fileId]; await this.save();
  }
  async pull() {
    let more = true;
    while (more) {
      const page = await this.request(`/sync/changes?cursor=${encodeURIComponent(this.state.cursor)}&limit=25`);
      if (!Array.isArray(page?.changes) || typeof page.nextCursor !== 'string' || typeof page.hasMore !== 'boolean' || (page.hasMore && page.nextCursor === this.state.cursor)) throw new Error('SYNC_PROTOCOL_MISMATCH: 服务端增量分页协议不完整，请升级服务端；需要 changes、nextCursor 和 hasMore，不能用旧版 cursor 响应代替。');
      for (const change of page.changes) {
        if (!/^[a-zA-Z0-9_.:-]{1,128}$/.test(change.fileId || '') || ['__proto__', 'constructor', 'prototype'].includes(change.fileId) || !Number.isSafeInteger(change.rev) || change.rev < 1) throw new Error('Invalid change entry');
        if ((this.state.files[change.fileId]?.rev || 0) >= change.rev || this.state.conflicts[change.fileId]) continue;
        const doc = change.deleted ? change : await this.request(`/sync/file/${encodeURIComponent(change.fileId)}`);
        if (doc.fileId !== change.fileId || !Number.isSafeInteger(doc.rev) || doc.rev < change.rev) throw new Error('Remote document does not match the changes page');
        await this.applyRemote(doc);
      }
      this.state.cursor = page.nextCursor;
      await this.save(); more = Boolean(page.hasMore);
    }
  }
  async scan(path = '', files = new Map(), depth = 0) {
    if (depth > 32 || files.size > 10000) throw new Error('目录过深或文件超过 10000 个');
    const entries = await this.call('fs.list', { path });
    for (const entry of entries) {
      if (!entry.name || entry.name.includes('/') || entry.name.includes('\\') || entry.name === '.' || entry.name === '..') throw new Error('Invalid directory entry');
      const relative = path ? `${path}/${entry.name}` : entry.name;
      if (entry.directory) await this.scan(relative, files, depth + 1);
      else if (validPath(relative)) files.set(relative, await this.call('fs.read', { path: relative }));
    }
    return files;
  }
  async cycle() {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      if (!this.state) await this.initialize();
      this.report({ phase: '同步中…', state: this.state });
      await this.replayPending();
      await this.pull();
      const files = await this.scan();
      const byPath = new Map(Object.entries(this.state.files).filter(([, record]) => !record.deleted).map(([id, record]) => [record.path, { id, ...record }]));
      const conflictPaths = new Set(Object.values(this.state.conflicts).map((conflict) => conflict.path));
      for (const [path, disk] of files) {
        if (conflictPaths.has(path)) continue;
        const record = byPath.get(path);
        if (disk.content !== null && disk.checksum !== record?.checksum) await this.enqueue(record?.id || crypto.randomUUID(), path, record?.rev || 0, disk);
      }
      // Deletions are propagated only after a complete successful directory scan.
      for (const [fileId, record] of Object.entries(this.state.files)) {
        if (!record.deleted && !files.has(record.path) && !this.state.conflicts[fileId]) {
          const current = await this.call('fs.read', { path: record.path });
          if (current.content === null) await this.enqueue(fileId, record.path, record.rev, current);
        }
      }
      this.report({ phase: '已完成增量同步', state: this.state });
    } catch (error) { this.report({ phase: error.message, error: true, state: this.state }); }
    finally { this.running = false; }
  }
  async resolve(fileId, choice) {
    if (this.running) throw new Error('请等待当前同步结束');
    const conflict = this.state?.conflicts[fileId];
    if (!conflict) return;
    this.running = true;
    try {
      const disk = await this.call('fs.read', { path: conflict.path });
      if (disk.checksum !== conflict.localHash) throw new Error('冲突后本地文件再次改变，请保留本地版本或重新启用插件后检查。');
      const remote = await this.request(`/sync/file/${encodeURIComponent(fileId)}`);
      if (choice === 'local') await this.enqueue(fileId, conflict.path, remote.rev, disk);
      else await this.applyRemote(remote, { force: true });
      this.report({ phase: '冲突已处理', state: this.state });
    } finally { this.running = false; }
  }
}
