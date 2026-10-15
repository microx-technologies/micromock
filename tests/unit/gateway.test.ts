import { describe, expect, test } from "vitest";
import WebSocket from "ws";
import { z } from "zod";
import { defineService, gateway, resource } from "@/index.ts";

const Item = z.object({ id: z.string(), v: z.number() });

const build = () =>
  defineService({
    name: "t",
    seed: { items: [{ id: "1", v: 1 }] },
    resources: { items: resource({ schema: Item }) },
    gateways: {
      socket: gateway({
        path: "/socket",
        onOpen: ({ conn }) => {
          conn.set("topics", []);
          conn.send(JSON.stringify({ type: "open", id: conn.id }));
        },
        onMessage: ({ conn, msg }) => {
          const frame = JSON.parse(String(msg)) as { topics?: string[] };
          conn.set("topics", frame.topics ?? []);
        },
      }),
    },
  });

const queues = new WeakMap<WebSocket, string[]>();

const waiters = new WeakMap<WebSocket, Array<(msg: string) => void>>();

function listen(ws: WebSocket): void {
  if (queues.has(ws)) return;
  queues.set(ws, []);
  waiters.set(ws, []);
  ws.on("message", (data) => {
    const msg = String(data);
    const next = waiters.get(ws)?.shift();
    if (next !== undefined) next(msg);
    else queues.get(ws)?.push(msg);
  });
}

async function nextMessage(ws: WebSocket): Promise<string> {
  listen(ws);
  const queue = queues.get(ws) as string[];
  const shifted = queue.shift();
  if (shifted !== undefined) return shifted;
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  (waiters.get(ws) as Array<(msg: string) => void>).push(resolve);
  ws.once("error", reject);
  return promise;
}

async function openClient(
  port: number,
  topics: string[],
): Promise<{ ws: WebSocket; open: string }> {
  const ws = new WebSocket(`ws://localhost:${port}/socket`);
  listen(ws);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  const open = await nextMessage(ws);
  ws.send(JSON.stringify({ topics }));
  return { ws, open };
}

const pause = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

describe("gateway runtime", () => {
  test("topics filter isolates fan-out; close removes connection", async () => {
    const svc = build();
    const srv = svc.start(0);
    try {
      const a = await openClient(srv.port, ["channel:1"]);
      const b = await openClient(srv.port, ["channel:2"]);
      expect(a.open).toContain("conn_");
      const socket = svc.gateways.socket;
      if (socket === undefined) throw new Error("missing gateway");
      expect(socket.size).toBe(2);

      socket.broadcast("to-1", (conn) =>
        (conn.get<string[]>("topics") ?? []).includes("channel:1"),
      );
      expect(await nextMessage(a.ws)).toBe("to-1");
      b.ws.close();
      for (let i = 0; i < 50 && socket.size !== 1; i++) await pause(10);
      expect(socket.size).toBe(1);

      a.ws.close();
    } finally {
      srv.close();
    }
  });

  test("reset drops all connections and zeroes drops", async () => {
    const svc = build();
    const srv = svc.start(0);
    try {
      const { ws } = await openClient(srv.port, []);
      const socket = svc.gateways.socket;
      if (socket === undefined) throw new Error("missing gateway");
      expect(socket.size).toBe(1);
      svc.reset();
      expect(socket.size).toBe(0);
      expect(socket.droppedCount).toBe(0);
      ws.close();
    } finally {
      srv.close();
    }
  });

  test("non-upgrade GET on gateway path is 400", async () => {
    const svc = build();
    const res = await svc.honoApp.request("/socket");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "expected_websocket" });
  });
});
