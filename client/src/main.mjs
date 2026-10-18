import { definePlugin } from '@mokidown/sdk';
import { IncrementalSync } from './engine.mjs';

const cloud = (color) => `<svg viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2"><path d="M7 18h10a4 4 0 0 0 .6-7.96A6 6 0 0 0 6.2 9.2 4.5 4.5 0 0 0 7 18Z"/></svg>`;
const CLOUD_OK = cloud('#3fb950');
const CLOUD_CONFLICT = cloud('#d29922');
const CLOUD_ERROR = cloud('#f85149');

const normalize = (value) => String(value || '').replace(/\\/g, '/');
const matchPath = (left, right) => left === right || left.endsWith('/' + right) || right.endsWith('/' + left);

definePlugin(async (sdk) => {
  let update = { phase: '就绪' };
  let engine;

  const publish = async () => {
    const conflicts = Object.entries(engine?.state?.conflicts || update.state?.conflicts || {});
    const active = await sdk.rpc('editor.getActiveDocument').catch(() => null);
    // Status bar refers to the open document only, not every conflict.
    const activeConflicts = active?.path
      ? conflicts.filter(([, conflict]) => matchPath(normalize(active.path), normalize(conflict.path)))
      : [];
    const text = update.error
      ? '同步错误'
      : activeConflicts.length
        ? `同步冲突 ${activeConflicts.length}`
        : update.phase === '就绪'
          ? '空闲'
          : /已完成|冲突已处理|无变化/.test(String(update.phase))
            ? '已同步'
            : '同步中...';
    const tone = update.error ? 'error' : activeConflicts.length ? 'warning' : text === '已同步' ? 'success' : 'info';

    // File-list badges: red = failed, yellow = unresolved conflict, green = clean.
    if (update.error) void sdk.fileBadges.set('cloud-error', { extensions: ['md', 'markdown', 'txt'], svg: CLOUD_ERROR, title: '同步失败' }).catch(() => {});
    else void sdk.fileBadges.remove('cloud-error').catch(() => {});
    if (conflicts.length) void sdk.fileBadges.set('cloud-conflict', { paths: conflicts.map(([, conflict]) => conflict.path), svg: CLOUD_CONFLICT, title: '同步冲突未解决' }).catch(() => {});
    else void sdk.fileBadges.remove('cloud-conflict').catch(() => {});
    void sdk.fileBadges.set('cloud-ok', { extensions: ['md', 'markdown', 'txt'], svg: CLOUD_OK, title: '已同步' }).catch(() => {});

    if (engine?.state?.conflicts && Object.keys(engine.state.conflicts).length) {
      void sdk.tasks.set('sync-pending', {
        title: '同步待处理',
        status: `${Object.keys(engine.state.conflicts).length} 个文件有云端版本`,
        tone: 'warning',
        command: 'sync.handle',
      }).catch(() => {});
    } else {
      void sdk.tasks.remove('sync-pending').catch(() => {});
    }
    return sdk.statusBar.set('sync.status', { text, title: `${update.phase}`, icon: CLOUD_OK, tone, busy: engine?.running === true }).catch(() => {});
  };

  engine = new IncrementalSync(sdk.rpc, (next) => { update = next; void publish(); });
  sdk.onDispose(() => engine.stop());

  await sdk.commands.register('sync.now', 'MokiDown：立即同步', () => engine.cycle());
  await sdk.commands.register('sync.handle', 'MokiDown：处理同步差异', async () => {
    const targets = Object.entries(engine.state?.conflicts || {}).map(([fileId, conflict]) => ({ fileId, path: conflict.path }));
    if (!targets.length && engine.state?.files) {
      targets.push(...Object.entries(engine.state.files).filter(([, file]) => !file.deleted).map(([fileId, file]) => ({ fileId, path: file.path })));
    }
    for (const target of targets) {
      const response = await sdk.rpc('net.request', { path: `/sync/file/${encodeURIComponent(target.fileId)}`, method: 'GET' }).catch(() => null);
      if (!response || response.status !== 200 || typeof response.data?.content !== 'string') continue;
      await sdk.rpc('editor.showDiff', {
        path: target.path,
        content: response.data.content,
        label: `云端版本对比：${target.path}`,
        actionLabel: '应用云端版本',
        applyIcon: 'cloud-download',
        rev: response.data.rev,
      }).catch(() => {});
    }
  });
  await sdk.commands.register('sync.resolve', 'MokiDown：处理同步冲突', async (args) => {
    if (!args || !['local', 'remote'].includes(args.choice) || !engine.state?.conflicts[args.fileId]) return;
    update = { phase: '处理冲突中…', state: engine.state }; void publish();
    try { await engine.resolve(args.fileId, args.choice); }
    catch (error) { update = { phase: error.message, error: true, state: engine.state }; }
    await publish();
  });

  // Applying the cloud version from the diff view resolves the conflict remotely.
  sdk.on('diffApplied', async (payload) => {
    if (!payload?.remote || !payload.path) return;
    const entry = Object.entries(engine.state?.conflicts || {}).find(([, conflict]) => matchPath(normalize(payload.path), normalize(conflict.path)));
    if (!entry) return;
    update = { phase: '冲突已处理', state: engine.state };
    await engine.resolve(entry[0], 'remote').catch(() => {});
    await engine.cycle().catch(() => {});
    await publish();
  });

  sdk.on('diffClosed', async (payload) => {
    if (!payload?.path) return;
    const entry = Object.entries(engine.state?.conflicts || {}).find(([, conflict]) => matchPath(normalize(payload.path), normalize(conflict.path)));
    if (!entry) return;
    for (let i = 0; i < 50 && engine.running; i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
    await engine.resolve(entry[0], 'local').catch((error) => { update = { phase: error.message, error: true, state: engine.state }; });
    update = { phase: '冲突已处理', state: engine.state };
    await publish();
  });

  sdk.on('diffApplied', async (payload) => {
    if (!payload?.path) return;
    const entry = Object.entries(engine.state?.conflicts || {}).find(([, conflict]) => matchPath(normalize(payload.path), normalize(conflict.path)));
    if (!entry) return;
    for (let i = 0; i < 50 && engine.running; i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
    await engine.resolve(entry[0], 'remote').catch((error) => { update = { phase: error.message, error: true, state: engine.state }; });
    update = { phase: '冲突已处理', state: engine.state };
    await publish();
  });

  sdk.on('diffResolved', async (payload) => {
    if (!payload?.path) return;
    const entry = Object.entries(engine.state?.conflicts || {}).find(([, conflict]) => matchPath(normalize(payload.path), normalize(conflict.path)));
    if (!entry) return;
    await engine.resolve(entry[0], payload.choice === 'remote' ? 'remote' : 'local').catch(() => {});
    update = { phase: '冲突已处理', state: engine.state };
    await publish();
  });

  sdk.editor.onDidSave(() => engine.cycle());
  await publish();
  const timer = setInterval(() => engine.cycle(), 20000);
  sdk.onDispose(() => clearInterval(timer));
  await engine.cycle();
});
