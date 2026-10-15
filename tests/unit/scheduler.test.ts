import { afterEach, describe, expect, test, vi } from "bun:test";
import { z } from "zod";
import { collection, defineService, resource } from "@/index.ts";

const Item = z.object({ id: z.string(), v: z.number() });

const build = () =>
  defineService({
    name: "t",
    seed: { items: [{ id: "1", v: 1 }] },
    resources: { items: resource({ schema: Item }) },
  });

afterEach(() => {
  vi.useRealTimers();
});

describe("scheduler", () => {
  test("after fires with shared-state visibility, cancel stops it", () => {
    vi.useFakeTimers();
    const svc = build();
    let seen: unknown;
    svc.schedule.after(5, ({ state }) => {
      seen = collection(state, "items").get("1");
    });
    vi.advanceTimersByTime(5);
    expect(seen).toEqual({ id: "1", v: 1 });

    let hits = 0;
    const cancel = svc.schedule.after(5, () => {
      hits++;
    });
    cancel();
    vi.advanceTimersByTime(50);
    expect(hits).toBe(0);
  });

  test("after rejects bad ms", () => {
    const svc = build();
    expect(() => svc.schedule.after(-1, () => {})).toThrow(/ms >= 0/);
    expect(() => svc.schedule.after(Number.NaN, () => {})).toThrow(/ms >= 0/);
    expect(() => svc.schedule.afterReads("items", 0, () => {})).toThrow(
      /n >= 1/,
    );
  });

  test("afterReads counts list+one only, fires once, 404 never counts", async () => {
    const svc = build();
    let hits = 0;
    svc.schedule.afterReads("items", 2, () => {
      hits++;
    });
    await svc.app.request("/items");
    expect(hits).toBe(0);
    await svc.app.request("/items/1");
    expect(hits).toBe(1);
    await svc.app.request("/items");
    await svc.app.request("/items/1");
    expect(hits).toBe(1);

    let miss = 0;
    svc.schedule.afterReads("items", 1, () => {
      miss++;
    });
    await svc.app.request("/items/nope");
    expect(miss).toBe(0);
  });

  test("reset disarms timers and watchers", async () => {
    vi.useFakeTimers();
    const svc = build();
    let timer = 0;
    let reads = 0;
    svc.schedule.after(5, () => {
      timer++;
    });
    svc.schedule.afterReads("items", 1, () => {
      reads++;
    });
    svc.reset();
    vi.advanceTimersByTime(50);
    await svc.app.request("/items");
    expect(timer).toBe(0);
    expect(reads).toBe(0);
  });
});
