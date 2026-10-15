import { describe, expect, test, vi } from "bun:test";
import WebSocket from "ws";
import { z } from "zod";
import { collection, defineService, gateway, resource } from "@/src/index.ts";

const Item = z.object({ id: z.string(), v: z.number() });

const build = () =>
  defineService({
    name: "t",
    seed: { items: [{ id: "1", v: 1 }] },
    resources: { items: resource({ schema: Item }) },
    gateways: { socket: gateway({ path: "/socket" }) },
  });

describe("reset", () => {
  test("restores seed, cancels scheduler, drops WS connections in one scenario", async () => {
    vi.useFakeTimers();
    const svc = build();
    const srv = svc.start(0);
    try {
      collection(svc.state, "items").create({ v: 99 });
      let timer = 0;
      let reads = 0;
      svc.schedule.after(10, () => {
        timer++;
      });
      svc.schedule.afterReads("items", 1, () => {
        reads++;
      });
      const ws = new WebSocket(`ws://localhost:${srv.port}/socket`);
      await new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("error", reject);
      });
      const socket = svc.gateways.socket;
      if (socket === undefined) throw new Error("missing gateway");
      expect(socket.size).toBe(1);
      const closed = Promise.withResolvers<[number, string]>();
      ws.once("close", (code, reason) =>
        closed.resolve([code, String(reason)]),
      );
      vi.useRealTimers();

      const res = await fetch(`${srv.url}/__micromock/reset`, {
        method: "POST",
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });

      expect(collection(svc.state, "items").list()).toEqual([
        { id: "1", v: 1 },
      ]);
      vi.useFakeTimers();
      vi.advanceTimersByTime(50);
      await svc.app.request("/items");
      expect(timer).toBe(0);
      expect(reads).toBe(0);
      vi.useRealTimers();
      expect(socket.size).toBe(0);
      expect(await closed.promise).toEqual([1000, "micromock reset"]);
      ws.close();
    } finally {
      vi.useRealTimers();
      srv.close();
    }
  });
});
