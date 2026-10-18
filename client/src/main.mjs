import { definePlugin } from '@mokidown/sdk';
import { IncrementalSync } from './engine.mjs';

const CLOUD_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 18h10a4 4 0 0 0 .6-7.96A6 6 0 0 0 6.2 9.2 4.5 4.5 0 0 0 7 18Z"/></svg>';

definePlugin(async (sdk) => {
  let update = { phase: '就绪' }, offset = 0, resolving = false;
  let engine;
  const publish = () => {
    const conflicts = Object.entries(engine?.state?.conflicts || update.state?.conflicts || {});
    const busy = resolving || engine?.running === true && !update.error && !['已完成增量同步', '冲突已处理'].includes(update.phase);
    if (offset >= conflicts.length) offset = 0;
    const actions = [{ id: 'sync.now', title: '立即同步', command: 'sync.now', disabled: busy }];
    for (const [index, [fileId, conflict]] of conflicts.slice(offset, offset + 100).entries()) {
      const group = conflict.path.length > 240 ? `…${conflict.path.slice(-239)}` : conflict.path;
      actions.push(
        { id: `conflict.${index}.local`, title: '保留本地', group, command: 'sync.resolve', args: { fileId, choice: 'local' }, disabled: busy },
        { id: `conflict.${index}.remote`, title: '采用远端', group, command: 'sync.resolve', args: { fileId, choice: 'remote' }, disabled: busy },
      );
    }
    if (conflicts.length > 100) actions.push({ id: 'conflicts.next', title: `更多冲突（${Math.floor(offset / 100) + 1}/${Math.ceil(conflicts.length / 100)}）`, command: 'sync.conflicts.next', disabled: busy });
    const text = update.error
      ? '同步错误'
      : conflicts.length
        ? `同步冲突 ${conflicts.length}`
        : update.phase === '就绪'
          ? '空闲'
          : /已完成|冲突已处理|无变化/.test(String(update.phase))
            ? '已同步'
            : '同步中...';
    const tone = update.error ? 'error' : conflicts.length ? 'warning' : text === '已同步' ? 'success' : 'info';
    void sdk.tasks.set('sync-pending', {
      title: '同步待处理',
      status: conflicts.length ? `${conflicts.length} 个文件有云端版本` : '点击处理同步',
      tone: 'warning',
      command: 'sync.now',
    }).catch(() => {});
    return sdk.statusBar.set('sync.status', { text, title: `${update.phase}`, icon: CLOUD_ICON, tone, busy }).catch(() => {});
  };
  engine = new IncrementalSync(sdk.rpc, (next) => { update = next; void publish(); });
  sdk.onDispose(() => engine.stop());
  await sdk.commands.register('sync.now', 'MokiDown：立即同步', () => engine.cycle());
  await sdk.commands.register('sync.conflicts.next', 'MokiDown：更多同步冲突', () => { offset += 100; return publish(); });
  await sdk.commands.register('sync.resolve', 'MokiDown：处理同步冲突', async (args) => {
    if (!args || !['local', 'remote'].includes(args.choice) || !engine.state?.conflicts[args.fileId]) return;
    resolving = true;
    update = { phase: '处理冲突中…', state: engine.state }; void publish();
    try { await engine.resolve(args.fileId, args.choice); }
    catch (error) { update = { phase: error.message, error: true, state: engine.state }; }
    finally { resolving = false; }
    await publish();
  });
  await sdk.fileBadges.set('cloud-sync', { extensions: ['md', 'markdown', 'txt'], svg: CLOUD_ICON, title: '云端同步' });
  sdk.editor.onDidSave(() => engine.cycle());
  await publish();
  const timer = setInterval(() => engine.cycle(), 20000);
  sdk.onDispose(() => clearInterval(timer));
  await engine.cycle();
});
