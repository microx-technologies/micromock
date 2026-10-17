// src/auth.ts
import { basicAuth as honoBasicAuth } from "hono/basic-auth";
import { bearerAuth as honoBearerAuth } from "hono/bearer-auth";

// src/constants.ts
var FRAMEWORK_NS = "/__micromock";
var RESET_PATH = "/__micromock/reset";
var HEALTH_PATH = "/__micromock/health";
var ERR_NOT_FOUND = "not_found";
var ERR_VALIDATION = "validation_failed";
var ERR_UNAUTHORIZED = "unauthorized";
var ERR_INVALID_JSON = "invalid_json";
var ID_PREFIX = "mock_";
var CONN_PREFIX = "conn_";
var DEFAULT_PORT = 3e3;
var ENV_PORT = "PORT";
var DEFAULT_API_KEY_HEADER = "x-api-key";
var DEFAULT_API_KEY_QUERY = "api_key";
var WS_RESET_CODE = 1e3;
var WS_RESET_REASON = "micromock reset";
var WS_HANDLER_ERROR_CODE = 1011;
var WS_HANDLER_ERROR_REASON = "handler error";

// src/auth.ts
function unauthorized(c) {
  return c.json({ error: ERR_UNAUTHORIZED }, 401);
}
function bearerAuth({
  tokens
}) {
  if (tokens.length === 0) {
    throw new Error("micromock: bearerAuth requires non-empty tokens");
  }
  const inner = honoBearerAuth({
    verifyToken: (token) => tokens.includes(token),
    invalidToken: { message: { error: ERR_UNAUTHORIZED } },
    noAuthenticationHeader: { message: { error: ERR_UNAUTHORIZED } }
  });
  return async (c, next) => inner(c, next);
}
function basicAuth(opts) {
  if ("pairs" in opts) {
    if (opts.pairs.length === 0) {
      throw new Error("micromock: basicAuth requires non-empty pairs");
    }
    return honoBasicAuth({
      verifyUser: (username, password) => opts.pairs.some(
        (p) => p.username === username && p.password === password
      )
    });
  }
  if (opts.username.length === 0 || opts.password.length === 0) {
    throw new Error(
      "micromock: basicAuth requires non-empty username and password"
    );
  }
  return honoBasicAuth({ username: opts.username, password: opts.password });
}
function apiKeyAuth({
  keys,
  header = DEFAULT_API_KEY_HEADER,
  query = DEFAULT_API_KEY_QUERY
}) {
  if (keys.length === 0) {
    throw new Error("micromock: apiKeyAuth requires non-empty keys");
  }
  const headerName = header.toLowerCase();
  return async (c, next) => {
    const byHeader = c.req.header(headerName);
    const byQuery = query.length > 0 ? c.req.query(query) : void 0;
    if (byHeader !== void 0 && keys.includes(byHeader) || byQuery !== void 0 && keys.includes(byQuery)) {
      await next();
      return;
    }
    return unauthorized(c);
  };
}
function customAuth(fn) {
  return async (c, next) => {
    const verdict = await fn(c);
    if (typeof verdict === "boolean") {
      if (verdict) {
        await next();
        return;
      }
      return unauthorized(c);
    }
    if (verdict instanceof Response) return verdict;
    throw new Error("micromock: customAuth must return boolean or Response");
  };
}

// src/container.ts
import {
  GenericContainer,
  Wait
} from "testcontainers";

// src/docker.ts
import { spawnSync } from "child_process";
import { createHash, randomInt } from "crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile
} from "fs/promises";
import { tmpdir } from "os";
import { dirname, isAbsolute, join, resolve } from "path";
import { build as esbuild } from "esbuild";
async function fileBytes(path) {
  return new Uint8Array(await readFile(path));
}
async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
async function collectTs(root, dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const found = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await collectTs(root, full));
    else if (entry.isFile() && entry.name.endsWith(".ts")) found.push(full);
  }
  return found;
}
async function buildImage(serviceFile) {
  const root = dirname(dirname(__filename));
  const absService = isAbsolute(serviceFile) ? serviceFile : resolve(process.cwd(), serviceFile);
  if (!await exists(absService)) {
    throw new Error(`micromock: service file not found: ${serviceFile}`);
  }
  const hash = createHash("sha256");
  hash.update(await fileBytes(absService));
  try {
    hash.update(await fileBytes(join(root, "dist", "index.js")));
  } catch {
    const files = (await collectTs(root, join(root, "src"))).sort();
    for (const path of files) hash.update(await fileBytes(path));
  }
  hash.update(await fileBytes(join(root, "Dockerfile.tmpl")));
  hash.update(process.version);
  const short = absService.split("/").pop()?.replace(/\.ts$/, "") ?? "service";
  const tag = `micromock-${short}:${hash.digest("hex").slice(0, 8)}`;
  const marker = join(tmpdir(), "micromock", "cache", tag);
  if (await exists(marker)) {
    return { tag, cached: true };
  }
  const inspect = spawnSync("docker", ["image", "inspect", tag]);
  if (inspect.status === 0) {
    await mkdir(dirname(marker), { recursive: true });
    await writeFile(marker, tag, { flag: "w" }).catch(() => void 0);
    return { tag, cached: true };
  }
  const ctx = await mkdtemp(join(tmpdir(), "micromock-"));
  try {
    await writeFile(
      join(ctx, "entry.ts"),
      `import svc from ${JSON.stringify(absService)};
const raw = process.env["MICROMOCK_SEED"];
if (raw !== undefined) svc.withSeed(JSON.parse(raw));
svc.start();
`
    );
    try {
      await esbuild({
        entryPoints: [join(ctx, "entry.ts")],
        bundle: true,
        platform: "node",
        format: "cjs",
        outfile: join(ctx, "dist", "service.cjs"),
        banner: {
          js: "var import_meta_url = 'file:///micromock-bundled-service';"
        },
        define: { "import.meta.url": "import_meta_url" },
        logLevel: "warning"
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`micromock: esbuild bundle failed:
${detail}`);
    }
    const dockerfile = await fileBytes(join(root, "Dockerfile.tmpl"));
    await writeFile(join(ctx, "Dockerfile"), dockerfile);
    const result = spawnSync("docker", ["build", "-t", tag, ctx]);
    if (result.status !== 0) {
      throw new Error(`micromock: docker build failed:
${result.stderr}`);
    }
    await mkdir(dirname(marker), { recursive: true });
    await writeFile(marker, tag, { flag: "w" }).catch(() => void 0);
    return { tag, cached: false };
  } finally {
    await rm(ctx, { recursive: true, force: true });
  }
}
function ephemeralPort() {
  return 32e3 + randomInt(1e3);
}

// src/container.ts
var MicromockContainer = class {
  constructor(serviceFile) {
    this.serviceFile = serviceFile;
    if (!serviceFile.endsWith(".ts")) {
      throw new Error(`micromock: service file must end .ts: ${serviceFile}`);
    }
  }
  serviceFile;
  seedPatch;
  withSeed(patch) {
    this.seedPatch = patch;
    return this;
  }
  async start() {
    const { tag } = await buildImage(this.serviceFile);
    const port = ephemeralPort();
    const container = await new GenericContainer(tag).withExposedPorts(port).withEnvironment({
      PORT: String(port),
      MICROMOCK_SEED: JSON.stringify(this.seedPatch ?? {})
    }).withWaitStrategy(Wait.forHttp(HEALTH_PATH, port)).withStartupTimeout(3e4).start();
    const base = `http://${container.getHost()}:${container.getMappedPort(port)}`;
    return {
      baseUrl: () => base,
      wsUrl: (path = "/") => base.replace(/^http/, "ws") + path,
      reset: async () => {
        const res = await fetch(`${base}${RESET_PATH}`, { method: "POST" });
        if (!res.ok)
          throw new Error(`micromock: reset failed with ${res.status}`);
      },
      stop: async () => {
        await container.stop();
      }
    };
  }
};

// src/resource.ts
import { z } from "zod";
var OP_METHODS = ["GET", "POST", "PATCH", "PUT", "DELETE"];
var OP_METHOD_LIST = OP_METHODS;
function isOpMethod(method) {
  return OP_METHOD_LIST.includes(method);
}
function parseOpKey(key) {
  const space = key.indexOf(" ");
  const method = space === -1 ? "" : key.slice(0, space);
  const path = space === -1 ? "" : key.slice(space + 1);
  if (space === -1 || !isOpMethod(method) || !path.startsWith("/")) {
    throw new Error(`micromock: bad operation key "${key}"`);
  }
  return { method, path };
}
function invalidJson(c) {
  return c.json({ error: ERR_INVALID_JSON }, 400);
}
async function readJsonBody(c) {
  let raw;
  try {
    raw = await c.req.text();
  } catch {
    return { ok: false, response: invalidJson(c) };
  }
  if (raw.length === 0) {
    return {
      ok: false,
      response: c.json(
        { error: ERR_VALIDATION, issues: [{ message: "empty body" }] },
        400
      )
    };
  }
  try {
    return { ok: true, body: JSON.parse(raw) };
  } catch {
    return { ok: false, response: invalidJson(c) };
  }
}
function collectionNameOf(key) {
  const dot = key.indexOf(".");
  const action = dot === -1 ? "" : key.slice(dot + 1);
  if (dot === -1 || action !== "create" && action !== "update" && action !== "delete") {
    throw new Error(`micromock: bad side-effect key "${key}"`);
  }
  return key.slice(0, dot);
}
function fireSideEffect(sideEffects, key, ctx) {
  const fn = sideEffects?.[key];
  if (fn !== void 0) void fn(ctx);
}
function collectionOf(state, name) {
  const collection2 = state[name];
  if (collection2 === void 0) {
    throw new Error(`micromock: unknown resource "${name}"`);
  }
  return collection2;
}
function isShapedSchema(schema) {
  return typeof schema === "object" && schema !== null && "shape" in schema && typeof schema.shape === "object" && schema.shape !== null;
}
function isPartialableSchema(schema) {
  return typeof schema === "object" && schema !== null && "partial" in schema && typeof schema.partial === "function";
}
function assertResourceSchema(schema) {
  if (!isShapedSchema(schema) || !(schema.shape.id instanceof z.ZodString)) {
    throw new Error(
      'micromock: resource schema must be a Zod object with a string "id" field'
    );
  }
}
function collection(state, name) {
  return collectionOf(state, name);
}
function resource(def) {
  assertResourceSchema(def.schema);
  if (def.sideEffects !== void 0) {
    for (const key of Object.keys(def.sideEffects)) collectionNameOf(key);
  }
  return {
    schema: def.schema,
    operations: def.operations,
    sideEffects: def.sideEffects
  };
}
function isObjectBody(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function objectBody(c, body) {
  if (!isObjectBody(body)) {
    return c.json(
      { error: ERR_VALIDATION, issues: [{ message: "object body required" }] },
      400
    );
  }
  return body;
}
function buildCrud(name, schema, sideEffects) {
  const base = `/${name}`;
  const one = `/${name}/:id`;
  const list = (c) => {
    const { state, schedule } = c.get("mock");
    const rows = collectionOf(state, name).list();
    schedule.countRead(name);
    return c.json(rows);
  };
  const getOne = (c) => {
    const { state, schedule } = c.get("mock");
    const entity = collectionOf(state, name).get(c.req.param("id") ?? "");
    if (entity === void 0) return c.json({ error: ERR_NOT_FOUND }, 404);
    schedule.countRead(name);
    return c.json(entity);
  };
  const create = async (c) => {
    const { state, schedule, gateways } = c.get("mock");
    const parsed = await readJsonBody(c);
    if (!parsed.ok) return parsed.response;
    const input = objectBody(c, parsed.body);
    if (input instanceof Response) return input;
    const collection2 = collectionOf(state, name);
    if (input.id === void 0) {
      input.id = collection2.__allocateId();
    }
    const result = schema.safeParse(input);
    if (!result.success) {
      return c.json(
        { error: ERR_VALIDATION, issues: result.error.issues },
        400
      );
    }
    if (!isObjectBody(result.data)) {
      return c.json(
        {
          error: ERR_VALIDATION,
          issues: [{ message: "object body required" }]
        },
        400
      );
    }
    const entity = collection2.create(result.data);
    fireSideEffect(sideEffects, `${name}.create`, {
      state,
      schedule,
      gateways,
      entity
    });
    return c.json(entity, 201);
  };
  const patch = async (c) => {
    const { state, schedule, gateways } = c.get("mock");
    const id = c.req.param("id") ?? "";
    const collection2 = collectionOf(state, name);
    const current = collection2.get(id);
    if (current === void 0) return c.json({ error: ERR_NOT_FOUND }, 404);
    const parsed = await readJsonBody(c);
    if (!parsed.ok) return parsed.response;
    const input = objectBody(c, parsed.body);
    if (input instanceof Response) return input;
    if ("id" in input && input.id !== id) {
      return c.json(
        { error: ERR_VALIDATION, issues: [{ message: "id mismatch" }] },
        400
      );
    }
    if (!isPartialableSchema(schema)) {
      throw new Error("micromock: resource schema does not support partial()");
    }
    const result = schema.partial().safeParse(input);
    if (!result.success) {
      return c.json(
        { error: ERR_VALIDATION, issues: result.error.issues },
        400
      );
    }
    if (!isObjectBody(result.data)) {
      return c.json(
        {
          error: ERR_VALIDATION,
          issues: [{ message: "object body required" }]
        },
        400
      );
    }
    const entity = collection2.update(id, result.data);
    if (entity === void 0) return c.json({ error: ERR_NOT_FOUND }, 404);
    fireSideEffect(sideEffects, `${name}.update`, {
      state,
      schedule,
      gateways,
      entity
    });
    return c.json(entity);
  };
  const remove = async (c) => {
    const { state, schedule, gateways } = c.get("mock");
    const id = c.req.param("id") ?? "";
    const collection2 = collectionOf(state, name);
    const current = collection2.get(id);
    if (current === void 0) return c.json({ error: ERR_NOT_FOUND }, 404);
    collection2.delete(id);
    fireSideEffect(sideEffects, `${name}.delete`, {
      state,
      schedule,
      gateways,
      entity: current
    });
    return c.body(null, 204);
  };
  return {
    [`GET ${base}`]: list,
    [`GET ${one}`]: getOne,
    [`POST ${base}`]: create,
    [`PATCH ${one}`]: patch,
    [`DELETE ${one}`]: remove
  };
}
function crudHelpers(name, schema, sideEffects) {
  return { crud: () => buildCrud(name, schema, sideEffects) };
}

// src/service.ts
import { Hono } from "hono";

// src/gateway.ts
var ManagedConnection = class {
  constructor(id, gateway2, raw) {
    this.gateway = gateway2;
    this.id = id;
    this.raw = raw;
  }
  gateway;
  id;
  store = /* @__PURE__ */ new Map();
  raw;
  closed = false;
  get(key) {
    return this.store.get(key);
  }
  set(key, value) {
    this.store.set(key, value);
  }
  send(data) {
    if (this.closed || this.raw === void 0) {
      this.gateway.countDrop();
      return;
    }
    try {
      this.raw.send(data);
    } catch {
      this.gateway.countDrop();
    }
  }
  close(code = 1e3, reason = "") {
    if (!Number.isInteger(code) || code < 1e3 || code > 4999) {
      throw new Error(`micromock: close code must be 1000-4999, got ${code}`);
    }
    this.closed = true;
    this.raw?.close(code, reason);
    this.gateway.remove(this);
  }
};
var ManagedGateway = class {
  constructor(name, def) {
    this.name = name;
    if (!def.path.startsWith("/")) {
      throw new Error(`micromock: gateway "${name}" path must start with "/"`);
    }
    this.def = def;
  }
  name;
  conns = /* @__PURE__ */ new Map();
  def;
  counter = 1;
  drops = 0;
  get size() {
    return this.conns.size;
  }
  get droppedCount() {
    return this.drops;
  }
  countDrop() {
    this.drops++;
  }
  remove(conn) {
    this.conns.delete(conn.id);
  }
  byId(id) {
    return this.conns.get(id);
  }
  byRaw(raw) {
    if (raw === void 0) return void 0;
    for (const conn of this.conns.values()) {
      if (conn.raw?.tag === raw) return conn;
    }
    return void 0;
  }
  open(raw) {
    const conn = new ManagedConnection(
      `${CONN_PREFIX}${this.counter++}`,
      this,
      raw
    );
    this.conns.set(conn.id, conn);
    return conn;
  }
  broadcast(payload, filter) {
    for (const conn of [...this.conns.values()]) {
      if (filter !== void 0 && !filter(conn)) continue;
      conn.send(payload);
    }
  }
  reset(reason = WS_RESET_REASON, code = WS_RESET_CODE) {
    for (const conn of [...this.conns.values()]) {
      conn.closed = true;
      try {
        conn.raw?.close(code, reason);
      } catch {
        this.drops++;
      }
    }
    this.conns.clear();
    this.drops = 0;
    this.counter = 1;
  }
};
var GatewayRuntime = class {
  gateways = {};
  constructor(defs = {}) {
    for (const [name, def] of Object.entries(defs)) {
      this.gateways[name] = new ManagedGateway(name, def);
    }
  }
  registry() {
    return this.gateways;
  }
  gateway(name) {
    const gateway2 = this.gateways[name];
    if (gateway2 === void 0) {
      throw new Error(`micromock: unknown gateway "${name}"`);
    }
    return gateway2;
  }
  resetAll() {
    for (const gateway2 of Object.values(this.gateways)) gateway2.reset();
  }
};
function handlerError(conn) {
  try {
    conn.close(WS_HANDLER_ERROR_CODE, WS_HANDLER_ERROR_REASON);
  } catch {
  }
}
function runGatewayHandler(conn, invoke) {
  let result;
  try {
    result = invoke();
  } catch {
    handlerError(conn);
    return;
  }
  if (result instanceof Promise) {
    result.catch(() => handlerError(conn));
  }
}

// src/scheduler.ts
function createScheduler(getCtx) {
  const timers = /* @__PURE__ */ new Set();
  const watchers = /* @__PURE__ */ new Set();
  return {
    after: (ms, fn) => {
      if (!Number.isFinite(ms) || ms < 0) {
        throw new Error("micromock: after requires ms >= 0");
      }
      const timer = setTimeout(() => {
        timers.delete(timer);
        void fn(getCtx());
      }, ms);
      timers.add(timer);
      return () => {
        clearTimeout(timer);
        timers.delete(timer);
      };
    },
    afterReads: (resource2, n, fn) => {
      if (!Number.isInteger(n) || n < 1) {
        throw new Error("micromock: afterReads requires n >= 1");
      }
      const watcher = { resource: resource2, remaining: n, armed: true, fn };
      watchers.add(watcher);
      return () => {
        watcher.armed = false;
        watchers.delete(watcher);
      };
    },
    countRead: (resource2) => {
      for (const watcher of [...watchers]) {
        if (!watcher.armed || watcher.resource !== resource2) continue;
        watcher.remaining--;
        if (watcher.remaining > 0) continue;
        watcher.armed = false;
        watchers.delete(watcher);
        void watcher.fn(getCtx());
      }
    },
    cancelAll: () => {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      for (const watcher of watchers) watcher.armed = false;
      watchers.clear();
    }
  };
}

// src/serve.ts
import { pathToFileURL } from "url";
import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
function isMainModule(metaUrl) {
  const entry = process.argv[1];
  if (entry === void 0) return false;
  return pathToFileURL(entry).href === metaUrl;
}
function startService(service, port) {
  const requested = port ?? Number(process.env[ENV_PORT] ?? DEFAULT_PORT);
  if (!Number.isInteger(requested) || requested < 0 || requested > 65535) {
    throw new Error(`micromock: bad port ${requested}`);
  }
  const gateways = Object.values(
    service.gateways
  ).filter((gw) => typeof gw.open === "function");
  const byPath = /* @__PURE__ */ new Map();
  for (const gw of gateways) byPath.set(gw.def.path, gw);
  const wss = new WebSocketServer({ noServer: true });
  const server = serve({ fetch: service.honoApp.fetch, port: requested });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const gw = byPath.get(url.pathname);
    if (gw === void 0) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const conn = gw.open({
        send: (data) => ws.send(data),
        close: (code, reason) => ws.close(code, reason),
        tag: ws
      });
      const ctx = {
        state: service.state,
        schedule: service.schedule,
        gateways: service.gateways
      };
      runGatewayHandler(conn, () => gw.def.onOpen?.({ ...ctx, conn }));
      ws.on("message", (raw, isBinary) => {
        if (conn.closed) return;
        const msg = toMessage(raw, isBinary);
        runGatewayHandler(
          conn,
          () => gw.def.onMessage?.({ ...ctx, conn, msg })
        );
      });
      ws.on("close", (code, reason) => {
        gw.remove(conn);
        runGatewayHandler(
          conn,
          () => gw.def.onClose?.({
            ...ctx,
            conn,
            code,
            reason: reason.toString()
          })
        );
      });
    });
  });
  const address = server.address();
  const bound = typeof address === "object" && address !== null ? address.port : requested;
  return {
    port: bound,
    url: `http://localhost:${bound}`,
    close: () => server.close()
  };
}
function toMessage(raw, isBinary) {
  if (raw instanceof ArrayBuffer)
    return isBinary ? raw.slice(0) : Buffer.from(raw).toString();
  const buf = Array.isArray(raw) ? Buffer.concat(raw) : raw;
  if (!isBinary) return buf.toString();
  const copy = new Uint8Array(buf.byteLength);
  copy.set(buf);
  return copy.buffer;
}

// src/state.ts
function createCollection(name) {
  const items = /* @__PURE__ */ new Map();
  let counter = 1;
  const allocateId = () => {
    let id = `${ID_PREFIX}${counter++}`;
    while (items.has(id)) id = `${ID_PREFIX}${counter++}`;
    return id;
  };
  return {
    list: () => [...items.values()],
    get: (id) => items.get(id),
    create: (data) => {
      const id = data.id;
      const entity = id === void 0 ? { ...data, id: allocateId() } : typeof id === "string" && id.length > 0 ? { ...data } : null;
      if (entity === null) {
        throw new Error(`micromock: ${name}.create requires string id`);
      }
      items.set(entity.id, entity);
      return entity;
    },
    update: (id, patch) => {
      const current = items.get(id);
      if (current === void 0) return void 0;
      if ("id" in patch && patch.id !== id) {
        throw new Error(`micromock: ${name}.update id mismatch`);
      }
      const next = { ...current, ...patch, id };
      items.set(id, next);
      return next;
    },
    delete: (id) => items.delete(id),
    deleteWhere: (pred) => {
      let removed = 0;
      for (const [id, entity] of items) {
        if (pred(entity)) {
          items.delete(id);
          removed++;
        }
      }
      return removed;
    },
    __allocateId: allocateId
  };
}
function createState(seed = {}) {
  const collections = {};
  const baseline = {};
  const counters = {};
  const perKey = {};
  const global = [];
  const load = (name, rows) => {
    const col = createCollection(name);
    for (const row of rows) {
      if (typeof row !== "object" || row === null || Array.isArray(row)) {
        throw new Error(`micromock: seed row for "${name}" must be an object`);
      }
      col.create(row);
    }
    collections[name] = col;
    baseline[name] = structuredClone(rows);
    counters[name] = 1;
  };
  for (const [name, rows] of Object.entries(seed)) load(name, rows);
  const validateShape = (n, shape) => {
    if (!Number.isInteger(n) || n < 1) {
      throw new Error("micromock: failNext requires n >= 1");
    }
    if (!Number.isInteger(shape.status) || shape.status < 400 || shape.status > 599) {
      throw new Error("micromock: failNext status must be 400-599");
    }
  };
  const state = {
    failNext(opKeyOrN, nOrShape, maybeShape) {
      if (typeof opKeyOrN === "string") {
        if (typeof nOrShape !== "number" || maybeShape === void 0) {
          throw new Error(
            "micromock: failNext(opKey, n, shape) requires n and shape"
          );
        }
        validateShape(nOrShape, maybeShape);
        const queue = perKey[opKeyOrN];
        if (queue === void 0)
          perKey[opKeyOrN] = [{ remaining: nOrShape, shape: maybeShape }];
        else queue.push({ remaining: nOrShape, shape: maybeShape });
        return;
      }
      if (typeof nOrShape !== "object" || nOrShape === null) {
        throw new Error("micromock: failNext(n, shape) requires shape");
      }
      validateShape(opKeyOrN, nOrShape);
      global.push({ remaining: opKeyOrN, shape: nOrShape });
    },
    consumeFailure(opKey) {
      const queue = (perKey[opKey] !== void 0 && perKey[opKey].length > 0 ? perKey[opKey] : void 0) ?? (global.length > 0 ? global : void 0);
      if (queue === void 0) return void 0;
      const rule = queue[0];
      if (rule === void 0) return void 0;
      rule.remaining--;
      if (rule.remaining === 0) queue.shift();
      const body = rule.shape.body === void 0 ? { error: "injected" } : rule.shape.body;
      return new Response(JSON.stringify(body), {
        status: rule.shape.status,
        headers: { "content-type": "application/json", ...rule.shape.headers }
      });
    },
    withSeed(patch) {
      for (const [name, rows] of Object.entries(patch)) {
        if (!(name in collections)) {
          throw new Error(`micromock: withSeed unknown resource "${name}"`);
        }
        load(name, rows);
      }
      return proxied;
    },
    resetState() {
      for (const [name, rows] of Object.entries(baseline)) {
        load(name, rows);
      }
      for (const key of Object.keys(perKey)) delete perKey[key];
      global.length = 0;
    },
    __ensureCollection(name) {
      if (!(name in collections)) load(name, []);
    },
    __baseline: baseline,
    __counters: counters
  };
  const proxied = new Proxy(state, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && prop in collections) {
        return collections[prop];
      }
      return Reflect.get(target, prop, receiver);
    },
    has(_target, prop) {
      return typeof prop === "string" && (prop in collections || prop in state);
    }
  });
  return proxied;
}

// src/service.ts
function gateway(def) {
  if (!def.path.startsWith("/")) {
    throw new Error('micromock: gateway path must start with "/"');
  }
  return def;
}
function defineService(def) {
  if (def.name.length === 0) {
    throw new Error("micromock: service name is required");
  }
  if (def.resources !== void 0 && "__micromock" in def.resources) {
    throw new Error('micromock: resource name "__micromock" is reserved');
  }
  for (const key of Object.keys(def.resources ?? {})) {
    if (key.length === 0 || key.includes("/") || key.includes(" ")) {
      throw new Error(`micromock: bad resource name "${key}"`);
    }
  }
  const seed = def.seed ?? {};
  for (const key of Object.keys(def.resources ?? {})) {
    seed[key] ??= [];
  }
  const state = createState(seed);
  const ctxHolder = { current: void 0 };
  const schedule = createScheduler(() => ctxHolder.current);
  const runtime = new GatewayRuntime(def.gateways);
  const gateways = runtime.registry();
  ctxHolder.current = { state, schedule, gateways };
  const app = new Hono();
  app.use("/*", async (c, next) => {
    c.set("mock", ctxHolder.current);
    await next();
  });
  if (def.auth !== void 0) {
    const auth = def.auth;
    app.use("/*", async (c, next) => {
      if (c.req.path.startsWith(`${FRAMEWORK_NS}/`)) {
        await next();
        return;
      }
      return auth(c, next);
    });
  }
  for (const [name2, resourceDef] of Object.entries(def.resources ?? {})) {
    const helpers = crudHelpers(
      name2,
      resourceDef.schema,
      resourceDef.sideEffects
    );
    const custom = resourceDef.operations?.(helpers, { gateways }) ?? {};
    const merged = {
      ...buildCrud(name2, resourceDef.schema, resourceDef.sideEffects)
    };
    for (const [key, handler] of Object.entries(custom)) {
      parseOpKey(key);
      merged[key] = handler;
    }
    for (const [key, handler] of Object.entries(merged)) {
      const { method, path } = parseOpKey(key);
      const wrapped = (c, next) => {
        const failure = state.consumeFailure(key);
        if (failure !== void 0) return failure;
        return handler(c, next);
      };
      app.on(method, path, wrapped);
    }
  }
  def.extraRoutes?.(app);
  for (const gw of Object.values(runtime.gateways)) {
    registerGateway(app, gw);
  }
  const name = def.name;
  app.get(HEALTH_PATH, (c) => c.json({ ok: true, name }));
  app.post(RESET_PATH, (c) => {
    service.reset();
    return c.json({ ok: true });
  });
  const service = {
    name,
    honoApp: app,
    state,
    schedule,
    gateways,
    handleRequest: (request) => app.fetch(request),
    withSeed(patch) {
      state.withSeed(patch);
      schedule.cancelAll();
      runtime.resetAll();
      return service;
    },
    reset() {
      state.resetState();
      schedule.cancelAll();
      runtime.resetAll();
    },
    start(port) {
      return startService(service, port);
    }
  };
  return service;
}
function registerGateway(app, gw) {
  app.get(gw.def.path, (c) => c.json({ error: "expected_websocket" }, 400));
}
export {
  MicromockContainer,
  apiKeyAuth,
  basicAuth,
  bearerAuth,
  buildImage,
  collection,
  customAuth,
  defineService,
  gateway,
  isMainModule,
  resource
};
//# sourceMappingURL=index.js.map