import { definePlugin } from '@mokidown/sdk';
import { IncrementalSync, decodeDocument, sha256 } from './engine.mjs';

const cloud = (color) => `<svg viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2"><path d="M7 18h10a4 4 0 0 0 .6-7.96A6 6 0 0 0 6.2 9.2 4.5 4.5 0 0 0 7 18Z"/></svg>`;
const check = (color) => `<svg viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
const cross = (color) => `<svg viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2.4" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>`;
const warningTriangle = (color) => `<svg viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;
// Status icons are the plugin's choice: check = synced, triangle = conflicts, cross = failure.
const ICONS = { success: check('#3fb950'), warning: warningTriangle('#d29922'), error: cloud('#f85149'), info: cloud('currentColor') };
// File-list badges keep the cloud, colored by state.
const BADGES = { success: cloud('#3fb950'), warning: cloud('#d29922'), error: cloud('#f85149') };

definePlugin(async (sdk) => {
  // Server snapshots use ISO strings; the plugin's local fallback stores epoch ms.
  const toTimestamp = (value) => {
    if (Number.isFinite(value)) return value;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : Date.now();
  };
  // Older editor builds only read label/meta; keep them in sync so the list
  // still shows a readable time and size there.
  const formatPluginTime = (value) => {
    const date = new Date(toTimestamp(value));
    const now = new Date();
    const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    if (date.toDateString() === now.toDateString()) return time;
    const sameYear = date.getFullYear() === now.getFullYear();
    const day = date.toLocaleDateString(undefined, sameYear
      ? { month: '2-digit', day: '2-digit' }
      : { year: 'numeric', month: '2-digit', day: '2-digit' });
    return `${day} ${time}`;
  };
  const formatPluginBytes = (bytes) => {
    if (!Number.isFinite(bytes) || bytes < 0) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  };
  let engine, timer, scheduled, publishing = false, again = false, versionTarget = null;
  // Storage keys only allow [a-zA-Z0-9_.-], so normalise the file id.
  const historyKey = (fileId) => 'history.' + String(fileId).replace(/[^a-zA-Z0-9_-]/g, '_');
  // Keep a local snapshot history so cloud history works even with servers
  // that do not store revisions (and gives us the content for diffs).
  const recordSnapshot = async ({ fileId, rev, checksum, size, content }) => {
    if (!fileId || !Number.isSafeInteger(rev) || typeof content !== 'string') return;
    if (content.length > 512 * 1024) return;
    const key = historyKey(fileId);
    const stored = await sdk.storage.get(key).catch(() => null);
    const list = Array.isArray(stored) ? stored : [];
    if (list.some((entry) => entry.rev === rev)) return;
    list.push({ rev, checksum, size, content, updatedAt: Date.now() });
    await sdk.storage.set(key, list.slice(-10)).catch(() => {});
  };
  const statusIds = new Set(), presentations = new Map();
  const publish = async () => {
    if (publishing) { again = true; return; }
    publishing = true;
    try {
      const documents = await sdk.editor.listDocuments();
      const alive = new Set();
      const files = Object.entries(engine?.state?.files || {}).filter(([, file]) => !file.deleted && !file.detached);
      const conflicts = Object.entries(engine?.state?.conflicts || {});
      for (const document of documents) {
        const path = document.relativePath;
        if (!path) continue;
        const conflict = conflicts.find(([, record]) => record.path === path);
        const record = files.find(([, file]) => file.path === path);
        if (!conflict && !record && !engine.fileErrors.has(path) && !engine.lastError && engine.state?.pending?.path !== path && engine.activePath !== path) continue;
        const id = `document.${(await sha256(`${document.id}:${path}`)).slice(0, 32)}`;
        alive.add(id);
        const resolved = engine.state?.resolutions?.[path];
        const error = engine.fileErrors.get(path) || engine.lastError;
        const busy = engine.activePath === path || (engine.running && !engine.activePath);
        const completed = record && resolved?.fileId === record[0] && resolved.rev === record[1].rev && resolved.checksum === record[1].checksum;
        const text = busy ? '同步中…' : error ? '同步失败' : conflict ? '同步冲突' : completed ? '冲突解决完成' : '已同步';
        const tone = busy ? 'info' : error ? 'error' : conflict ? 'warning' : 'success';
        const item = { documentId: document.id, text, title: error || `${document.name} · ${text}`, icon: ICONS[tone], tone, busy, command: conflict ? 'sync.handle' : 'sync.now', args: { documentId: document.id, path } };
        const key = JSON.stringify(item);
        if (presentations.get(id) !== key) { await sdk.statusBar.set(id, item); presentations.set(id, key); }
        statusIds.add(id);
      }
      // Extra entry for the open cloud file: open its cloud revisions.
      const activeDocument = documents.find((entry) => entry.active);
      const activeRecord = activeDocument?.relativePath ? files.find(([, file]) => file.path === activeDocument.relativePath) : null;
      if (activeDocument?.relativePath && activeRecord) {
        // Sidebar list of cloud revisions; refresh when the file or the
        // cloud revision changes (throttled so polling stays cheap).
        const stamp = Date.now();
        const shouldFetch = !versionTarget
          || versionTarget.path !== activeDocument.relativePath
          || versionTarget.rev !== activeRecord[1].rev
          || stamp - (versionTarget.fetchedAt || 0) > 3000;
        if (shouldFetch) {
          versionTarget = { fileId: activeRecord[0], path: activeDocument.relativePath, rev: activeRecord[1].rev, fetchedAt: stamp };
          // Prefer the plugin's own snapshot history (old servers lack /versions).
          const storedKey = historyKey(activeRecord[0]);
          const stored = await sdk.storage.get(storedKey).catch(() => null);
          let items = [];
          let emptyText = '暂无历史';
          const remoteList = await sdk.net.request(`/sync/file/${encodeURIComponent(activeRecord[0])}/versions`).catch(() => null);
          if (remoteList?.status === 200 && Array.isArray(remoteList.data?.versions)) {
            items = remoteList.data.versions.filter((entry) => !entry.deleted).map((entry) => ({ id: `${activeRecord[0]}:${entry.rev}`, rev: entry.rev, timestamp: toTimestamp(entry.updatedAt), bytes: entry.size, restored: Boolean(entry.restoredFrom), label: formatPluginTime(entry.updatedAt), meta: formatPluginBytes(entry.size) }));
          } else if (Array.isArray(stored) && stored.length) {
            items = stored.slice().reverse().map((entry) => ({
              id: `${activeRecord[0]}:${entry.rev}`,
              rev: entry.rev,
              timestamp: toTimestamp(entry.updatedAt),
              bytes: entry.size,
              restored: Boolean(entry.restoredFrom),
              label: formatPluginTime(entry.updatedAt),
              meta: formatPluginBytes(entry.size),
            }));
          } else {
            const list = await sdk.rpc('net.request', { path: `/sync/file/${encodeURIComponent(activeRecord[0])}/versions`, method: 'GET' }).catch(() => null);
            let versions = Array.isArray(list?.data?.versions) ? list.data.versions : [];
            emptyText = !list ? '无法连接同步服务' : list.status === 200 ? '暂无历史' : `云端历史不可用（HTTP ${list.status}）`;
            if (list?.status === 404) {
              const current = await sdk.rpc('net.request', { path: `/sync/file/${encodeURIComponent(activeRecord[0])}`, method: 'GET' }).catch(() => null);
              if (current?.status === 200 && Number.isSafeInteger(current.data?.rev)) {
                versions = [{ rev: current.data.rev, checksum: current.data.checksum, size: current.data.size, updatedAt: current.data.updatedAt }];
                emptyText = '暂无历史';
              }
            }
            items = versions.map((version) => ({
              id: `${activeRecord[0]}:${version.rev}`,
              rev: version.rev,
              timestamp: toTimestamp(version.updatedAt),
              bytes: version.size,
              restored: Boolean(version.restoredFrom),
              label: formatPluginTime(version.updatedAt),
              meta: formatPluginBytes(version.size),
            }));
          }
          await sdk.versions.set({ path: activeDocument.relativePath, title: '云端历史', emptyText, items }).catch(() => {});
        }
      } else if (versionTarget) {
        const stale = versionTarget.path;
        versionTarget = null;
        await sdk.versions.remove(stale).catch(() => {});
      }
      for (const id of statusIds) if (!alive.has(id)) { await sdk.statusBar.remove(id); statusIds.delete(id); presentations.delete(id); }
      const failed = new Set([...engine.fileErrors.keys(), ...(engine.lastError ? files.map(([, file]) => file.path) : [])]);
      if (failed.size) await sdk.fileBadges.set('cloud-error', { paths: [...failed], svg: BADGES.error, title: '同步失败，等待重试' });
      else await sdk.fileBadges.remove('cloud-error');
      if (conflicts.length) await sdk.fileBadges.set('cloud-conflict', { paths: conflicts.map(([, record]) => record.path), svg: BADGES.warning, title: '同步冲突' });
      else await sdk.fileBadges.remove('cloud-conflict');
      await sdk.fileBadges.set('cloud-ok', { paths: files.filter(([, file]) => !failed.has(file.path) && !conflicts.some(([, conflict]) => conflict.path === file.path)).map(([, file]) => file.path), svg: BADGES.success, title: '已同步' });
    } finally { publishing = false; if (again) { again = false; schedule(); } }
  };
  const schedule = () => { if (scheduled || sdk.signal.aborted) return; scheduled = setTimeout(() => { scheduled = null; void publish().catch(console.error); }, 32); };
  engine = new IncrementalSync(sdk.rpc, schedule, { onSynced: recordSnapshot });
  sdk.onDispose(() => { engine.stop(); clearInterval(timer); clearTimeout(scheduled); });
  await sdk.commands.register('sync.now', '立即同步', () => engine.cycle());
  // Show the cloud revisions of the currently open file (cloud files only).


  sdk.on('versionRefresh', () => {
    if (versionTarget) versionTarget.fetchedAt = 0;
    schedule();
  });
  sdk.on('versionSelected', async (payload) => {
    if (!versionTarget || !Number.isSafeInteger(payload?.rev)) return;
    const target = { ...versionTarget };
    const detail = await sdk.net.request(`/sync/file/${encodeURIComponent(target.fileId)}/versions/${payload.rev}`).catch(() => null);
    let content;
    if (detail?.status === 200 && detail.data?.rev === payload.rev && typeof detail.data.content === 'string') content = await decodeDocument(detail.data);
    else {
      // Compatibility fallback contains the requested snapshot, never the head.
      const stored = await sdk.storage.get(historyKey(target.fileId)).catch(() => null);
      const cached = Array.isArray(stored) ? stored.find(entry => entry.rev === payload.rev) : null;
      if (typeof cached?.content !== 'string' || await sha256(cached.content) !== cached.checksum) throw new Error('云端历史版本读取失败，请重试或升级服务端');
      content = cached.content;
    }
    await sdk.editor.showDiff({ path: target.path, content, label: `云端历史 rev ${payload.rev}`, actionLabel: '使用此版本', applyIcon: 'cloud-download', rev: payload.rev, timestamp: Number.isFinite(payload?.timestamp) ? payload.timestamp : undefined });
  });
  await sdk.commands.register('sync.remote', '查看当前文件云端版本', async (args) => {
    const active = args?.path ? null : await sdk.rpc('editor.getActiveDocument').catch(() => null);
    const targetPath = args?.path || active?.path;
    if (!targetPath) return;
    const normalize = (value) => String(value || '').replace(/\\/g, '/');
    const record = Object.entries(engine.state?.files || {}).find(([, file]) => file.path && (
      normalize(file.path) === normalize(targetPath)
      || normalize(targetPath).endsWith('/' + normalize(file.path))
      || normalize(file.path).endsWith('/' + normalize(targetPath))
    ));
    if (!record) {
      await sdk.tasks.set('sync-remote', { title: '云端历史', status: '当前文件不是云文件', tone: 'info', command: 'sync.remote' }).catch(() => {});
      return;
    }
    const [fileId] = record;
    const list = await sdk.rpc('net.request', { path: `/sync/file/${encodeURIComponent(fileId)}/versions`, method: 'GET' }).catch(() => null);
    const versions = Array.isArray(list?.data?.versions) ? list.data.versions : [];
    const items = [];
    for (const version of versions.slice(0, 20)) {
      const detail = await sdk.rpc('net.request', { path: `/sync/file/${encodeURIComponent(fileId)}/versions/${version.rev}`, method: 'GET' }).catch(() => null);
      if (detail?.status !== 200 || typeof detail.data?.content !== 'string') continue;
      items.push({
        id: `${fileId}:${version.rev}`,
        rev: version.rev,
        label: `云端历史 rev ${version.rev}`,
        meta: new Date(version.updatedAt || Date.now()).toLocaleString(),
        content: await decodeDocument(detail.data),
        actionLabel: '使用此版本',
        applyIcon: 'cloud-download',
      });
    }
    await sdk.rpc('editor.showVersions', {
      path: targetPath,
      title: `云端历史 · ${String(targetPath).split(/[\\/]/).pop()}`,
      items,
    }).catch(() => {});
  });
  await sdk.commands.register('sync.handle', '处理当前文件差异', async (args) => {
    if (!engine.state) return;
    const documents = await sdk.editor.listDocuments();
    const document = args?.documentId ? documents.find((entry) => entry.id === args.documentId) : documents.find((entry) => entry.active);
    if (!document?.relativePath) return;
    const entry = Object.entries(engine.state.conflicts).find(([, conflict]) => conflict.path === document.relativePath);
    if (!entry) return;
    const response = await sdk.net.request(`/sync/file/${encodeURIComponent(entry[0])}`);
    if (response.status !== 200) throw new Error(response.data.message || `HTTP ${response.status}`);
    const remote = response.data;
    const content = remote.deleted ? '' : await decodeDocument(remote);
    await sdk.editor.showDiff({ path: document.path, content, label: `同步差异：${document.name}`, rev: remote.rev, actions: [
      { id: 'use.local', title: '使用本地', command: 'sync.resolve', args: { fileId: entry[0], choice: 'local', remoteRev: remote.rev } },
      { id: 'use.remote', title: '使用云端', command: 'sync.resolve', args: { fileId: entry[0], choice: 'remote', remoteRev: remote.rev } },
      { id: 'use.edits', title: '应用修改', command: 'sync.resolve', args: { fileId: entry[0], choice: 'merged', remoteRev: remote.rev } },
    ] });
  });
  await sdk.commands.register('sync.resolve', '解决当前文件冲突', async (args) => {
    if (!args?.document || !['local','remote','merged'].includes(args.choice)) throw new Error('无效的冲突操作');
    // A cycle can be busy with a large pull; wait briefly, then preempt it.
    const deadline = Date.now() + 15000;
    while (engine.running && !sdk.signal.aborted && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (engine.running) engine.cancelCycle?.();
    const grace = Date.now() + 5000;
    while (engine.running && !sdk.signal.aborted && Date.now() < grace) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (engine.running) throw new Error('Sync is still running');
    await engine.resolve(args.fileId, args.choice, { expectedHash: args.document.checksum, expectedRemoteRev: args.remoteRev, content: args.draftContent });
    await sdk.editor.reloadDocument(args.document.id);
    await publish();
    return { resolved: true };
  });
  sdk.editor.onDidChangeDocuments(schedule);
  sdk.editor.onDidSave(() => engine.cycle());
  timer = setInterval(() => engine.cycle(), 20000);
  await engine.cycle();
  await publish();
});
