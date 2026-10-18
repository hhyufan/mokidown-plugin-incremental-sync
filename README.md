# MokiDown 增量同步插件

把已保存的文档增量同步到**你自己的服务器和数据库**，无需注册登录。

- 插件 ID：`mokidown.incremental-sync`
- 版本：`1.0.0`
- 必需权限：`workspace.read`、`workspace.write`、`storage`、`network`
- 支持文件：`.md`、`.markdown`、`.txt`

## 安装

在 MokiDown 桌面端「设置 → 插件 → 添加插件服务」，填入本仓库 Release 的插件包地址：

```
https://github.com/hhyufan/mokidown-plugin-incremental-sync/releases/download/v1.0.0/mokidown.incremental-sync-1.0.0.mokiplugin.json
```

或直接使用内置版本（客户端已附带 `bundledUrl`）。

## 配置

安装后在插件详情里填写：

| 项 | 说明 |
| --- | --- |
| `endpoint` | 你的同步服务器地址（实现 `/capabilities`、`/sync/file/:id`、`/sync/changes`） |
| `credential` | 可选的访问令牌，随请求以 Bearer 发送 |
| 工作区 | 选择要同步的本地目录 |

## 服务器 API

插件按以下约定访问你的服务器（见 `mokidown.incremental-sync-1.0.0.mokiplugin.json` 内脚本）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/capabilities` | 握手，返回服务器能力 |
| `PUT` | `/sync/file/:fileId` | 上传/更新文档（JSON：content、checksum、size、baseRev 等） |
| `GET` | `/sync/file/:fileId` | 下载文档 |
| `GET` | `/sync/changes?cursor=&limit=` | 拉取增量变更 |
| `DELETE` | `/sync/file/:fileId` | 删除文档 |

## 发布

```bash
gh release create v1.0.0 mokidown.incremental-sync-1.0.0.mokiplugin.json \
  --title "Incremental Sync v1.0.0" --notes "首个版本"
```
