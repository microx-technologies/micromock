import { upgradeWebSocket } from "@hono/bun";
import type { Handler } from "hono";
import { Hono } from "hono";
import type { WSContext } from "hono/ws";
import { FRAMEWORK_NS, HEALTH_PATH, RESET_PATH } from "@/src/constants.ts";
import type { ManagedConnection, ManagedGateway } from "@/src/gateway.ts";
import { GatewayRuntime, runGatewayHandler } from "@/src/gateway.ts";
import {
  buildCrud,
  crudHelpers,
  parseOpKey,
  resource,
} from "@/src/resource.ts";
import { createScheduler } from "@/src/scheduler.ts";
import { startService } from "@/src/serve.ts";
import { createState } from "@/src/state.ts";
import type {
  GatewayDef,
  GatewayRegistry,
  MockContext,
  MockEnv,
  MockState,
  ResourceDef,
  Scheduler,
  Service,
  ServiceDefinition,
} from "@/src/types.ts";

export { resource };

export function gateway(def: GatewayDef): GatewayDef {
  if (!def.path.startsWith("/")) {
    throw new Error('micromock: gateway path must start with "/"');
  }
  return def;
}

function toArrayBuffer(
  message: string | ArrayBufferLike,
): string | ArrayBuffer {
  if (typeof message === "string") return message;
  if (message instanceof ArrayBuffer) return message.slice(0);
  return new Uint8Array(message).slice().buffer;
}

function rawOf(ws: WSContext): unknown {
  if ("raw" in ws && typeof ws.raw === "object" && ws.raw !== null)
    return ws.raw;
  return undefined;
}

export function defineService(def: ServiceDefinition): Service {
  if (def.name.length === 0) {
    throw new Error("micromock: service name is required");
  }
  if (def.resources !== undefined && "__micromock" in def.resources) {
    throw new Error('micromock: resource name "__micromock" is reserved');
  }
  for (const key of Object.keys(def.resources ?? {})) {
    if (key.length === 0 || key.includes("/") || key.includes(" ")) {
      throw new Error(`micromock: bad resource name "${key}"`);
    }
  }

  const seed: Record<string, unknown[]> = def.seed ?? {};
  for (const key of Object.keys(def.resources ?? {})) {
    seed[key] ??= [];
  }
  const state: MockState = createState(seed);

  const ctxHolder: { current: MockContext } = { current: undefined as never };
  const schedule: Scheduler = createScheduler(() => ctxHolder.current);
  const runtime = new GatewayRuntime(def.gateways);
  const gateways: GatewayRegistry = runtime.registry();
  ctxHolder.current = { state, schedule, gateways };

  const app = new Hono<MockEnv>();
  app.use("/*", async (c, next) => {
    c.set("mock", ctxHolder.current);
    await next();
  });
  if (def.auth !== undefined) {
    const auth = def.auth;
    app.use("/*", async (c, next) => {
      if (c.req.path.startsWith(`${FRAMEWORK_NS}/`)) {
        await next();
        return;
      }
      return auth(c, next);
    });
  }

  for (const [name, resourceDef] of Object.entries(def.resources ?? {})) {
    const helpers = crudHelpers(
      name,
      resourceDef.schema,
      resourceDef.sideEffects,
    );
    const custom = resourceDef.operations?.(helpers, { gateways }) ?? {};
    const merged: Record<string, Handler<MockEnv>> = {
      ...buildCrud(name, resourceDef.schema, resourceDef.sideEffects),
    };
    for (const [key, handler] of Object.entries(custom)) {
      parseOpKey(key);
      merged[key] = handler;
    }
    for (const [key, handler] of Object.entries(merged)) {
      const { method, path } = parseOpKey(key);
      const wrapped: Handler<MockEnv> = (c, next) => {
        const failure = state.consumeFailure(key);
        if (failure !== undefined) return failure;
        return handler(c, next);
      };
      app.on(method, path, wrapped);
    }
  }

  def.extraRoutes?.(app);

  for (const gw of Object.values(runtime.gateways)) {
    registerGateway(app, gw, ctxHolder);
  }

  const name = def.name;
  app.get(HEALTH_PATH, (c) => c.json({ ok: true, name }));
  app.post(RESET_PATH, (c) => {
    service.reset();
    return c.json({ ok: true });
  });

  const service: Service = {
    name,
    app,
    state,
    schedule,
    gateways,
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
    },
  };
  return service;
}

function registerGateway(
  app: Hono<MockEnv>,
  gw: ManagedGateway,
  ctxHolder: { current: MockContext },
): void {
  app.get(gw.def.path, (c, next) => {
    if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
      return c.json({ error: "expected_websocket" }, 400);
    }
    return next();
  });
  app.get(
    gw.def.path,
    upgradeWebSocket((_c) => {
      const ctx = ctxHolder.current;
      return {
        onOpen: (_evt, ws: WSContext) => {
          const raw = rawOf(ws);
          const conn: ManagedConnection = gw.open({
            send: (data: string | ArrayBuffer) => ws.send(data),
            close: (code?: number, reason?: string) => ws.close(code, reason),
            tag: raw,
          });
          runGatewayHandler(conn, () => gw.def.onOpen?.({ ...ctx, conn }));
        },
        onMessage: (evt, ws: WSContext) => {
          const conn = gw.byRaw(rawOf(ws));
          if (conn === undefined) return;
          const msg = toArrayBuffer(evt.data as string | ArrayBufferLike);
          runGatewayHandler(conn, () =>
            gw.def.onMessage?.({ ...ctx, conn, msg }),
          );
        },
        onClose: (evt, ws: WSContext) => {
          const conn = gw.byRaw(rawOf(ws));
          if (conn === undefined) return;
          gw.remove(conn);
          runGatewayHandler(conn, () =>
            gw.def.onClose?.({
              ...ctx,
              conn,
              code: (evt as CloseEvent).code,
              reason: (evt as CloseEvent).reason,
            }),
          );
        },
      };
    }),
  );
}

export type { ResourceDef };
