# micromock — Core Library Specification

## 1. Intent

- **Outcome:** Generic TS/Bun-first framework for code-defined, stateful, Dockerized replicas of SaaS APIs over HTTP and WebSocket.
- **User:** TS devs running Testcontainers integration tests against external SaaS SDKs via base-URL / gateway-URL override.
- **Why now:** No standardized way to build Dockerized mock services; ad-hoc mock surface grows per project.
- **Success:** A new SaaS-lite in one small file, SDK-compatible by endpoint swap alone.
- **Constraint:** Replicas work with official npm SDK packages with only the endpoint changed.
- **Out of scope:** Port-range/env autofill (separate repo, separate spec); record/replay; OpenAPI/spec import; dashboard UI; persistence; multi-process scaling; non-TS definitions; voice/sharding/compressed WS encodings.

## 2. Genericity rule

The framework provides transport, state, and test hooks. Replicas define all API and protocol behavior:

- Framework provides: HTTP routing via Hono, typed in-memory collections, seed/reset, generic CRUD scaffolding with overridable defaults, standard auth presets plus custom auth, generic WebSocket upgrade plus session and fan-out, deterministic scheduler, `reset`/`health` routes, `failNext`, container helper.
- Replicas define: status codes, headers, body shapes, error and pagination shapes, auth acceptance and 401/403 bodies, WebSocket frame shapes, close codes, version and encoding handling, subscription and filtering semantics, timing, and all test-specific hooks beyond reset/health.
- Every behavior an SDK branches on MUST be definable from replica code, per route or per message handler.

## 3. Goals

1. One small file defines a stateful mock SaaS: types, operations, side effects, scheduled transitions, auth/middleware, seed data — over HTTP routes, WebSocket endpoints, or both.
2. The definition runs as an HTTP+WS server inside Docker and binds into a Testcontainers suite in ~2 lines.
3. Official SDKs work against the replica with only endpoint/gateway-URL (+ dummy credentials) changed.
4. Per-test isolation: seed once, reset cheaply between tests. `reset()` restores seed, cancels scheduled transitions, and drops all WS connections.
5. Cold boot fast enough for integration suites (target: <1s container-ready on warm images).

## 4. Non-goals (v1)

- Record/replay from real APIs, VCR cassettes.
- OpenAPI/spec import or codegen.
- Hosted dashboard UI; the `__micromock` namespace is reserved for framework routes.
- Multi-language SDKs — TS/Bun definitions only; any HTTP or WebSocket client can consume the running mock.
- Persistence across restarts, multi-process scaling.
- Production use. Test infrastructure; no hardening, no persistence guarantees.

## 5. Core concepts

| Concept | Meaning |
|---|---|
| `Service` | One mock SaaS: name, resources, gateways, middleware, seed, scheduler. Builds to one Docker image, one container. Wraps a Hono app. |
| `Resource` | A typed collection (e.g. `repos`, `zones`, `messages`) with generic auto-CRUD plus custom operations. Schemas are zod schemas. |
| `Operation` | A Hono route handler with injected `{ state, schedule, gateways }`. Mutations are visible to later reads (stateful). Bodies are read with Hono `c.req.*`. |
| `Side effect` | Hook fired by an operation: update another resource, schedule a transition, fail conditionally. Inline in handlers or a `sideEffects` map. |
| `Scheduler` | Framework-owned deterministic clock: `after(ms, fn)` for time-driven transitions and `afterReads(resource, n, fn)` for poll-driven transitions. Cancelled by `reset()`. |
| `Middleware` / auth | Hono middleware. Standard presets (`bearerAuth`, `basicAuth`, `apiKeyAuth`) plus `customAuth(fn)` for full control of acceptance and failure responses. |
| `Seed` | Initial data declared alongside the service; loaded at boot, restorable via reset, overridable per suite via `withSeed`. |
| `Gateway` | A generic stateful WebSocket endpoint: `path` plus `onOpen` / `onMessage` / `onClose`. Frame parsing, protocol states, and reply shapes live in replica handlers. |
| `Connection` | One WS client session: `id`, per-connection scratch (`get`/`set`), `send(payload)`, `close(code?, reason?)`. `reset()` drops all connections. |
| `Broadcast` | `gateways.<name>.broadcast(payload, filter?)` — in-memory fan-out to live connections with a replica-owned `filter(conn)` predicate. Fire-and-forget; slow clients never block HTTP handlers. Drops on backpressure are counted for assertions. |

## 6. Proposed API (sketch, normative for DX shape)

```ts
import { defineService, resource, bearerAuth, customAuth } from "micromock";
import { z } from "zod";

const Repo = z.object({ id: z.string(), name: z.string(), private: z.boolean() });

const github = defineService({
  name: "github-lite",
  seed: {
    repos: [{ id: "1", name: "demo", private: false }],
    issues: [],
  },
  auth: bearerAuth({ tokens: ["test-token"] }),
  // Full-control form:
  // auth: customAuth((c) => c.req.header("authorization") === "Bearer test-token"),
  resources: {
    repos: resource({
      schema: Repo,
      operations: (r) => ({
        ...r.crud(),
        "POST /repos/:id/star": (c) => {
          const { state } = c.get("mock");
          state.repos.update(c.req.param("id"), { starred: true });
          return c.json({ starred: true });
        },
      }),
      sideEffects: {
        "repos.delete": ({ state, entity }) => {
          state.issues.deleteWhere((i) => i.repoId === entity.id);
        },
      },
    }),
  },
  extraRoutes: (app) => {
    app.get("/rate_limit", (c) => c.json({ resources: { core: { remaining: 9999 } } }));
  },
});

export default github;
```

### Gateway sketch

```ts
import { defineService, gateway } from "micromock";

const realtime = defineService({
  name: "realtime-lite",
  gateways: {
    socket: gateway({
      path: "/socket",
      onOpen: ({ conn }) => {
        conn.set("authenticated", false);
      },
      onMessage: ({ conn, msg }) => {
        const frame = JSON.parse(String(msg));
        if (frame.type === "auth") {
          if (frame.token !== "test-token") return conn.close(4004, "auth failed");
          conn.set("authenticated", true);
          conn.set("topics", frame.topics ?? []);
          return conn.send(JSON.stringify({ type: "ready", sessionId: conn.id }));
        }
      },
      onClose: ({ conn }) => {},
    }),
  },
  resources: {
    messages: resource({
      schema: Message,
      operations: (r, { gateways }) => ({
        ...r.crud(),
        "POST /channels/:id/messages": async (c) => {
          const { state } = c.get("mock");
          const body = await c.req.json();
          const msg = state.messages.create({ channelId: c.req.param("id"), ...body });
          gateways.socket.broadcast(
            JSON.stringify({ type: "message_create", data: msg }),
            (conn) => conn.get("topics")?.includes(`channel:${msg.channelId}`) ?? false,
          );
          return c.json(msg, 201);
        },
      }),
    }),
  },
  extraRoutes: (app) => {
    app.post("/__test/dispatch", async (c) => {
      const { gateways } = c.get("mock");
      const payload = await c.req.json();
      gateways.socket.broadcast(JSON.stringify(payload.event), () => true);
      return c.json({ ok: true });
    });
  },
});
```

Notes:

- `r.crud()` generates collection routes: `GET` list, `GET` one, `POST`, `PATCH`, `DELETE`. Generic defaults (`200`/`201`/`204`, `404 { error: "not_found" }`, `400 { error: "validation_failed", issues }`), each overridable per operation. Provider-specific shapes are built in replica code via custom operations or `extraRoutes`.
- Handlers are Hono handlers with `c.get("mock")` giving `{ state, schedule, gateways }`. They mutate `state` directly — no ORM, no migrations.
- Bodies use Hono directly: `c.req.json()`, `c.req.text()`, `c.req.arrayBuffer()`, `c.req.parseBody()` for forms and multipart with `File` values, `c.req.query()` / `c.req.param()` / `c.req.header()`. Size caps use Hono `bodyLimit` middleware in `extraRoutes`.
- Auth: `bearerAuth` / `basicAuth` use Hono's `bearer-auth` / `basic-auth` middleware. `apiKeyAuth({ header?, query? })` checks `c.req`. `customAuth(fn)` takes `(c) => boolean | Response | Promise<boolean | Response>`; returning `false` yields the generic 401, returning a `Response` sends any custom status and body.
- Every service exposes `POST /__micromock/reset` (restore seed, cancel scheduler, drop WS connections) and `GET /__micromock/health`. The `__micromock` namespace is reserved.
- HTTP and gateways share the same `state`: REST handlers can `broadcast` to WS connections; gateway handlers can mutate resources.
- Scheduler: `schedule.after(ms, fn)` for time-driven transitions, `schedule.afterReads(resource, n, fn)` for poll-driven transitions, both on a per-service deterministic clock cancelled by `reset()`.
- `failNext(n, shape)` provides per-operation error injection for retry and error-path tests. Status, body, and headers come from the replica.

## 7. State model

- In-memory typed collections: `state.<resource>.list/get/create/update/delete/deleteWhere`.
- Single-process, no persistence across restarts. Seed loaded at boot; reset restores seed.
- Sequential handler execution per container is acceptable in v1 (tests are the only client). Parallel-test isolation means one container per test file/worker, not shared state.
- Deterministic IDs: auto-increment or caller-supplied; no random IDs unless the real API returns opaque ones (prefix those, e.g. `mock_`).
- WS sessions hold per-connection scratch (`conn.get/set`). Subscription tracking, sequence numbers, and replay behavior are replica state when the protocol needs them.
- Delivery is in-memory fan-out via `broadcast(payload, filter?)` with no ordering guarantees beyond handler call order. Fire-and-forget; drops on backpressure are counted for assertions.

## 8. Docker / Testcontainers integration

- Per-service build with `bun build`, content-hash cached:

```dockerfile
FROM oven/bun:distroless
COPY ./dist/service.js ./service.js
CMD ["bun", "./service.js"]
```

- Testcontainers binding helper (exact import path TBD; `testcontainers` as peer dep):

```ts
const mock = await new MicromockContainer("./mocks/github-lite.ts")
  .withSeed({ repos: [...] })
  .start();
octokit = new Octokit({ baseUrl: mock.baseUrl(), auth: "test-token" });
afterAll(() => mock.stop());
// per-test: await mock.reset();
```

- `withSeed` override plus `reset()` provide per-test isolation. Boot uses a wait strategy on `/__micromock/health`.
- The WS endpoint override per SDK (constructor option, env var, or proxy) is recorded in each replica file header.

## 9. SDK-compat strategy

- Compat means: the official SDK exercises its paths against the mock with only endpoint/gateway-URL (+ dummy credentials) changed, and assertions on SDK-returned objects and events hold, including WS events triggered by REST calls.
- Each replica ships with a compat test using the real SDK as acceptance proof. The override point is recorded in the replica file header.
- Raw status, header, and body control plus `extraRoutes` and `failNext` cover provider quirks and error paths.
- Per-replica deltas (what the replica does not emulate, such as webhooks, cursors beyond page 1, or binary encodings) are documented in the replica file header.

## 10. Decisions

1. **Schema/validation:** zod as a direct dependency. `crud()` validates bodies against the resource schema.
2. **Routing core:** Hono. The service is a Hono app. WS upgrade uses `@hono/bun` (`createBunWebSocket`).
3. **Image build story:** `bun build` per-service image with content-hash caching.
4. **Workflow primitive:** imperative handlers plus side-effect hooks plus the deterministic scheduler (`after` / `afterReads`).
5. **Package exports:** `micromock` root exports `defineService`, `resource`, `gateway`, `bearerAuth`, `basicAuth`, `apiKeyAuth`, `customAuth`, `MicromockContainer`.
6. **WS core:** `@hono/bun` upgrade with a framework session and fan-out layer (`Connection` plus `broadcast(filter)` plus `reset()` dropping connections). Gateway handlers stay transport-agnostic.
7. **Bodies/transports:** handlers use Hono `c.req.json() / text() / arrayBuffer() / parseBody()` directly, covering JSON, forms, multipart, and file uploads.

## 11. Acceptance criteria

- [ ] A `github-lite` reference replica (repos + issues + bearer auth + cascade delete + seed) fits in ≤100 lines, boots in Docker, and passes a compat test using `octokit` with only `baseUrl` overridden.
- [ ] A second replica with a different API shape (e.g. Cloudflare zones+dns with api-key auth) passes its SDK compat test against the same primitives.
- [ ] A WS reference replica (REST writes plus gateway auth, message fan-out, and token-to-close-code auth, ≤150 lines, all protocol shapes defined in replica code) passes a compat test where the real SDK client receives a gateway event triggered by a REST call with only endpoint/gateway-URL overridden.
- [ ] `reset()` restores seed, cancels scheduled transitions, and drops WS connections between tests; `failNext` drives at least one SDK error-path test.
- [ ] `schedule.after` drives at least one time-based transition test; `schedule.afterReads` drives at least one poll-based transition test.
- [ ] Test-suite binding is ≤5 lines of setup per suite (container start + baseUrl + reset hook).
- [ ] README documents: defining a service, seed/reset, auth presets plus `customAuth`, bodies via Hono, gateway plus `broadcast`, scheduler, SDK-compat deltas, Dockerfile (`bun build`), Testcontainers binding.

## 12. Explicitly deferred

Dashboard UI, record/replay, OpenAPI import, persistence, multi-process scaling, non-TS definition languages, gateway sharding/voice/compressed encodings (ETF/zlib-stream).
