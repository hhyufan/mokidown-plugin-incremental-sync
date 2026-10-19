# MokiDown 增量同步插件与服务

插件独立于编辑器，默认关闭。启用后将已保存的 Markdown / 文本文件同步到自建服务，无需账号。插件只通过 SDK 注入状态、文件图标、历史列表与差异操作；编辑器不实现同步策略。

## 启动、停止和状态

需要 Node.js 22.13 或更新版本，支持 Windows、Linux、macOS。

```sh
npx github:hhyufan/mokidown-plugin-incremental-sync start
npx github:hhyufan/mokidown-plugin-incremental-sync status
npx github:hhyufan/mokidown-plugin-incremental-sync stop
```

`start` 默认在后台运行，命令返回后可以关闭终端。省略子命令也会后台启动。`stop` 同时关闭服务、内置代理和隧道；`status` 显示运行状态、PID、当前地址和日志位置。重复启动复用现有实例。`run` 保留前台模式，供 Docker / systemd 管理。

单文件部署：从 [v1.8.0 Release](https://github.com/hhyufan/mokidown-plugin-incremental-sync/releases/tag/v1.8.0) 下载 `standalone.mjs`，放在固定目录：

```sh
node standalone.mjs start
node standalone.mjs status
node standalone.mjs stop
```

单文件包由同一套服务端代码生成，包含后台管理、版本校验、SQLite 存储与历史 API，不再维护第二套同步实现。兼容 `--status` / `--stop` 写法。

启动时输出的 `Endpoint` 和 `Credential` 填入「语言服务 → 服务插件 → MokiDown 增量同步服务」，再选择授权目录。`status` 不输出密钥，密钥保存在下面的数据目录中。

### 本机、局域网和反向代理

```sh
# 本机办公，不开公网隧道
node standalone.mjs start --no-tunnel

# 局域网办公，插件填写 http://服务器内网IP:4320
node standalone.mjs start --no-tunnel --host 0.0.0.0

# 自定义端口；只对外开放代理端口
node standalone.mjs start --no-tunnel --port 4319 --proxy-port 4320
```

默认服务监听 `127.0.0.1:4319`，代理监听 `127.0.0.1:4320`。`--host` 仅修改代理监听地址，服务本身保留回环监听。默认不传 `--no-tunnel` 时会下载 cloudflared 并创建临时公网 HTTPS 隧道；每次启动隧道地址可能变化，用 `status` 查看当前地址。

用户自建 Nginx / Caddy 时，将自己的 HTTPS 地址转发到本机 `http://127.0.0.1:4320`，保留 `Authorization` 请求头。插件在 LAN、隧道和自建反代下都使用相同访问密钥。

```nginx
location / {
    proxy_pass http://127.0.0.1:4320;
    proxy_set_header Host $host;
    proxy_set_header Authorization $http_authorization;
}
```

### 数据与升级

默认目录 `~/.mokidown-sync`：

| 文件 | 用途 |
| --- | --- |
| `data/sync-v3.sqlite` | SQLite 数据库，保存最新内容、每个版本的快照、增量序列和幂等回执 |
| `token` | 访问密钥 |
| `service.log` | 后台服务日志 |
| `service.json` | 本机后台服务控制信息，仅供管理命令使用 |

设置 `MOKIDOWN_SYNC_HOME` 可运行独立实例；同一实例执行 start / stop / status 时必须使用同一个目录。`DATA_DIR` 可单独指定数据库目录。`--token` 或 `SYNC_TOKEN` 可指定并保存访问密钥。

升级前先停止旧服务。旧的前台版本需要在原终端按 Ctrl+C，旧 Docker 用 `docker compose down`；新管理命令只停止自己管理的实例。替换单文件包或更新仓库后重新启动，不要删除数据目录。旧 `documents.json` 保留并备份，首次启动导入 SQLite，已存在的有效历史也会补入；已被旧服务覆盖、没有留存的历史无法重建。插件与服务端均建议升级到 1.8.0。

## 冲突、失败与历史

每次修改带 `baseRev` 和稳定的 `mutationId`。服务端事务内校验版本，过期修改返回 `409 REV_CONFLICT`；不同设备首次上传同路径返回 `409 PATH_CONFLICT`。重试同一 mutation 不生成重复版本。双端都改动时保留本地文件，用户通过插件注入的「使用本地 / 使用云端 / 应用修改」处理。操作成功且得到回执后才清除冲突；本地或云端版本再次变化则要求重新比较。

历史快照与当前版本在同一数据库事务中追加提交，后续版本不会覆盖上一条。历史读取与对比使用指定 rev，不能用当前内容替代旧版本。压缩内容会解压并验证校验和。

网络或服务处理失败时保留本地内容和待重试操作，撤销绿色成功标记，文件列表显示失败状态；已打开文件的状态栏显示红色云朵。成功重试后恢复状态。

## API 对接

所有业务接口需要 `Authorization: Bearer <访问密钥>`；写请求使用 `Content-Type: application/json`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/capabilities` | 服务标识、命名空间、实例与协议 v3 |
| GET | `/sync/changes?cursor=&limit=25` | `changes`、`nextCursor`、`hasMore`；游标为字符串 |
| PUT | `/sync/file/:id` | `content`、`compressed`、`size`、`checksum`、`fileName`、`baseRev`、`mutationId` |
| GET | `/sync/file/:id` | 当前完整快照 |
| DELETE | `/sync/file/:id` | 带 `baseRev` 与 `mutationId` 的删除，保留墓碑与历史 |
| GET | `/sync/file/:id/versions` | `{ versions: [...] }`，按 rev 降序，不返回内容 |
| GET | `/sync/file/:id/versions/:rev` | 指定版本的完整快照，缺失返回 404 |

`checksum` 是解压后 UTF-8 内容的 SHA-256；`size` 为对应字节数；`compressed=true` 时 content 为 gzip 的 Base64。409 冲突不能当作成功；503 / 连接断开时保留原 mutation 重试。存储配额不足返回 413，不会部分提交当前版本或历史。

内置部署默认使用 SQLite，不需要额外数据库进程。需要 PostgreSQL、MySQL/MariaDB、MongoDB 或 SQL Server 时，使用 [可配置服务部署包](services/sync-server/README.md)，沿用相同协议和事务规则。[插件 SDK 文档](SDK.md) 说明编辑器注入能力。

## Docker

在 `.env` 设置 `SYNC_TOKEN` 后执行 `docker compose up -d`，`docker compose ps` 查看状态，`docker compose down` 停止。数据放在持久化卷中，默认只把代理映射到宿主机回环端口，可交给自己的反代。

## 开发验证

```sh
npm ci
npm test
npm run build:plugin
```

`npm test` 先从可配置服务源码同步 runtime 并构建单文件包，再验证冲突、历史、重试、状态注入以及后台服务的启动 / 重复启动 / 停止 / 重启持久化。新插件包位于 `releases/service-plugins`，版本和校验和随包生成。
