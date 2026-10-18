# 归档：云同步（Cloud Sync）

这里保存的是 MokiDown 曾经的云同步实现，**已从主项目移除**，不再参与构建，
仅用于日后参考或作为独立开源的素材。

## 为什么归档

- 云同步依赖自托管服务端 `mde-server`（NestJS + MongoDB，部署在 Vercel），
  长期维护与托管成本高；
- 产品定位回归「本地优先」：MokiDown 默认读写本地文件，无需登录、无需联网；
- 相关 UI（登录、云同步设置页、同步状态指示器）也一并从主界面移除。

## 归档内容

| 路径 | 说明 |
| --- | --- |
| `services/syncEngine.js` | 同步引擎：对比本地/云端清单、上传下载、冲突检测 |
| `services/sync/*` | 传输层、变更协议、内容编码、重试策略、展示辅助 |
| `services/apiClient.js` | 服务端 REST 客户端（登录 / 同步接口） |
| `store/useSyncStore.js` | 同步状态（阶段、错误、进度） |
| `utils/settingsSync.js` | 设置项同步 |
| `components/ui/SyncStatusIndicator.jsx` | 底栏同步状态 |
| `components/ui/UserMenu.jsx` | 登录 / 账户菜单 |
| `*.test.*` | 对应单元测试，可直接运行参考 |

## 服务端

服务端代码在独立仓库 [`hhyufan/mde-server`](https://github.com/hhyufan/mde-server)，
API 约定（`/auth/*`、`/sync/manifest`、`/sync/file` 等）见该仓库 README。
如需恢复云同步，可把这里的模块接回 `src/services`、`src/store` 并重新接入 UI。

## 许可

与本项目一致（见仓库根目录 `LICENSE`）。
