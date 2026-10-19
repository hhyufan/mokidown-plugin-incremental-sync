# MokiDown 独立插件 API 服务

一个部署包，一份 JSON 配置。无需 Vercel、官方账号、注册、登录、前端服务器或 NestJS。服务端可以单独运行；MokiDown 只通过安装的服务插件对接它。

默认启用 `cloud-sync`，也可配置 `plugins: []` 关闭路由。插件宿主负责鉴权、配置、请求限制和数据库；插件只实现业务 API。数据存入用户自己的数据库。

## Linux 快速部署（推荐 Docker）

需要 Docker Engine 和 Docker Compose 插件。下载 GitHub Release 中的 `mokidown-plugin-server-1.8.0.tar.gz`，解压后执行：

```sh
mkdir -p mokidown-sync
tar -xzf mokidown-plugin-server-1.8.0.tar.gz -C mokidown-sync
cd mokidown-sync
sh deploy.sh
```

向导默认选择 SQLite，无需额外安装数据库。向导会生成随机访问密钥，请复制并保管。随后自动检查数据库建表、读写和并发更新权限，再启动服务。

默认只映射宿主机 `127.0.0.1:8787`。把 `deploy/nginx.conf` 加入已有 HTTPS 站点；该示例使用 `/mokidown` 前缀，向导中 API base path 也填 `/mokidown`。健康检查自动读取此前缀。根路径部署则省略此前缀。

MokiDown 中打开 **设置 → 语言服务 → 服务插件**，找到官方内置的增量同步服务，点击“配置”，填写 `https://您的域名/mokidown`、访问密钥，选择本地目录后启用。无需登录或填写 GitHub 清单。第二台设备使用同一地址和密钥，选择自己的目录即可。

Windows Docker 部署可运行 `./deploy.ps1`；镜像支持 Linux x86_64 和 ARM64（基础镜像随宿主架构构建）。SQL Server 等外部数据库自身的架构限制仍由数据库供应商决定。

## 不使用 Docker

安装 Node.js 22.13+（建议使用 Node 22 的最新修订版），在解压目录执行：

```sh
npm ci --omit=dev
npm run setup
npm run check:database
npm start
```

SQLite 使用 Node 内置驱动，不需要 Python、编译器或本机数据库依赖。服务默认监听 `127.0.0.1:8787`，可由配置或 `HOST`、`PORT` 环境变量修改。Node 22 会提示 SQLite 实验性状态，这是运行时提示，不代表连接失败。

Linux 常驻服务示例为 `deploy/mokidown-sync.service`：将程序放到 `/opt/mokidown-sync`，创建 `mokidown` 系统用户并把配置及 `data/` 授权给该用户，确认 `/usr/bin/node` 是 Node 22.13+，再安装该 unit。自定义数据库文件目录时同步修改 `ReadWritePaths`。

## 修改配置、运维与备份

本机部署编辑 `config.json` 并重启即可。数据库文件路径相对配置文件所在目录，不受启动工作目录影响。修改数据库连接不会自动迁移旧库的数据；切换空库前应备份旧库并使用新的 `instanceId`，避免旧 cursor 对应到另一份数据。

Docker 配置和 SQLite 数据保存在 `sync_state` 持久卷。重新运行向导可修改数据库，保留原 `instanceId`、访问密钥和数据空间：

```sh
docker compose stop sync
docker compose run --rm --no-deps sync npm run setup
docker compose run --rm --no-deps sync npm run check:database
docker compose up -d
docker compose logs --tail=100 sync
```

高级编辑可先导出配置：`docker compose cp sync:/app/state/config.json ./config.json`，编辑后 `docker compose cp ./config.json sync:/app/state/config.json`，然后重启。配置含密钥和数据库密码，不要提交 Git。更换 SQLite 为其他数据库不需要修改客户端。

备份 SQLite 时先停止服务，再备份整个持久卷（包括 SQLite WAL 文件），或使用 SQLite 的在线备份工具。其他数据库使用其原生一致性备份。恢复时保留 `instanceId`，否则客户端会视为新服务。不要仅复制运行中的主 `.sqlite` 文件。

`GET /healthz` 是无密钥存活检查；`GET /readyz` 使用 Bearer 密钥并验证数据库可读。设定 basePath 后均需要带此前缀。接口异常返回 requestId，日志不打印数据库连接串和访问密钥。

## 数据库支持

数据库必须已存在；服务自动创建 `mokidown_state` 表或集合，不创建数据库，也不修改已有业务表。数据库用户需要该专用库的建表、读、插入和更新权限。

| type | 配置示例 | 驱动 |
| --- | --- | --- |
| `sqlite` | `"filename": "data/sync.sqlite"` | Node 内置 SQLite |
| `postgres` | `"url": "postgresql://user:password@host:5432/mokidown"` | pg |
| `mysql` | `"url": "mysql://user:password@host:3306/mokidown"` | mysql2 |
| `mariadb` | `"url": "mysql://user:password@host:3306/mokidown"` | mysql2 |
| `mongodb` | `"url": "mongodb://user:password@host:27017/mokidown?authSource=admin"` | mongodb |
| `mssql` | `"url": "Server=host,1433;Database=mokidown;User Id=user;Password=password;Encrypt=true"` | mssql |

Docker 中的 `localhost` 指容器自身；连接宿主数据库需要实际可达地址。Linux Docker 如需使用 `host.docker.internal`，在 Compose 加入 `extra_hosts: ["host.docker.internal:host-gateway"]`，同时允许数据库从 Docker 网段访问。

PostgreSQL/MySQL 的 TLS 可在 `database.tls` 中配置，例如 `{"rejectUnauthorized":true,"ca":"PEM证书内容"}`；MongoDB 使用连接 URL 的 `tls=true` 等参数。SQL Server 可以用结构化配置，避免 URI 转义和证书选项歧义：

```json
{
  "type": "mssql",
  "connection": {
    "server": "db.example.com",
    "port": 1433,
    "database": "mokidown",
    "user": "mokidown",
    "password": "替换为数据库密码",
    "options": { "encrypt": true, "trustServerCertificate": false }
  }
}
```

环境变量覆盖顺序：`MOKIDOWN_CONFIG` 选择配置路径，`HOST/PORT` 覆盖监听地址，`DATABASE_TYPE/DATABASE_URL` 覆盖对应数据库设置。数据库密码中的特殊字符需 URL 编码（SQL Server ADO 字符串按其格式转义）。

当前适配采用每数据空间一条 JSON 状态记录，使用数据库原子 compare-and-swap 同时提交正文、cursor、删除墓碑和幂等回执，适合个人或小团队。SQLite 仅单实例本机部署，不能共享到 NFS；其他数据库支持多个 API 实例连接同一库，但首次建表应串行启动。

关系库默认每数据空间 64 MiB 状态上限；MongoDB 默认 12 MiB，给其单文档限制保留余量。可用 `database.maxStateBytes` 调整关系库上限；MongoDB 不要超过 12 MiB。状态包含正文和历史操作回执，达到上限返回 413，不会丢弃回执或自动清理墓碑。大型知识库需要进一步拆分存储适配器，此版本没有声称完成大型部署优化。

## 密钥与数据空间

```json
"accessKeys": [
  { "key": "由 setup 生成的至少 32 字符随机密钥", "namespace": "personal" },
  { "key": "另一把独立随机密钥", "namespace": "team" }
]
```

密钥相当于此数据空间的读写权限，不是用户账号。多把密钥也可以映射同一 namespace，以便分批轮换。变更后重启；客户端更新密钥即可，不需要登录或注册。namespace 使用英文字母、数字、下划线和短横线。`instanceId` 是服务数据身份，正常升级时保持稳定。

浏览器直接访问 API 时，在 `corsOrigins` 加入精确来源；不要设为 `*`。桌面插件通过通用原生 HTTP 接口对接，不受浏览器 CORS 影响。部署公网服务应放在 HTTPS 代理后，代理可配置自己的限流。

## 开发与对接

- [REST 对接协议](docs/API.md)：稳定请求示例、cursor、冲突、重试与错误码。
- [OpenAPI 3.1](docs/openapi.json)：可导入 Postman、Apifox 或 Swagger Editor。
- [插件包及宿主接口](../../plugins/README.md)：GitHub 分发与通用插件对接。
- `npm test`：SQLite、HTTP 协议及并发测试。
- `TEST_DATABASE_CONFIG` 设置为数据库配置 JSON 后运行测试，可对实际外部数据库验证 CAS。GitHub Actions 提供五类外部数据库的 Linux 集成任务。

驱动接口依据官方文档实现：[Node SQLite](https://nodejs.org/api/sqlite.html)、[PostgreSQL 参数化查询](https://node-postgres.com/features/queries)、[MySQL2](https://sidorares.github.io/node-mysql2/docs/documentation)、[MongoDB 原子更新](https://www.mongodb.com/docs/drivers/node/current/crud/update/)。发布前请查看对应 CI 结果，不能将“适配器已实现”当作“已在您的数据库环境验收”。

本机、局域网、Cloudflare 代理和自建反代：[网络部署指南](docs/NETWORK.md)。
## 从旧 JSON 服务迁移

先停止所有写入同一 documents.json 的旧进程，再执行：

```sh
npm run migrate:legacy -- /path/to/old/data
```

工具先校验正文哈希与大小，再备份原 JSON，并一次性导入同目录的 sync-v3.sqlite。再次执行不会覆盖已迁移数据。保留文件 ID、文件版本和全局游标，并恢复可识别 PUT 操作的幂等记录。旧服务已经物理删除且未保留的记录无法重建。

将 config.json 的 database.type 设为 sqlite、database.filename 设为工具输出的路径。原示例服务的 instanceId 为 mokidown-sync-local、namespace 为 default；保留原值和访问密钥，避免客户端重新建立状态。不要让旧服务继续写原 JSON；升级后的服务统一使用 SQLite。重复路径的旧记录保留为冲突，需在插件面板确认，不自动丢弃。

## 历史与并发（1.8.0）

`GET /sync/file/:id/versions` 列出不可变快照，`GET /sync/file/:id/versions/:rev` 读取指定快照。每次写入将历史、当前文件、序列与幂等回执一同提交；数据库配额失败时全部保持原状。过期 baseRev 返回 409 REV_CONFLICT，同路径首次并发创建返回 409 PATH_CONFLICT。恢复相同 mutationId 不重复生成历史。
