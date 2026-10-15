import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { collection, defineService, resource } from "@/index.ts";

const Item = z.object({ id: z.string(), v: z.number() });

const build = (sideEffects?: Parameters<typeof resource>[0]["sideEffects"]) =>
  defineService({
    name: "t",
    seed: { items: [{ id: "1", v: 1 }] },
    resources: { items: resource({ schema: Item, sideEffects }) },
  });

describe("failNext", () => {
  test("per-key consumed FIFO, then handler runs", async () => {
    const svc = build();
    svc.state.failNext("GET /items", 2, { status: 500, body: { boom: true } });
    const first = await svc.app.request("/items");
    expect(first.status).toBe(500);
    expect(await first.json()).toEqual({ boom: true });
    expect((await svc.app.request("/items")).status).toBe(500);
    const third = await svc.app.request("/items");
    expect(third.status).toBe(200);
    expect(await third.json()).toEqual([{ id: "1", v: 1 }]);
  });

  test("per-key beats global; unmatched ops unaffected", async () => {
    const svc = build();
    svc.state.failNext(1, { status: 503 });
    svc.state.failNext("GET /items", 1, { status: 500, body: { keyed: true } });
    const keyed = await svc.app.request("/items");
    expect(keyed.status).toBe(500);
    expect(await keyed.json()).toEqual({ keyed: true });
    const global = await svc.app.request("/items/1");
    expect(global.status).toBe(503);
    expect(await global.json()).toEqual({ error: "injected" });
  });

  test("injected failure skips side effects and read counts", async () => {
    let fired = 0;
    let reads = 0;
    const svc = build({
      "items.delete": () => {
        fired++;
      },
    });
    svc.schedule.afterReads("items", 1, () => {
      reads++;
    });
    svc.state.failNext("DELETE /items/:id", 1, { status: 500 });
    expect(
      (await svc.app.request("/items/1", { method: "DELETE" })).status,
    ).toBe(500);
    expect(fired).toBe(0);
    expect(reads).toBe(0);
    expect(collection(svc.state, "items").get("1")).toEqual({ id: "1", v: 1 });
  });

  test("custom headers pass through; reset clears queues", async () => {
    const svc = build();
    svc.state.failNext("GET /items", 5, {
      status: 429,
      headers: { "retry-after": "7" },
    });
    const res = await svc.app.request("/items");
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("7");
    svc.reset();
    expect((await svc.app.request("/items")).status).toBe(200);
  });

  test("invalid n and status throw", () => {
    const svc = build();
    expect(() => svc.state.failNext(0, { status: 500 })).toThrow(/n >= 1/);
    expect(() => svc.state.failNext("GET /items", 1, { status: 200 })).toThrow(
      /400-599/,
    );
  });
});
