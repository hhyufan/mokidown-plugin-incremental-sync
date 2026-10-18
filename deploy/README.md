# 公网部署（MokiDown 增量同步插件服务端）

目标：给插件一个 `https://sync.example.com` 的 endpoint，客户端只连它。

## 前置

- 一台 Linux VPS（1C1G 足够）、一个域名，DNS A 记录指向服务器；
- 放行 22 / 80 / 443，其余端口关闭；
- 不要在公网暴露 `4319`（同步服务只监听 loopback）。

## 方式一：一键脚本（systemd + Caddy 自动 TLS）

```bash
git clone https://github.com/hhyufan/mokidown-plugin-incremental-sync.git
cd mokidown-plugin-incremental-sync
sudo bash deploy/install.sh sync.example.com
```

脚本会：

1. 安装 Node 22 与 Caddy；
2. 创建 `mokidown-sync` 系统用户，数据目录 `/var/lib/mokidown-sync`（`chmod 700`）；
3. 生成 32 字节随机 `SYNC_TOKEN`，写入 `/etc/mokidown-sync.env`（`chmod 600`）；
4. 启动两个 systemd 服务：
   - `mokidown-sync-server`：`127.0.0.1:4319`（不对外）；
   - `mokidown-sync-proxy`：`127.0.0.1:4320`（唯一上游入口）；
5. 写 Caddy 配置（自动申请证书、限制请求体 6MB、反代到 4320）。

## 方式二：Docker

```bash
cp server/.env.example .env   # 填入 SYNC_TOKEN
docker compose up -d --build
```

`docker-compose.yml` 只把 `127.0.0.1:4320` 映射出来，前面仍需 Caddy/Nginx 做 TLS；容器内代理是唯一监听进程。

## 安全清单

| 项 | 实现 |
| --- | --- |
| 传输加密 | Caddy 自动 HTTPS（TLS 1.2+），HTTP 自动跳转 |
| 鉴权 | 插件→代理→服务的链路中，代理注入 `Authorization: Bearer SYNC_TOKEN`；服务端校验，无密钥返回 401 |
| 暴露面 | 同步服务只监听 `127.0.0.1`；公网只有 Caddy 的 80/443 |
| 路径限制 | 代理只放行 `/capabilities`、`/sync/*`，其余 404 |
| 目标限制 | 代理固定上游 `TARGET`，插件无法指定其他域名/端口 |
| 节流 | 代理令牌桶（默认 60 req/60s，可调）；Caddy 侧可再加一层 |
| 请求体 | Caddy 6MB 上限；服务端 4MiB 上限；插件端 32MiB 文档限制 |
| 凭据存储 | `SYNC_TOKEN` 仅在服务器 env 文件（600）与插件 keyring；不写日志 |
| 最小权限 | systemd `NoNewPrivileges`、`ProtectSystem=strict`、`ProtectHome`、独立用户 |
| 数据 | 单文件 JSON 持久化在 `/var/lib/mokidown-sync`，目录 700 |

## 验证

```bash
# 1. 无密钥直连服务端口（应超时/拒绝，因为只监听 loopback）
curl -m 3 http://<vps-ip>:4319/capabilities || echo "blocked (expected)"

# 2. 公网握手（不需要密钥）
curl https://sync.example.com/capabilities

# 3. 无密钥访问数据接口（应 401）
curl -i https://sync.example.com/sync/manifest

# 4. 用密钥走完整往返（把 token 换成 /etc/mokidown-sync.env 里的值）
curl -i -H "Authorization: Bearer $TOKEN" \
     -H 'Content-Type: application/json' \
     -X PUT https://sync.example.com/sync/file/demo \
     -d '{"content":"# hi","checksum":"<sha256>","baseRev":0,"mutationId":"m1"}'
```

## 客户端配置

MokiDown → 设置 → 插件 → 增量同步 → 配置：

| 项 | 值 |
| --- | --- |
| `endpoint` | `https://sync.example.com` |
| `credential` | 服务器上的 `SYNC_TOKEN`（客户端只保存到系统 keyring，代理会再次注入） |
| 工作区 | 要同步的本地目录 |

> 提示：如果客户端直连的是代理端口（4320），credential 可留空（代理已注入）；如果直连 4319 或自建其它服务，则需要填 token。

## 备份

数据在 `/var/lib/mokidown-sync/documents.json`，定时复制即可；恢复时停服务、覆盖文件、重启。
