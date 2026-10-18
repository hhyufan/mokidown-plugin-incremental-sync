## 一条命令部署（推荐）

```bash
npx github:hhyufan/mokidown-plugin-incremental-sync
```

它会自动：

1. 生成/复用访问密钥（`~/.mokidown-sync/token`）；
2. 启动同步服务与内置代理（本机回环）；
3. 按需下载 `cloudflared` 并开一条公网隧道；
4. 打印可填进插件的 `endpoint` 与 `credential`：

```
MokiDown sync server is running
  Endpoint : https://xxxx.trycloudflare.com
  Token    : 0f3c...

Fill these in Settings → Plugins → Incremental Sync:
  endpoint  = https://xxxx.trycloudflare.com
  credential= 0f3c...
```

按 `Ctrl+C` 停止并关闭隧道。可选参数：`--port`、`--proxy-port`、`--token`、`--no-tunnel`。
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

## 自建同步服务端（可选）

仓库附带一个零依赖的参考实现，跑起来就能给插件用：

```bash
# 1. 生成访问密钥
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# 2. 启动同步服务（默认 127.0.0.1:4319）
SYNC_TOKEN=<上面的密钥> node server/index.mjs

# 3. 启动反向代理（客户端连它，代理注入密钥；默认 127.0.0.1:4320）
SYNC_TOKEN=<上面的密钥> node server/proxy.mjs
```

在 MokiDown 插件配置里把 `endpoint` 填成 `http://127.0.0.1:4320` 即可。

| 环境变量 | 说明 |
| --- | --- |
| `PORT` | 同步服务端口，默认 `4319` |
| `SYNC_TOKEN` | Bearer 密钥；留空则不校验 |
| `DATA_DIR` | 文档存储目录，默认 `./.data` |
| `TARGET` | 反向代理上游，默认 `http://127.0.0.1:4319` |
| `PROXY_PORT` | 反向代理端口，默认 `4320` |

### 全链路自测

```bash
node server/smoke-test.mjs
```

会随机生成密钥、拉起服务与代理，跑 capabilities → 上传 → 变更 → 下载，并验证无密钥直连返回 401。

### 公网部署

把 `server/` 放到任意 Node 主机（VPS / Docker / systemd），前面用 Nginx 或 Caddy 做 TLS 终止，凭据走 `SYNC_TOKEN`；插件端只需填公网地址。

### 内置代理的安全限制

`server/proxy.mjs` 是插件内置的反向代理，客户端只连它：

- **固定上游**：只能转发到 `TARGET`（默认 `127.0.0.1:4319`），插件无法指定其他域名/端口；
- **路径白名单**：只有 `/capabilities` 和 `/sync/*` 会转发，其他路径直接 404；
- **密钥注入**：`SYNC_TOKEN` 由代理加到 `Authorization: Bearer`，客户端不持有密钥；
- **节流**：按客户端 IP 的令牌桶，超出返回 `429` + `Retry-After`。

| 环境变量 | 说明 |
| --- | --- |
| `PROXY_RATE_LIMIT` | 每个窗口允许的请求数，默认 `60` |
| `PROXY_RATE_WINDOW_MS` | 窗口长度（毫秒），默认 `60000` |
| `PROXY_ALLOW_PATHS` | 允许的路径前缀，默认 `/capabilities,/sync/` |

自测里会并发打 12 个请求（限流设为 5），并访问 `/api/secrets` 断言 404。

