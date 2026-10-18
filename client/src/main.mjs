import { definePlugin } from '@mokidown/sdk';
import { IncrementalSync, decodeDocument, sha256 } from './engine.mjs';

const cloud = (color) => `<svg viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2"><path d="M7 18h10a4 4 0 0 0 .6-7.96A6 6 0 0 0 6.2 9.2 4.5 4.5 0 0 0 7 18Z"/></svg>`;
const check = (color) => `<svg viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
const cross = (color) => `<svg viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2.4" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>`;
const warningTriangle = (color) => `<svg viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;
// Status icons are the plugin's choice: check = synced, triangle = conflicts, cross = failure.
const ICONS = { success: check('#3fb950'), warning: warningTriangle('#d29922'), error: cross('#f85149'), info: cloud('currentColor') };
// File-list badges keep the cloud, colored by state.
const BADGES = { success: cloud('#3fb950'), warning: cloud('#d29922'), error: cloud('#f85149') };

definePlugin(async (sdk) => {
  let engine, timer, scheduled, publishing = false, again = false, versionTarget = null;
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
        if (!conflict && !record && engine.activePath !== path) continue;
        const id = `document.${(await sha256(`${document.id}:${path}`)).slice(0, 32)}`;
        alive.add(id);
        const resolved = engine.state.resolutions?.[path];
        const error = engine.fileErrors.get(path);
        const busy = engine.running || engine.activePath === path;
        const completed = record && resolved?.fileId === record[0] && resolved.rev === record[1].rev && resolved.checksum === record[1].checksum;
        const text = busy ? '同步中…' : error ? '同步失败' : conflict ? '存在冲突' : '同步完成';
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
        const id = 'sync.versions';
        alive.add(id);
        const item = {
          text: '云端历史',
          title: `${activeDocument.name} · 查看云端版本`,
          icon: ICONS.info,
          tone: 'info',
          command: 'sync.remote',
          args: { path: activeDocument.relativePath },
        };
        const key = JSON.stringify(item);
        if (presentations.get(id) !== key) { await sdk.statusBar.set(id, item); presentations.set(id, key); }
        statusIds.add(id);
        // Sidebar list of cloud revisions; refresh when the file or the
        // cloud revision changes (throttled so polling stays cheap).
        const stamp = Date.now();
        const shouldFetch = !versionTarget
          || versionTarget.path !== activeDocument.relativePath
          || versionTarget.rev !== activeRecord[1].rev
          || stamp - (versionTarget.fetchedAt || 0) > 3000;
        if (shouldFetch) {
          versionTarget = {
            fileId: activeRecord[0],
            path: activeDocument.relativePath,
            rev: activeRecord[1].rev,
            fetchedAt: stamp,
          };
          const list = await sdk.rpc('net.request', { path: `/sync/file/${encodeURIComponent(activeRecord[0])}/versions`, method: 'GET' }).catch(() => null);
          const versions = Array.isArray(list?.data?.versions) ? list.data.versions : [];
          await sdk.versions.set({
            path: activeDocument.relativePath,
            title: '云端历史',
            items: versions.map((version) => ({
              id: `${activeRecord[0]}:${version.rev}`,
              label: `rev ${version.rev}`,
              meta: new Date(version.updatedAt || Date.now()).toLocaleString(),
              rev: version.rev,
            })),
          }).catch(() => {});
        }
      } else if (versionTarget) {
        const stale = versionTarget.path;
        versionTarget = null;
        await sdk.versions.remove(stale).catch(() => {});
      }
      for (const id of statusIds) if (!alive.has(id)) { await sdk.statusBar.remove(id); statusIds.delete(id); presentations.delete(id); }
      if (conflicts.length) await sdk.fileBadges.set('cloud-conflict', { paths: conflicts.map(([, record]) => record.path), svg: BADGES.warning, title: '同步冲突' });
      else await sdk.fileBadges.remove('cloud-conflict');
      await sdk.fileBadges.set('cloud-ok', { paths: files.filter(([, file]) => !conflicts.some(([, conflict]) => conflict.path === file.path)).map(([, file]) => file.path), svg: BADGES.success, title: '已同步' });
    } finally { publishing = false; if (again) { again = false; schedule(); } }
  };
  const schedule = () => { if (scheduled || sdk.signal.aborted) return; scheduled = setTimeout(() => { scheduled = null; void publish().catch(console.error); }, 32); };
  engine = new IncrementalSync(sdk.rpc, schedule);
  sdk.onDispose(() => { engine.stop(); clearInterval(timer); clearTimeout(scheduled); });
  await sdk.commands.register('sync.now', '立即同步', () => engine.cycle());
  // Show the cloud revisions of the currently open file (cloud files only).


  sdk.on('versionRefresh', () => {
    if (versionTarget) versionTarget.fetchedAt = 0;
    schedule();
  });
  sdk.on('versionSelected', async (payload) => {
    if (!versionTarget || !Number.isSafeInteger(payload?.rev)) return;
    const detail = await sdk.rpc('net.request', { path: `/sync/file/${encodeURIComponent(versionTarget.fileId)}/versions/${payload.rev}`, method: 'GET' }).catch(() => null);
    if (detail?.status !== 200 || typeof detail.data?.content !== 'string') return;
    await sdk.rpc('editor.showDiff', {
      path: versionTarget.path,
      content: detail.data.content,
      label: `云端历史 rev ${payload.rev}`,
      actionLabel: '使用此版本',
      applyIcon: 'cloud-download',
      rev: payload.rev,
    }).catch(() => {});
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
        content: detail.data.content,
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
    while (engine.running && !sdk.signal.aborted) await new Promise((resolve) => setTimeout(resolve, 50));
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
