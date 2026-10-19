#!/usr/bin/env node
// Generated from bin/cli.mjs and the shared protocol v3 runtime. Run npm run build:standalone to regenerate.
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};

// ../mokidown-plugin-incremental-sync/bin/foreground.mjs
var foreground_exports = {};
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync, createWriteStream } from "node:fs";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
function freePort(port) {
  return new Promise((resolve2) => {
    const server3 = createServer();
    server3.once("error", () => resolve2(false));
    server3.once("listening", () => server3.close(() => resolve2(true)));
    server3.listen(port, "127.0.0.1");
  });
}
function accessToken() {
  const provided = flag("--token", process.env.SYNC_TOKEN || "");
  if (provided) {
    writeFileSync(TOKEN_FILE, provided, { mode: 384 });
    return provided;
  }
  if (existsSync(TOKEN_FILE)) {
    const saved = readFileSync(TOKEN_FILE, "utf8").trim();
    if (saved) return saved;
  }
  const token2 = crypto.randomBytes(32).toString("hex");
  writeFileSync(TOKEN_FILE, token2, { mode: 384 });
  return token2;
}
function sleep(ms) {
  return new Promise((resolve2) => setTimeout(resolve2, ms));
}
function cloudflaredAsset() {
  const arch = process.arch === "arm64" ? "arm64" : "amd64";
  if (process.platform === "win32") return { url: `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-${arch}.exe`, name: "cloudflared.exe" };
  if (process.platform === "darwin") return { url: `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-${arch}.tgz`, name: "cloudflared.tgz", tgz: true };
  return { url: `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch}`, name: "cloudflared", binary: true };
}
async function download(url, destination) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  await new Promise((resolve2, reject) => {
    const stream = createWriteStream(destination);
    const body = res.body;
    if (!body) return reject(new Error("empty response"));
    body.pipeTo(new WritableStream({
      write(chunk) {
        stream.write(Buffer.from(chunk));
      },
      close() {
        stream.end(resolve2);
      },
      abort(error) {
        stream.destroy();
        reject(error);
      }
    }));
  });
}
async function ensureCloudflared() {
  const asset = cloudflaredAsset();
  const target = path.join(TOOLS_DIR, asset.name);
  if (existsSync(target) && !asset.tgz) return target;
  process.stdout.write(`
[1/3] downloading cloudflared\u2026
`);
  await download(asset.url, target);
  if (asset.binary) chmodSync(target, 493);
  if (asset.tgz) {
    const { execFileSync } = await import("node:child_process");
    execFileSync("tar", ["-xzf", target, "-C", TOOLS_DIR], { stdio: "inherit" });
    chmodSync(path.join(TOOLS_DIR, "cloudflared"), 493);
    return path.join(TOOLS_DIR, "cloudflared");
  }
  return target;
}
function start(processPath, label, env) {
  const childArgs = true ? [fileURLToPath(import.meta.url), "__" + label] : [processPath];
  const child = spawn(process.execPath, childArgs, { env: { ...process.env, ...env }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (data) => process.stdout.write(`[${label}] ${data}`));
  child.stderr.on("data", (data) => process.stderr.write(`[${label}] ${data}`));
  child.on("error", (error) => {
    console.error(`[${label}] ${error.message}`);
    void shutdown(1);
  });
  child.on("exit", (code) => {
    if (!stopping) {
      console.error(`[${label}] exited with code ${code}`);
      void shutdown(1);
    }
  });
  return child;
}
async function main() {
  if (!await freePort(PORT)) {
    console.error(`
Port ${PORT} is already in use \u2014 another mokidown-sync is probably running.`);
    console.error("Use mokidown-sync stop, or choose --port / --proxy-port.");
    process.exit(1);
  }
  if (!await freePort(PROXY_PORT)) {
    console.error(`
Port ${PROXY_PORT} is already in use \u2014 another mokidown-sync is probably running.`);
    console.error("Use mokidown-sync stop, or choose --port / --proxy-port.");
    process.exit(1);
  }
  const token2 = accessToken();
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(here, "..");
  const serverPath = path.join(root, "server", "index.mjs");
  const proxyPath = path.join(root, "server", "proxy.mjs");
  process.stdout.write(`[2/3] starting sync server + proxy\u2026
`);
  children.push(start(serverPath, "server", { SYNC_TOKEN: token2, PORT: String(PORT), PROXY_PORT: String(PROXY_PORT), DATA_DIR }));
  children.push(start(proxyPath, "proxy", { SYNC_TOKEN: token2, PORT: String(PORT), PROXY_PORT: String(PROXY_PORT), DATA_DIR, PROXY_HOST: flag("--host", "127.0.0.1"), TARGET: `http://127.0.0.1:${PORT}` }));
  for (let i = 0; ; i++) {
    try {
      const response = await fetch("http://127.0.0.1:" + PROXY_PORT + "/capabilities", { headers: { Authorization: "Bearer " + token2 }, signal: AbortSignal.timeout(1e3) });
      if (response.ok) break;
    } catch {
    }
    if (i > 80) throw new Error("Server/proxy readiness timed out");
    await sleep(100);
  }
  let endpoint = `http://127.0.0.1:${PROXY_PORT}`;
  let tunnel = null;
  if (USE_TUNNEL) {
    process.stdout.write(`[3/3] opening public tunnel\u2026
`);
    const cloudflared = await ensureCloudflared();
    tunnel = spawn(cloudflared, ["tunnel", "--url", `http://127.0.0.1:${PROXY_PORT}`, "--no-autoupdate"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    tunnel.on("error", (error) => {
      console.error(error.message);
      void shutdown(1);
    });
    tunnel.on("exit", () => {
      if (!stopping) void shutdown(1);
    });
    children.push(tunnel);
    endpoint = await new Promise((resolve2, reject) => {
      const timer = setTimeout(() => reject(new Error("tunnel timeout")), 45e3);
      const onData = (data) => {
        const match = String(data).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (match) {
          clearTimeout(timer);
          resolve2(match[0]);
        }
      };
      tunnel.stdout.on("data", onData);
      tunnel.stderr.on("data", onData);
    });
  }
  process.emit("mokidown-ready", { endpoint, localEndpoint: `http://127.0.0.1:${PROXY_PORT}`, port: PORT, proxyPort: PROXY_PORT });
  const line = "\u2500".repeat(56);
  process.stdout.write(`
${line}
`);
  process.stdout.write(`MokiDown sync server is running
`);
  process.stdout.write(`  Endpoint : ${endpoint}
`);
  if (!process.listenerCount("mokidown-ready")) process.stdout.write(`  Token    : ${token2}
`);
  process.stdout.write(`
Fill these in Settings \u2192 Plugins \u2192 Incremental Sync:
`);
  process.stdout.write(`  endpoint  = ${endpoint}
`);
  process.stdout.write(`  credential= (see ${TOKEN_FILE})
`);
  process.stdout.write(`${line}
Ctrl+C to stop.
`);
}
var args, flag, has, PORT, PROXY_PORT, USE_TUNNEL, HOME, TOKEN_FILE, DATA_DIR, TOOLS_DIR, children, stopping, shutdown;
var init_foreground = __esm({
  "../mokidown-plugin-incremental-sync/bin/foreground.mjs"() {
    args = process.argv.slice(2);
    flag = (name, fallback) => {
      const index = args.indexOf(name);
      return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
    };
    has = (name) => args.includes(name);
    PORT = Number(flag("--port", "4319"));
    PROXY_PORT = Number(flag("--proxy-port", "4320"));
    USE_TUNNEL = !has("--no-tunnel");
    HOME = process.env.MOKIDOWN_SYNC_HOME || path.join(os.homedir(), ".mokidown-sync");
    TOKEN_FILE = path.join(HOME, "token");
    DATA_DIR = process.env.DATA_DIR || path.join(HOME, "data");
    TOOLS_DIR = path.join(HOME, "tools");
    mkdirSync(DATA_DIR, { recursive: true });
    mkdirSync(TOOLS_DIR, { recursive: true });
    children = [];
    stopping = false;
    shutdown = async (code = 0) => {
      if (stopping) return;
      stopping = true;
      await Promise.all(children.map((child) => new Promise((resolve2) => {
        if (child.exitCode !== null || child.signalCode) return resolve2();
        const timeout = setTimeout(() => {
          child.kill("SIGKILL");
          resolve2();
        }, 4e3);
        child.once("exit", () => {
          clearTimeout(timeout);
          resolve2();
        });
        child.kill();
      })));
      process.exit(code);
    };
    process.on("SIGINT", () => shutdown());
    process.on("SIGTERM", () => shutdown());
    process.on("mokidown-stop", () => shutdown());
    main().catch(async (error) => {
      console.error(`
Failed to start: ${error.message}`);
      await shutdown(1);
    });
  }
});

// ../mokidown-plugin-incremental-sync/server/runtime/errors.mjs
function requireValue(condition, message) {
  if (!condition) throw new ApiError(400, "INVALID_REQUEST", message);
}
var ApiError;
var init_errors = __esm({
  "../mokidown-plugin-incremental-sync/server/runtime/errors.mjs"() {
    ApiError = class extends Error {
      constructor(status, code, message, details = {}) {
        super(message);
        Object.assign(this, { status, code, details });
      }
    };
  }
});

// ../mokidown-plugin-incremental-sync/server/runtime/plugins/cloud-sync.mjs
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
function validateBody(body) {
  requireValue(typeof body.content === "string" && typeof body.compressed === "boolean", "content and compressed are required");
  let bytes;
  try {
    bytes = body.compressed ? gunzipSync(Buffer.from(body.content, "base64"), { maxOutputLength: 32 * 1024 * 1024 }) : Buffer.from(body.content, "utf8");
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ApiError(400, "INVALID_CONTENT", "Invalid UTF-8 or gzip content, or decoded content exceeds 32 MiB");
  }
  requireValue(bytes.length <= 32 * 1024 * 1024 && body.size === bytes.length, "Invalid size");
  requireValue(body.checksum === hash(bytes), "SHA-256 checksum mismatch");
  for (const key of ["fileName", "encoding", "lineEnding", "deviceId", "devicePath", "originalPath"]) {
    requireValue(body[key] === void 0 || typeof body[key] === "string" && body[key].length <= 4096, `Invalid ${key}`);
  }
}
var empty, hash, safeId, metadata, cloudSyncPlugin;
var init_cloud_sync = __esm({
  "../mokidown-plugin-incremental-sync/server/runtime/plugins/cloud-sync.mjs"() {
    init_errors();
    empty = () => ({ seq: 0, files: {}, receipts: {}, config: { protocolVersion: 3, updatedAt: 0 } });
    hash = (value) => createHash("sha256").update(value).digest("hex");
    safeId = (value) => typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,128}$/.test(value) && !["__proto__", "constructor", "prototype"].includes(value);
    metadata = ({ content: _content, ...doc }) => doc;
    cloudSyncPlugin = {
      id: "cloud-sync",
      version: "1.0.0",
      protocolVersion: 3,
      async handle({ method, path: path3, query, body, namespace, storage: storage2 }) {
        if (!path3.startsWith("/sync/")) return void 0;
        const key = `sync:${namespace}`;
        if (path3 === "/sync/config") {
          if (method === "GET") return (await storage2.get(key) || empty()).config;
          if (method === "PUT") {
            requireValue(Number.isFinite(body.updatedAt) && body.updatedAt >= 0, "updatedAt must be a timestamp in milliseconds");
            requireValue(Buffer.byteLength(JSON.stringify(body)) <= 256 * 1024, "Config exceeds 256 KiB");
            const { serverUrl: _url, syncEnabled: _enabled, accessKey: _key, workspacePath: _path, ...settings } = body;
            return storage2.mutate(key, empty(), (state) => {
              if (settings.updatedAt >= state.config.updatedAt) state.config = { ...settings, protocolVersion: 3 };
              return state.config;
            });
          }
        }
        if (path3 === "/sync/changes" && method === "GET") {
          const state = await storage2.get(key) || empty();
          const cursor = query.get("cursor") || "0";
          requireValue(/^\d+$/.test(cursor) && Number.isSafeInteger(Number(cursor)) && Number(cursor) <= state.seq, "Invalid cursor");
          const limit = Number(query.get("limit") || 25);
          requireValue(Number.isInteger(limit) && limit >= 1 && limit <= 100, "limit must be 1..100");
          const pending = Object.values(state.files).filter((doc) => doc.seq > Number(cursor)).sort((a, b) => a.seq - b.seq);
          const changes = pending.slice(0, limit).map(metadata);
          return { changes, nextCursor: String(changes.at(-1)?.seq ?? state.seq), hasMore: pending.length > limit };
        }
        const versions = path3.match(/^\/sync\/file\/([^/]+)\/versions(?:\/(\d+))?$/);
        if (versions && method === "GET") {
          let fileId2;
          try {
            fileId2 = decodeURIComponent(versions[1]);
          } catch {
            throw new ApiError(400, "INVALID_REQUEST", "Invalid file ID");
          }
          requireValue(safeId(fileId2), "Invalid file ID");
          const state = await storage2.get(key);
          const current = state?.files[fileId2];
          if (!current) throw new ApiError(404, "FILE_NOT_FOUND", "Document not found");
          const history = { ...state.history?.[fileId2], [current.rev]: current };
          if (!versions[2]) return { versions: Object.values(history).sort((a, b) => b.rev - a.rev).map(metadata) };
          const revision = Number(versions[2]);
          requireValue(Number.isSafeInteger(revision) && revision > 0, "Invalid revision");
          const doc = history[revision];
          if (!doc) throw new ApiError(404, "VERSION_NOT_FOUND", "Document revision not found");
          return doc;
        }
        const match = path3.match(/^\/sync\/(file|bindings)\/([^/]+)$/);
        if (!match) return void 0;
        const [, kind, rawId] = match;
        let fileId;
        try {
          fileId = decodeURIComponent(rawId);
        } catch {
          throw new ApiError(400, "INVALID_REQUEST", "Invalid file ID");
        }
        requireValue(safeId(fileId), "Invalid file ID");
        if (kind === "file" && method === "GET") {
          const doc = (await storage2.get(key))?.files[fileId];
          if (!doc) throw new ApiError(404, "FILE_NOT_FOUND", "Document not found");
          return doc;
        }
        const binding = kind === "bindings" && method === "POST";
        if (!(binding || kind === "file" && ["PUT", "DELETE"].includes(method))) return void 0;
        requireValue(safeId(body.mutationId), "A stable mutationId is required");
        if (!binding) requireValue(Number.isSafeInteger(body.baseRev) && body.baseRev >= 0, "baseRev must be a non-negative integer");
        if (method === "PUT") validateBody(body);
        if (binding) requireValue(safeId(body.deviceId) && typeof body.devicePath === "string" && body.devicePath.length <= 4096, "deviceId and devicePath are required");
        const fingerprint = hash(JSON.stringify({ method, path: path3, body }));
        return storage2.mutate(key, empty(), (state) => {
          const previous = state.receipts[body.mutationId];
          if (previous) {
            if (previous.fingerprint !== fingerprint) throw new ApiError(409, "MUTATION_REUSED", "mutationId was already used for another request");
            return previous.result;
          }
          const current = state.files[fileId];
          if (binding && (!current || current.deleted)) throw new ApiError(404, "FILE_NOT_FOUND", "Document not found");
          if (!binding && (current?.rev || 0) !== body.baseRev) throw new ApiError(409, "REV_CONFLICT", "Document changed on another device", { current: current || null });
          if (!binding && method === "PUT" && !current && body.fileName) {
            const occupied = Object.values(state.files).find((doc2) => !doc2.deleted && doc2.fileName === body.fileName);
            if (occupied) throw new ApiError(409, "PATH_CONFLICT", "Document path already exists on another device", { current: occupied });
          }
          let doc;
          if (binding) {
            doc = { ...current, deviceBindings: { ...current.deviceBindings, [body.deviceId]: body.devicePath } };
          } else {
            doc = {
              fileId,
              rev: (current?.rev || 0) + 1,
              seq: ++state.seq,
              updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
              deleted: method === "DELETE",
              ...method === "PUT" ? {
                content: body.content,
                compressed: body.compressed,
                size: body.size,
                checksum: body.checksum,
                contentHash: body.checksum,
                name: body.fileName || fileId,
                fileName: body.fileName || fileId,
                encoding: body.encoding || "UTF-8",
                lineEnding: body.lineEnding || "LF",
                originalPath: body.originalPath || ""
              } : { name: current?.name || fileId },
              deviceBindings: { ...current?.deviceBindings }
            };
            if (body.deviceId && safeId(body.deviceId) && body.devicePath) doc.deviceBindings[body.deviceId] = body.devicePath;
          }
          if (!binding) {
            state.history ||= {};
            const history = state.history[fileId] ||= {};
            if (current) history[current.rev] ||= current;
            history[doc.rev] = doc;
          }
          state.files[fileId] = doc;
          const result = metadata(doc);
          state.receipts[body.mutationId] = { fingerprint, result };
          return result;
        });
      }
    };
  }
});

// ../mokidown-plugin-incremental-sync/server/runtime/server.mjs
import { createServer as createServer2 } from "node:http";
import { createHash as createHash2, timingSafeEqual, randomUUID } from "node:crypto";
async function readBody(req) {
  const chunks = [];
  let size = 0;
  await new Promise((resolve2, reject) => {
    let tooLarge = false;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        if (!tooLarge) reject(new ApiError(413, "PAYLOAD_TOO_LARGE", "Request exceeds 3.5 MiB"));
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", resolve2);
    req.on("error", reject);
    req.on("aborted", () => reject(new ApiError(408, "REQUEST_ABORTED", "Request aborted")));
  });
  if (!size) return {};
  if (!/^application\/json(?:;|$)/i.test(req.headers["content-type"] || "")) throw new ApiError(415, "JSON_REQUIRED", "Use Content-Type: application/json");
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || Array.isArray(body) || typeof body !== "object") throw new Error();
    return body;
  } catch {
    throw new ApiError(400, "INVALID_JSON", "Expected a JSON object");
  }
}
function createPluginServer(config, storage2, availablePlugins = [cloudSyncPlugin]) {
  const plugins = config.plugins.map((id) => {
    const plugin = availablePlugins.find((candidate) => candidate.id === id);
    if (!plugin) throw new Error(`Unknown plugin: ${id}`);
    return plugin;
  });
  const keys = config.accessKeys.map((entry) => ({ ...entry, digest: digest(entry.key) }));
  const server3 = createServer2({ requestTimeout: 3e4, headersTimeout: 15e3, maxHeaderSize: 16384 }, async (req, res) => {
    const requestId = randomUUID();
    res.setHeader("X-Request-ID", requestId);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    const send = (status, data) => {
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(data));
    };
    try {
      const origin = req.headers.origin;
      if (origin) {
        if (!config.corsOrigins.includes(origin)) throw new ApiError(403, "ORIGIN_DENIED", "Origin is not allowed");
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
        res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Cache-Control, Pragma, Expires");
        res.setHeader("Access-Control-Allow-Methods", "GET, PUT, POST, DELETE, OPTIONS");
      }
      const url = new URL(req.url, "http://localhost");
      const prefix = config.basePath || "";
      if (prefix && !url.pathname.startsWith(`${prefix}/`)) throw new ApiError(404, "NOT_FOUND", "Route not found");
      const path3 = url.pathname.slice(prefix.length);
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }
      if (path3 === "/healthz" && req.method === "GET") return send(200, { status: "ok" });
      const token2 = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1] || "";
      const tokenHash = digest(token2);
      const entry = keys.find((candidate) => timingSafeEqual(candidate.digest, tokenHash));
      if (!entry) throw new ApiError(401, "ACCESS_KEY_REQUIRED", "Provide a valid service access key");
      if (path3 === "/readyz" && req.method === "GET") {
        await storage2.get(`sync:${entry.namespace}`);
        return send(200, { status: "ready" });
      }
      if (path3 === "/capabilities" && req.method === "GET") return send(200, {
        service: "mokidown-plugin-server",
        version: 1,
        instanceId: config.instanceId,
        namespace: entry.namespace,
        authentication: "access-key",
        registration: false,
        plugins: plugins.map(({ id, version, protocolVersion }) => ({ id, version, protocolVersion })),
        limits: { requestBytes: MAX_BODY, decodedBytes: 32 * 1024 * 1024, stateBytes: storage2.maxBytes }
      });
      const body = await readBody(req);
      for (const plugin of plugins) {
        const result = await plugin.handle({ method: req.method, path: path3, query: url.searchParams, body, namespace: entry.namespace, storage: storage2 });
        if (result !== void 0) return send(200, result);
      }
      throw new ApiError(404, "NOT_FOUND", "Route not found or plugin disabled");
    } catch (error) {
      const known = error instanceof ApiError;
      if (!known) console.error(JSON.stringify({ requestId, code: "INTERNAL_ERROR", type: error.name }));
      if (!res.headersSent && !res.destroyed) send(known ? error.status : 503, {
        code: known ? error.code : "SERVICE_UNAVAILABLE",
        message: known ? error.message : "Storage or service unavailable",
        ...known ? error.details : {},
        requestId
      });
    }
  });
  server3.keepAliveTimeout = 5e3;
  return server3;
}
var digest, MAX_BODY;
var init_server = __esm({
  "../mokidown-plugin-incremental-sync/server/runtime/server.mjs"() {
    init_errors();
    init_cloud_sync();
    digest = (text) => createHash2("sha256").update(text).digest();
    MAX_BODY = 3.5 * 1024 * 1024;
  }
});

// ../mokidown-plugin-incremental-sync/server/runtime/storage.mjs
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
async function openStorage(config) {
  const type = config.type;
  let adapter;
  if (type === "sqlite") {
    const { DatabaseSync } = await import("node:sqlite");
    const filename = config.filename === ":memory:" ? ":memory:" : resolve(config.filename || "data/sync.sqlite");
    if (filename !== ":memory:") await mkdir(dirname(filename), { recursive: true });
    const db = new DatabaseSync(filename);
    db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS mokidown_state (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, payload TEXT NOT NULL)");
    adapter = {
      read: async (id) => db.prepare("SELECT revision, payload FROM mokidown_state WHERE id=?").get(id),
      insert: async (id, payload) => Number(db.prepare("INSERT OR IGNORE INTO mokidown_state VALUES (?,1,?)").run(id, payload).changes) === 1,
      update: async (id, revision, payload) => Number(db.prepare("UPDATE mokidown_state SET revision=revision+1,payload=? WHERE id=? AND revision=?").run(payload, id, revision).changes) === 1,
      close: async () => db.close()
    };
  } else if (type === "postgres") {
    const { default: pg } = await import("pg");
    const pool = new pg.Pool({ connectionString: config.url, connectionTimeoutMillis: 1e4, ...config.tls ? { ssl: config.tls } : {} });
    try {
      await pool.query("CREATE TABLE IF NOT EXISTS mokidown_state (id VARCHAR(128) PRIMARY KEY, revision INTEGER NOT NULL, payload TEXT NOT NULL)");
    } catch (error) {
      await pool.end();
      throw error;
    }
    adapter = {
      read: async (id) => (await pool.query("SELECT revision,payload FROM mokidown_state WHERE id=$1", [id])).rows[0],
      insert: async (id, payload) => (await pool.query("INSERT INTO mokidown_state VALUES ($1,1,$2) ON CONFLICT DO NOTHING", [id, payload])).rowCount === 1,
      update: async (id, revision, payload) => (await pool.query("UPDATE mokidown_state SET revision=revision+1,payload=$1 WHERE id=$2 AND revision=$3", [payload, id, revision])).rowCount === 1,
      close: () => pool.end()
    };
  } else if (type === "mysql" || type === "mariadb") {
    const { default: mysql } = await import("mysql2/promise");
    const pool = mysql.createPool({ uri: config.url, connectTimeout: 1e4, ...config.tls ? { ssl: config.tls } : {} });
    try {
      await pool.query("CREATE TABLE IF NOT EXISTS mokidown_state (id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY, revision INT NOT NULL, payload LONGTEXT NOT NULL) ENGINE=InnoDB");
    } catch (error) {
      await pool.end();
      throw error;
    }
    adapter = {
      read: async (id) => (await pool.execute("SELECT revision,payload FROM mokidown_state WHERE id=?", [id]))[0][0],
      insert: async (id, payload) => {
        try {
          await pool.execute("INSERT INTO mokidown_state VALUES (?,1,?)", [id, payload]);
          return true;
        } catch (error) {
          if (error.code === "ER_DUP_ENTRY") return false;
          throw error;
        }
      },
      update: async (id, revision, payload) => (await pool.execute("UPDATE mokidown_state SET revision=revision+1,payload=? WHERE id=? AND revision=?", [payload, id, revision]))[0].affectedRows === 1,
      close: () => pool.end()
    };
  } else if (type === "mongodb") {
    const { MongoClient } = await import("mongodb");
    const client = new MongoClient(config.url, { serverSelectionTimeoutMS: 1e4 });
    try {
      await client.connect();
    } catch (error) {
      await client.close();
      throw error;
    }
    const collection = client.db(config.database || void 0).collection("mokidown_state");
    adapter = {
      read: (id) => collection.findOne({ _id: id }),
      insert: async (id, payload) => {
        try {
          await collection.insertOne({ _id: id, revision: 1, payload });
          return true;
        } catch (error) {
          if (error.code === 11e3) return false;
          throw error;
        }
      },
      update: async (id, revision, payload) => (await collection.updateOne({ _id: id, revision }, { $set: { payload }, $inc: { revision: 1 } })).modifiedCount === 1,
      close: () => client.close()
    };
  } else if (type === "mssql") {
    const { default: sql } = await import("mssql");
    const pool = await new sql.ConnectionPool(config.connection || config.url).connect();
    try {
      await pool.request().query("IF OBJECT_ID(N'dbo.mokidown_state', N'U') IS NULL CREATE TABLE dbo.mokidown_state (id VARCHAR(128) COLLATE Latin1_General_100_BIN2 PRIMARY KEY, revision INT NOT NULL, payload NVARCHAR(MAX) NOT NULL)");
    } catch (error) {
      await pool.close();
      throw error;
    }
    const request = (id, revision, payload) => {
      const r = pool.request().input("id", sql.VarChar(128), id);
      if (revision !== void 0) r.input("revision", sql.Int, revision);
      if (payload !== void 0) r.input("payload", sql.NVarChar(sql.MAX), payload);
      return r;
    };
    adapter = {
      read: async (id) => (await request(id).query("SELECT revision,payload FROM dbo.mokidown_state WHERE id=@id")).recordset[0],
      insert: async (id, payload) => {
        try {
          await request(id, void 0, payload).query("INSERT INTO dbo.mokidown_state VALUES (@id,1,@payload)");
          return true;
        } catch (error) {
          if ([2601, 2627].includes(error.number)) return false;
          throw error;
        }
      },
      update: async (id, revision, payload) => (await request(id, revision, payload).query("UPDATE dbo.mokidown_state SET revision=revision+1,payload=@payload WHERE id=@id AND revision=@revision")).rowsAffected[0] === 1,
      close: () => pool.close()
    };
  } else {
    throw new Error(`Unsupported database type: ${type}`);
  }
  return new StateStore(adapter, config.maxStateBytes || (type === "mongodb" ? 12 : 64) * 1024 * 1024);
}
var StateStore;
var init_storage = __esm({
  "../mokidown-plugin-incremental-sync/server/runtime/storage.mjs"() {
    init_errors();
    StateStore = class {
      constructor(adapter, maxBytes) {
        this.adapter = adapter;
        this.maxBytes = maxBytes;
      }
      async get(key) {
        const row = await this.adapter.read(key);
        return row ? JSON.parse(row.payload) : null;
      }
      async mutate(key, initial, operation) {
        for (let attempt = 0; attempt < 20; attempt++) {
          const row = await this.adapter.read(key);
          const state = row ? JSON.parse(row.payload) : structuredClone(initial);
          const result = operation(state);
          const payload = JSON.stringify(state);
          if (Buffer.byteLength(payload) > this.maxBytes) throw new ApiError(413, "ACCOUNT_STORAGE_LIMIT", "Account storage limit exceeded");
          const saved = row ? await this.adapter.update(key, row.revision, payload) : await this.adapter.insert(key, payload);
          if (saved) return result;
        }
        throw new ApiError(503, "STORAGE_BUSY", "Concurrent writes; retry with the same mutationId");
      }
      close() {
        return this.adapter.close();
      }
    };
  }
});

// ../mokidown-plugin-incremental-sync/server/runtime/legacy.mjs
import { readFile, copyFile, mkdir as mkdir2 } from "node:fs/promises";
import { join } from "node:path";
import { createHash as createHash3 } from "node:crypto";
import { gunzipSync as gunzipSync2 } from "node:zlib";
function migrateLegacyState(legacy) {
  if (!Number.isSafeInteger(legacy.rev) || legacy.rev < 0 || !legacy.files || Array.isArray(legacy.files)) throw new Error("Invalid legacy database");
  const state = { seq: legacy.rev, files: {}, history: {}, receipts: {}, config: { protocolVersion: 3, updatedAt: 0 } };
  for (const [id, record] of Object.entries(legacy.files)) {
    if (!/^[a-zA-Z0-9_.:-]{1,128}$/.test(id) || ["__proto__", "constructor", "prototype"].includes(id) || !Number.isSafeInteger(record.rev) || record.rev < 1 || record.rev > legacy.rev) throw new Error("Invalid legacy file identity or revision");
    const { fileId: _id, rev, updatedAt, ...body } = record;
    if (typeof body.content !== "string") throw new Error("Missing legacy content");
    const bytes = body.compressed ? gunzipSync2(Buffer.from(body.content, "base64"), { maxOutputLength: 32 * 1024 * 1024 }) : Buffer.from(body.content);
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (bytes.length > 32 * 1024 * 1024 || body.checksum && body.checksum !== hash2(bytes) || body.size !== void 0 && body.size !== bytes.length) throw new Error("Invalid legacy file checksum or size");
    const doc = { ...body, fileId: id, rev, seq: rev, updatedAt, deleted: false, compressed: Boolean(body.compressed), size: bytes.length, checksum: hash2(bytes), contentHash: hash2(bytes), fileName: body.fileName || body.originalPath || id, deviceBindings: {} };
    state.files[id] = doc;
    const history = state.history[id] = { [rev]: doc };
    for (const version of legacy.versions?.[id] || []) {
      if (!Number.isSafeInteger(version.rev) || version.rev < 1 || version.rev > rev) throw new Error("Invalid legacy history revision");
      const snapshot = migrateLegacyState({ rev: legacy.rev, files: { [id]: { ...record, ...version, mutationId: void 0 } } }).files[id];
      if (history[snapshot.rev] && history[snapshot.rev].checksum !== snapshot.checksum) throw new Error("Inconsistent legacy history");
      history[snapshot.rev] = snapshot;
    }
    if (body.mutationId) {
      if (state.receipts[body.mutationId] || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(body.mutationId) || ["__proto__", "constructor", "prototype"].includes(body.mutationId)) throw new Error("Invalid legacy mutation identity");
      const { content: _content, ...result } = doc;
      state.receipts[body.mutationId] = { fingerprint: hash2(JSON.stringify({ method: "PUT", path: `/sync/file/${encodeURIComponent(id)}`, body })), result };
    }
  }
  return state;
}
async function openLegacyStorage(directory2) {
  await mkdir2(directory2, { recursive: true });
  const storage2 = await openStorage({ type: "sqlite", filename: join(directory2, "sync-v3.sqlite") });
  try {
    if (!await storage2.get("sync:default")) {
      let legacy;
      try {
        legacy = JSON.parse(await readFile(join(directory2, "documents.json"), "utf8"));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      const state = legacy ? migrateLegacyState(legacy) : { seq: 0, files: {}, receipts: {}, config: { protocolVersion: 3, updatedAt: 0 } };
      await storage2.mutate("sync:default", state, () => true);
    }
    let raw;
    try {
      raw = await readFile(join(directory2, "documents.json"), "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const existing = await storage2.get("sync:default");
    const importedHash = raw ? hash2(raw) : "none";
    if (existing.legacyImportedHash !== importedHash) {
      const imported = raw ? migrateLegacyState(JSON.parse(raw)) : { files: {}, history: {}, receipts: {}, seq: 0 };
      if (raw) await copyFile(join(directory2, "documents.json"), join(directory2, `documents.pre-v3-${Date.now()}.json`));
      const timestamp = (value) => typeof value === "number" ? value : Date.parse(value) || 0;
      await storage2.mutate("sync:default", {}, (state) => {
        state.history ||= {};
        state.seq = Math.max(state.seq, imported.seq);
        for (const [id, doc] of Object.entries(imported.files)) {
          const current = state.files[id];
          const history = state.history[id] ||= {};
          if (current) history[current.rev] ||= current;
          for (const [rev, snapshot] of Object.entries(imported.history[id])) history[rev] ||= snapshot;
          if (!current || timestamp(doc.updatedAt) > timestamp(current.updatedAt)) {
            if (!current || doc.checksum !== current.checksum || doc.rev > current.rev || current.deleted) {
              const rev = current ? Math.max(current.rev + 1, doc.rev) : doc.rev;
              const head = { ...doc, rev, seq: ++state.seq };
              state.files[id] = head;
              history[rev] = head;
            }
          }
        }
        for (const [id, receipt] of Object.entries(imported.receipts)) state.receipts[id] ||= receipt;
        state.legacyHistoryImported = true;
        state.legacyImportedHash = importedHash;
      });
    }
    return storage2;
  } catch (error) {
    await storage2.close();
    throw error;
  }
}
var hash2;
var init_legacy = __esm({
  "../mokidown-plugin-incremental-sync/server/runtime/legacy.mjs"() {
    init_storage();
    hash2 = (value) => createHash3("sha256").update(value).digest("hex");
  }
});

// ../mokidown-plugin-incremental-sync/server/index.mjs
var server_exports = {};
import { join as join2 } from "node:path";
import { homedir } from "node:os";
import { readFileSync as readFileSync2 } from "node:fs";
var directory, token, storage, server;
var init_server2 = __esm({
  async "../mokidown-plugin-incremental-sync/server/index.mjs"() {
    init_server();
    init_legacy();
    directory = process.env.DATA_DIR || join2(homedir(), ".mokidown-sync/data");
    token = process.env.SYNC_TOKEN || readFileSync2(join2(homedir(), ".mokidown-sync/token"), "utf8").trim();
    storage = await openLegacyStorage(directory);
    server = createPluginServer({ plugins: ["cloud-sync"], accessKeys: [{ key: token, namespace: "default" }], instanceId: "mokidown-sync-local", basePath: "", corsOrigins: ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"] }, storage);
    server.listen(Number(process.env.PORT || 4319), process.env.HOST || "127.0.0.1", () => console.log("Protocol v3 sync server ready"));
    for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(async () => {
      await storage.close();
      process.exit(0);
    }));
  }
});

// ../mokidown-plugin-incremental-sync/server/proxy.mjs
var proxy_exports = {};
import http from "node:http";
function takeToken(client) {
  const now = Date.now();
  const bucket = buckets.get(client) || { tokens: RATE_LIMIT, updated: now };
  const refill = (now - bucket.updated) / RATE_WINDOW * RATE_LIMIT;
  bucket.tokens = Math.min(RATE_LIMIT, bucket.tokens + refill);
  bucket.updated = now;
  if (bucket.tokens < 1) {
    buckets.set(client, bucket);
    return false;
  }
  bucket.tokens -= 1;
  buckets.set(client, bucket);
  return true;
}
function allowedPath(pathname) {
  return ALLOW_PATHS.some((prefix) => pathname === prefix || pathname.startsWith(prefix));
}
var TARGET, PORT2, TOKEN, RATE_LIMIT, RATE_WINDOW, ALLOW_PATHS, upstream, buckets, server2;
var init_proxy = __esm({
  "../mokidown-plugin-incremental-sync/server/proxy.mjs"() {
    TARGET = process.env.TARGET || "http://127.0.0.1:4319";
    PORT2 = Number(process.env.PROXY_PORT || 4320);
    TOKEN = process.env.SYNC_TOKEN || "";
    RATE_LIMIT = Number(process.env.PROXY_RATE_LIMIT || 60);
    RATE_WINDOW = Number(process.env.PROXY_RATE_WINDOW_MS || 6e4);
    ALLOW_PATHS = (process.env.PROXY_ALLOW_PATHS || "/capabilities,/sync/").split(",").map((prefix) => prefix.trim()).filter(Boolean);
    upstream = new URL(TARGET);
    buckets = /* @__PURE__ */ new Map();
    server2 = http.createServer((req, res) => {
      const client = req.socket.remoteAddress || "unknown";
      const url = new URL(req.url, "http://localhost");
      if (TOKEN) {
        const provided = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
        if (provided !== TOKEN) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ message: "Unauthorized" }));
          return;
        }
      }
      if (!allowedPath(url.pathname)) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ message: "Not found" }));
        return;
      }
      if (!takeToken(client)) {
        res.writeHead(429, {
          "Content-Type": "application/json",
          "Retry-After": String(Math.ceil(RATE_WINDOW / 1e3))
        });
        res.end(JSON.stringify({ message: "Too many requests" }));
        return;
      }
      const headers = { ...req.headers, host: upstream.host };
      if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
      const request = http.request(new URL(req.url, upstream), { method: req.method, headers }, (response) => {
        res.writeHead(response.statusCode || 502, response.headers);
        response.pipe(res);
      });
      request.on("error", (error) => {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ message: `Upstream error: ${error.message}` }));
      });
      req.pipe(request);
    });
    server2.listen(PORT2, process.env.PROXY_HOST || "127.0.0.1", () => {
      console.log(
        `[sync-proxy] http://127.0.0.1:${PORT2} -> ${TARGET} (token ${TOKEN ? "injected" : "off"}, ${RATE_LIMIT} req/${RATE_WINDOW}ms)`
      );
    });
  }
});

// ../mokidown-plugin-incremental-sync/bin/cli.mjs
import { spawn as spawn2 } from "node:child_process";
import { createServer as createServer3 } from "node:http";
import { mkdirSync as mkdirSync2, readFileSync as readFileSync3, writeFileSync as writeFileSync2, unlinkSync, openSync, closeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir as homedir2 } from "node:os";
import path2 from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";
var args2 = process.argv.slice(2);
if (args2[0] === "--status") args2[0] = "status";
if (args2[0] === "--stop") args2[0] = "stop";
var command = args2[0]?.startsWith("-") || !args2.length ? "start" : args2[0];
var options = command === args2[0] ? args2.slice(1) : args2;
var home = path2.resolve(process.env.MOKIDOWN_SYNC_HOME || path2.join(homedir2(), ".mokidown-sync"));
var statePath = path2.join(home, "service.json");
var logPath = path2.join(home, "service.log");
var pause = (ms) => new Promise((resolve2) => setTimeout(resolve2, ms));
var readState = () => {
  try {
    return JSON.parse(readFileSync3(statePath, "utf8"));
  } catch {
    return null;
  }
};
function removeState(expected) {
  if (readState()?.secret === expected?.secret) {
    try {
      unlinkSync(statePath);
    } catch {
    }
  }
}
async function control(state, action = "status") {
  if (!state || !Number.isInteger(state.controlPort)) return null;
  try {
    const response = await fetch(`http://127.0.0.1:${state.controlPort}/${action}`, { method: action === "stop" ? "POST" : "GET", headers: { Authorization: `Bearer ${state.secret}` }, signal: AbortSignal.timeout(1500) });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}
function describe(status) {
  console.log(`MokiDown sync: ${status.phase} (PID ${status.pid})`);
  if (status.endpoint) console.log(`Endpoint: ${status.endpoint}`);
  if (status.localEndpoint) console.log(`Local: ${status.localEndpoint}`);
  console.log(`Log: ${logPath}`);
}
async function worker() {
  let phase = "starting", ready = {};
  const secret = randomBytes(32).toString("hex");
  const server3 = createServer3((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.headers.authorization !== `Bearer ${secret}`) {
      res.writeHead(401);
      res.end("{}");
      return;
    }
    if (req.url === "/status" && req.method === "GET") {
      res.end(JSON.stringify({ phase, pid: process.pid, ...ready }));
      return;
    }
    if (req.url === "/stop" && req.method === "POST") {
      phase = "stopping";
      res.end(JSON.stringify({ phase }));
      setImmediate(() => process.emit("mokidown-stop"));
      return;
    }
    res.writeHead(404);
    res.end("{}");
  });
  await new Promise((resolve2, reject) => {
    server3.once("error", reject);
    server3.listen(0, "127.0.0.1", resolve2);
  });
  const state = { pid: process.pid, controlPort: server3.address().port, secret };
  try {
    writeFileSync2(statePath, JSON.stringify(state), { flag: "wx", mode: 384 });
  } catch (error) {
    server3.close();
    throw error;
  }
  process.once("exit", () => removeState(state));
  process.on("mokidown-ready", (info) => {
    ready = info;
    phase = "running";
  });
  process.argv = [process.execPath, fileURLToPath2(new URL("./foreground.mjs", import.meta.url)), ...options];
  await Promise.resolve().then(() => (init_foreground(), foreground_exports));
}
async function main2() {
  if (args2.includes("--help") || command === "help") {
    console.log("mokidown-sync [start|stop|status|run] [--port 4319] [--proxy-port 4320] [--host 127.0.0.1] [--no-tunnel]\nstart: detached service; stop: shut down service + proxy + tunnel; status: service status; run: foreground for containers\nData, credentials and logs: ~/.mokidown-sync (or MOKIDOWN_SYNC_HOME).");
    return;
  }
  if (command === "__server") {
    await init_server2().then(() => server_exports);
    return;
  }
  if (command === "__proxy") {
    await Promise.resolve().then(() => (init_proxy(), proxy_exports));
    return;
  }
  mkdirSync2(home, { recursive: true });
  if (command === "__run") return worker();
  if (command === "run") {
    process.argv = [process.execPath, fileURLToPath2(new URL("./foreground.mjs", import.meta.url)), ...options];
    await Promise.resolve().then(() => (init_foreground(), foreground_exports));
    return;
  }
  if (!["start", "stop", "status"].includes(command)) throw new Error(`Unknown command: ${command}`);
  const state = readState();
  const current = await control(state);
  if (!current && state?.pid) {
    let alive = false;
    try {
      process.kill(state.pid, 0);
      alive = true;
    } catch (error) {
      alive = error.code === "EPERM";
    }
    if (alive) throw new Error(`Service process exists but its control endpoint is unreachable; inspect ${logPath}`);
  }
  if (command === "status") {
    if (current) describe(current);
    else {
      console.log("MokiDown sync: stopped");
      process.exitCode = 3;
    }
    return;
  }
  if (command === "stop") {
    if (!current) {
      removeState(state);
      console.log("MokiDown sync: stopped");
      return;
    }
    if (!await control(state, "stop")) throw new Error("Stop request failed");
    for (let i = 0; i < 100; i++) {
      if (!await control(state)) {
        removeState(state);
        console.log("MokiDown sync: stopped");
        return;
      }
      await pause(100);
    }
    throw new Error(`Service is still stopping; inspect ${logPath}`);
  }
  if (current) {
    describe(current);
    return;
  }
  removeState(state);
  const log = openSync(logPath, "a", 384);
  const child = spawn2(process.execPath, [fileURLToPath2(import.meta.url), "__run", ...options], { env: { ...process.env, MOKIDOWN_SYNC_HOME: home }, detached: true, windowsHide: true, stdio: ["ignore", log, log] });
  let spawnError;
  child.on("error", (error) => {
    spawnError = error;
  });
  child.unref();
  closeSync(log);
  console.log("Starting MokiDown sync in background\u2026");
  for (let i = 0; i < 600; i++) {
    if (spawnError) throw spawnError;
    const started = readState();
    const status = await control(started);
    if (status?.phase === "running") {
      describe(status);
      const token2 = readFileSync3(path2.join(home, "token"), "utf8").trim();
      console.log(`Credential: ${token2}
Use mokidown-sync stop to shut down.`);
      return;
    }
    if (child.exitCode !== null && child.exitCode !== void 0) throw new Error(`Service failed to start; inspect ${logPath}`);
    await pause(100);
  }
  await control(readState(), "stop");
  throw new Error(`Startup timed out; inspect ${logPath}`);
}
main2().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
