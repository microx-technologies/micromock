# micromock

Code-defined, stateful, Dockerized replicas of SaaS APIs for integration tests. Node-first, Bun-compatible.

Define a service in one file, run it in Docker via Testcontainers, point the official SDK at it by overriding the endpoint URL. Per-test isolation via seed and reset. Test infrastructure only — no persistence, no hardening.

## Requirements

- Node >= 22 (`node --version`), or Bun >= 1.0 (`bun --version`) for Bun-compat mode
- Docker running (`docker info`)
- Linux or macOS. `MicromockContainer` binds a container per suite; one container per test file or worker, not shared state.

## Install

This package is not on npm. Install from GitHub:

```sh
# pnpm
pnpm add github:microx-technologies/micromock#v0.1.0

# bun
bun add github:microx-technologies/micromock#v0.1.0
```

Replace `microx-technologies/micromock` with the fork if you use one. Use a different tag for a different version:

```sh
# pnpm
pnpm add github:microx-technologies/micromock#v0.2.0

# bun
bun add github:microx-technologies/micromock#v0.2.0
```

The published tarball contains `dist/`, `Dockerfile.tmpl`, `README.md`, `LICENSE`. `prepack` builds `dist/` automatically; a pinned tag includes a CI-built `micromock-*.tgz` as a fallback if you prefer a file install:

```sh
# pnpm
pnpm add ./micromock-0.1.0.tgz

# bun
bun add ./micromock-0.1.0.tgz
```

`testcontainers` is a peer dependency — install it in your project:

```sh
# pnpm
pnpm add -D testcontainers

# bun
bun add -d testcontainers
```

## Define a service

```ts
// mocks/github-lite.ts
import { customAuth, defineService, resource } from "micromock";
import { z } from "zod";

const Repo = z.object({
  id: z.string(),
  name: z.string(),
  private: z.boolean(),
});

const github = defineService({
  name: "github-lite",
  seed: { repos: [{ id: "1", name: "demo", private: false }] },
  auth: customAuth(
    (c) => c.req.header("authorization") === "Bearer test-token",
  ),
  resources: {
    repos: resource({ schema: Repo }),
  },
});

export default github;
```

Rules:

- `name` is required. Resource names must not contain `/` or spaces. `__micromock` is reserved.
- Resource schemas must be zod objects with a string `id` field. `crud()` validates bodies against the schema.
- `r.crud()` generates `GET` list, `GET` one, `POST`, `PATCH`, `DELETE`. Override any operation by redefining its `"METHOD /path"` key. Custom keys must match `"METHOD /path"` with a valid method and leading `/`.
- Handlers are Hono handlers. Read bodies with `c.req.json()` / `text()` / `arrayBuffer()` / `parseBody()`. State via `c.get("mock")` → `{ state, schedule, gateways }`.
- Run standalone with `if (isMainModule(import.meta.url)) github.start();` (`isMainModule` from `micromock`; works under Node and Bun). `start(port?)` uses `PORT` env or 3000. `start(0)` binds an ephemeral port for tests. Run `.ts` mocks via `tsx` (handles tsconfig `@/*` aliases) or `bun`; plain `node` needs a loader for path aliases.

## Seed and reset

```ts
const github = defineService({
  name: "github-lite",
  seed: { repos: [{ id: "1", name: "demo", private: false }] },
  // ...
});
```

- `seed` loads at boot. Keys not declared default to `[]`.
- `withSeed(patch)` replaces seed data (in-container via `MICROMOCK_SEED`, or locally before `start`).
- `reset()` restores seed, cancels scheduled transitions, drops all WebSocket connections.
- Every service exposes `POST /__micromock/reset` and `GET /__micromock/health`.

## Auth

```ts
import { apiKeyAuth, basicAuth, bearerAuth, customAuth } from "micromock";

defineService({
  // ...
  auth: bearerAuth({ tokens: ["test-token"] }),
});
```

- `bearerAuth({ tokens })` — non-empty token list, 401 `{ error: "unauthorized" }` on mismatch.
- `basicAuth({ username, password })` or `basicAuth({ pairs: [...] })`.
- `apiKeyAuth({ keys, header?, query? })` — defaults `x-api-key` header, `api_key` query param.
- `customAuth((c) => ...)` — return `true`/`false`, or a full `Response` for custom status and body. Anything else throws. Returning `false` yields the generic 401.
- Auth skips `POST /__micromock/reset` and `GET /__micromock/health`.

## Bodies, side effects, error injection

```ts
import { collection, resource } from "micromock";

const repos = resource({
  schema: Repo,
  operations: (r) => ({
    ...r.crud(),
    "POST /repos/:id/star": (c) => {
      const { state } = c.get("mock");
      const all = collection(state, "repos");
      const repo = all.get(c.req.param("id") ?? "");
      if (repo === undefined) return c.json({ error: "not_found" }, 404);
      all.update(repo.id, { starred: true });
      return c.json({ starred: true });
    },
  }),
  sideEffects: {
    "repos.delete": ({ state, entity }) => {
      collection(state, "issues").deleteWhere((i) => i.repoId === entity.id);
    },
  },
});
```

- `collection(state, name)` throws on unknown resource. Collection API: `list/get/create/update/delete/deleteWhere`. Deletes return 204. Missing rows return 404 `{ error: "not_found" }`. Invalid bodies return 400 `{ error: "validation_failed", issues }`.
- `sideEffects` keys are `"<resource>.create | .update | .delete"`.
- `state.failNext(opKey, n, shape)` fails the next `n` calls to one operation (`"GET /repos"`) with `{ status, body?, headers? }`. `state.failNext(n, shape)` without an op key applies to the next operation of any kind. Use it for SDK error-path tests.

## Gateways (WebSocket)

```ts
import { defineService, gateway, resource } from "micromock";

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
          if (frame.token !== "test-token")
            return conn.close(4004, "auth failed");
          conn.set("authenticated", true);
          conn.set("topics", frame.topics ?? []);
          return conn.send(
            JSON.stringify({ type: "ready", sessionId: conn.id }),
          );
        }
      },
      onClose: () => {},
    }),
  },
  resources: { messages: resource({ schema: Message }) },
});
```

- `gateway({ path })` requires a leading `/`. `onMessage` receives `msg: string | ArrayBuffer`. Frame parsing, protocol states, close codes are replica code.
- `conn` has `id` (`conn_` prefix), `get`/`set` scratch, `send`, `close(code?, reason?)`.
- REST handlers broadcast via `gateways.<name>.broadcast(payload, filter?)`. Filter on `conn.get(...)` for subscriptions. Fire-and-forget; backpressure drops are counted on `droppedCount` for assertions.
- `reset()` drops all connections. Gateway paths bypass auth middleware only for framework routes; gateways authenticate in `onMessage` like the example above.

## Scheduler

```ts
// inside any handler, via c.get("mock").schedule:
schedule.after(50, ({ state }) => {
  state.repos.update(id, { status: "ready" });
});
schedule.afterReads("repos", 3, ({ state }) => {
  state.repos.update(id, { status: "ready" });
});
```

- `after(ms, fn)` for time-driven transitions, `afterReads(resource, n, fn)` for poll-driven ones. Both cancelled by `reset()`. `after` requires `ms >= 0`; `afterReads` requires `n >= 1`.

## Testcontainers binding

```ts
import { MicromockContainer } from "micromock";
import { Octokit } from "octokit";

const mock = await new MicromockContainer("./mocks/github-lite.ts")
  .withSeed({ repos: [{ id: "s1", name: "seeded", private: true }] })
  .start();

const octokit = new Octokit({ baseUrl: mock.baseUrl(), auth: "test-token" });

// per test:
await mock.reset();

// teardown:
await mock.stop();
```

- `serviceFile` must end in `.ts`. Relative paths resolve against the process working directory. The file is bundled with esbuild into the image, so it must be self-contained.
- `baseUrl()` for HTTP SDKs, `wsUrl(path?)` for gateway clients. `reset()` POSTs to `/__micromock/reset` and throws on non-2xx. Container readiness waits on `GET /__micromock/health` with a 30s startup timeout.
- Images are content-hashed (`micromock-<name>:<hash>`) and cached. Image cache markers live in the OS temp dir; Docker's own image cache is reused across suites.

## SDK compat notes

Only override the endpoint URL and credentials. Deltas per bundled replica:

- `mocks/github-lite.ts` — Octokit via `baseUrl`. Custom bearer check accepts `Bearer` and `token` schemes. `rate_limit` stubbed. Cascade delete on `repos.delete` removes child issues.
- `mocks/cloudflare-lite.ts` — `cloudflare` SDK via `baseURL` plus `apiKey`/`apiEmail`. Auth header `X-Auth-Key`. List endpoints return only page 1 (`result_info` included); later pages return `[]`.
- `mocks/realtime-lite.ts` — plain `ws` client. Token `test-token` in an `{"type":"auth"}` frame; bad token closes with `4004`. REST `POST /channels/:id/messages` fans out `message_create` to subscribers of `channel:<id>`.

## Reference

- `defineService({ name, seed?, auth?, resources?, gateways?, extraRoutes? })` → `Service { name, honoApp, state, schedule, gateways, handleRequest, withSeed, reset, start }`
- `resource({ schema, operations?, sideEffects? })`, `gateway({ path, onOpen?, onMessage?, onClose? })`
- `bearerAuth`, `basicAuth`, `apiKeyAuth`, `customAuth`
- `collection(state, name)`, `readJsonBody(c)` (`{ ok: true, body } | { ok: false, response }`)
- `MicromockContainer`, `buildImage`, `ephemeralPort`
- `GET /__micromock/health` → `{ ok: true, name }`; `POST /__micromock/reset` → `{ ok: true }`

Defaults: CRUD `200` / `201` on create / `204` on delete; `404 { error: "not_found" }`; `400 { error: "validation_failed", issues }`; `401 { error: "unauthorized" }`; auto IDs `mock_<n>`; connection IDs `conn_<n>`.

## Develop

```sh
# pnpm
pnpm install
pnpm run build
pnpm test
pnpm run check   # biome + tsc

# bun
bun install
bun run build
bun run test
bun run check   # biome + tsc
```

Release: bump `version` in `package.json`, push tag `v<version>` (e.g. `v0.1.0`). CI verifies the tag matches `package.json`, builds, tests, packs, and publishes a GitHub release with the tarball and generated notes.

## License

AGPL-3.0. See `LICENSE`.
