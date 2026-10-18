# 本机、局域网与远程访问

同一套服务、数据库和访问密钥可以通过不同地址访问，无需登录官方云端。客户端只填写最终 API 根地址，不添加 /capabilities 或 /sync。

## 本机

Node.js 22.13+，Linux / Windows / macOS 均可：

```sh
npm ci --omit=dev
npm run setup -- --defaults
npm run check:database
npm start
```

默认监听 `127.0.0.1:8787`，客户端填写 `http://127.0.0.1:8787`。配置中的 accessKeys 是服务密钥，填入插件设置；不要发送给他人。SQLite 默认可用，其他数据库在 setup 中选择并提供连接字符串。

## 局域网办公

首次配置使用 `npm run setup -- --defaults --lan`，或修改 config.json 的 host 为 `0.0.0.0`；port 可自选。重新启动服务。客户端填写 `http://服务器内网IP:8787`，不能填写 0.0.0.0。操作系统防火墙只放行需要的办公网段。Docker Compose 使用环境变量 `MOKIDOWN_BIND_ADDRESS=0.0.0.0` 和可选 `MOKIDOWN_PORT=8787` 后启动；默认仅发布到回环地址。

多人共用同一个 namespace 会同步同一组文件；需要隔离时为不同密钥配置不同 namespace。局域网明文 HTTP 适合可信网络；需要加密可使用自建 HTTPS 反代。

## Cloudflare 代理

服务正常启动后，在另一个终端运行 `npm run tunnel`。该命令调用本机 cloudflared，并把当前配置端口作为上游；也可设置 CLOUDFLARED_PATH 指向可执行文件。不会自动下载程序。将日志中的 https://*.trycloudflare.com 地址填入插件。服务仍使用原来的密钥和数据库。

临时隧道重启会更换地址，不适合作为固定办公域名。长期使用请自行配置命名隧道或固定域名。客户端在同一服务的本机、内网和公网地址之间切换，仍沿用该服务实例与 namespace 的增量记录。不要重置 instanceId。

## 用户自建反代

可以直接将 Nginx/Caddy/网关反代到 `http://127.0.0.1:8787`，保留 Authorization、方法和 JSON 请求体。Nginx 示例见 deploy/nginx.conf。不要对 API 再套浏览器登录页或跳转页。子路径部署同时配置服务 basePath（例如 /moki），客户端填写 https://notes.example.com/moki。

## 排查

在插件配置点击「保存并测试连接」：401/403 表示服务已到达但密钥被拒绝；404 通常为 basePath 错误；HTML 响应通常来自反代错误页/过期隧道；SERVICE_CONNECT 检查监听地址、端口、防火墙与系统代理；SERVICE_TIMEOUT 检查上游或隧道；SERVICE_TLS 检查隧道域名是否生效和证书链。代理的 Fake-IP DNS 可能把不存在的域名映射为虚拟 IP，使 NXDOMAIN 表现为 TLS 握手失败，此时应核对隧道实际输出的地址。密钥不会出现在诊断日志。

部署使用新的服务包不自动替换你当前运行的旧进程；修改端口或配置后，需要重启对应的服务和隧道。
