# API 对接协议 v3

基础地址示例 `https://sync.example.com/mokidown`。以下路径拼接到基础地址；所有业务请求携带 `Authorization: Bearer <部署密钥>`，写请求使用 `Content-Type: application/json`。无需 Cookie、账号或刷新令牌。`/auth/*` 不存在。

## 能力发现

```sh
curl -H "Authorization: Bearer $MOKIDOWN_KEY" https://sync.example.com/mokidown/capabilities
```

响应：

```json
{
  "service": "mokidown-plugin-server",
  "version": 1,
  "instanceId": "部署时生成的稳定ID",
  "namespace": "default",
  "authentication": "access-key",
  "registration": false,
  "plugins": [{"id":"cloud-sync","version":"1.0.0","protocolVersion":3}],
  "limits": {"requestBytes":3670016,"decodedBytes":33554432,"stateBytes":67108864}
}
```

客户端状态必须按 endpoint + instanceId + namespace + 本地授权目录分区，不能把旧服务的 cursor、版本或文件映射传入新服务。

## 上传与幂等

`PUT /sync/file/{fileId}` 创建或更新文档。fileId 和 mutationId 为 1..128 位字母、数字、点、下划线、冒号或短横线，推荐 UUID；保留名称 `__proto__`、`constructor`、`prototype` 禁止使用。

```json
{
  "mutationId": "9c763759-c4dd-4ae4-ae26-0d9706205400",
  "baseRev": 0,
  "fileName": "notes/example.md",
  "content": "hello",
  "compressed": false,
  "size": 5,
  "checksum": "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
  "encoding": "UTF-8",
  "lineEnding": "LF"
}
```

新建 baseRev=0；更新、删除、恢复均使用上次确认的 rev。成功返回元数据 `{fileId,rev,seq,updatedAt,deleted,fileName,size,checksum,contentHash,...}`，不回传正文。编码为 UTF-8，size 是原始正文 UTF-8 字节数；checksum 为原始正文 SHA-256 小写十六进制。大文本可令 compressed=true，content 是 gzip 压缩字节的 base64。

请求 JSON 最多 3.5 MiB，解压正文最多 32 MiB，配置快照最多 256 KiB。客户端应先校验服务能力中的 stateBytes；当前数据空间的状态容量还包括操作回执。

写入前将整个操作及 mutationId 持久化；响应丢失后原样重试同一请求。服务端会返回首次提交结果，不增加 rev。一个 mutationId 永远只能对应一个请求；重试时 JSON 字段顺序和内容均保持一致。不要因超时而生成新 ID。每次独立编辑使用新 mutationId。

并发修改返回 HTTP 409：

```json
{"code":"REV_CONFLICT","message":"Document changed on another device","current":{"fileId":"...","rev":2,"content":"远端当前内容","deleted":false},"requestId":"..."}
```

客户端必须保留本地内容并呈现冲突；不得直接把 baseRev 改为新版本重试。只有用户明确选择保留本地时，才读取当前远端版本并创建新的 mutationId。

## 下载与增量 cursor

`GET /sync/file/{fileId}` 返回带完整正文和 deviceBindings 的当前快照；删除后返回 tombstone，仍为 HTTP 200。未知文件为 404。

`GET /sync/changes?cursor=&limit=25` 首次拉取；limit 为 1..100。响应：

```json
{"changes":[{"fileId":"...","rev":1,"seq":1,"fileName":"notes/example.md","deleted":false}],"nextCursor":"1","hasMore":false}
```

只包含 cursor 后发生变化的文件元数据，每个文件返回最新快照；需要正文时再 GET file。changes 不携带正文。处理并持久化整页后再提交 nextCursor；hasMore=true 时继续请求。cursor 为服务端生成的十进制序号字符串，在同一数据空间内有序，不是时间戳。当前版本不接收旧版 since 时间戳。

分页期间新增编辑可能把文件移到后续页；客户端按文件 rev 去重。已经拉取到更高版本时，不能因旧页覆盖本地。cursor 超出本空间序号返回 400，通常意味着误用了其他服务的状态，应先检查 instanceId 和 namespace，不能清空远端数据恢复。

删除用 `DELETE /sync/file/{fileId}`，JSON 为 `{baseRev,mutationId}`。保留墓碑，后续恢复相同 fileId 必须以墓碑 rev 为 baseRev。新设备看到没有本地映射的旧墓碑可跳过，不必创建文件。不得在不完整或失败的本地扫描后生成批量删除。

## 设置与设备绑定

`GET/PUT /sync/config` 存取配置快照；PUT 必须含 updatedAt（毫秒时间戳）。服务端只接受时间戳不早于现有快照的设置。服务端丢弃 serverUrl、accessKey、syncEnabled、workspacePath 等连接字段。当前独立客户端插件只同步文件，不调用此设置接口。

`POST /sync/bindings/{fileId}` JSON 为 `{deviceId,devicePath,mutationId}`。只维护设备路径元数据，不修改正文 rev 或内容 cursor。当前独立插件使用本机映射，不依赖该兼容接口。

## 错误与重试

统一响应 `{code,message,requestId,...}`；409 的 current 可能为 null。请求 ID 也通过 `X-Request-ID` 返回。所有响应带 `Cache-Control: no-store`。

| HTTP | code 示例 | 客户端处理 |
| --- | --- | --- |
| 400 | INVALID_REQUEST / INVALID_JSON / INVALID_CONTENT | 修复字段或内容；不要重试同一无效请求 |
| 401 | ACCESS_KEY_REQUIRED | 核对服务密钥；不跳转登录 |
| 403 | ORIGIN_DENIED | 浏览器对接时配置来源白名单 |
| 404 | FILE_NOT_FOUND / NOT_FOUND | 文件不存在、路由不存在或插件未启用 |
| 409 | REV_CONFLICT | 保留两份内容，交给用户处理 |
| 409 | MUTATION_REUSED | mutationId 被错误用于另一次操作 |
| 413 | PAYLOAD_TOO_LARGE / ACCOUNT_STORAGE_LIMIT | 缩小请求或扩充数据空间容量 |
| 415 | JSON_REQUIRED | 设置正确的 Content-Type |
| 503 | STORAGE_BUSY / SERVICE_UNAVAILABLE | 退避后以原 mutationId 重试 |

服务进程退出会等待进行中的请求；服务端数据库的 CAS 操作保证一个变更的正文、版本、cursor 和幂等回执同时成功。部署多实例时保持配置中的 instanceId、accessKeys 和数据库一致。
