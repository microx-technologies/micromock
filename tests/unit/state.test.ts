import { describe, expect, test } from "bun:test";
import { z } from "zod";
import type { MockState } from "@/src/index.ts";
import { collection, defineService, resource } from "@/src/index.ts";

const Item = z.object({ id: z.string(), v: z.number() });

const build = (seed: Record<string, unknown[]> = {}) =>
  defineService({
    name: "t",
    seed,
    resources: { items: resource({ schema: Item }) },
  });

const itemsOf = (state: MockState) => collection(state, "items");

describe("state collections", () => {
  test("auto ids sequence and skip collisions", () => {
    const svc = build({ items: [{ id: "mock_1", v: 0 }] });
    expect(itemsOf(svc.state).create({ v: 1 }).id).toBe("mock_2");
    expect(itemsOf(svc.state).create({ v: 2 }).id).toBe("mock_3");
  });

  test("update id mismatch throws, missing returns undefined", () => {
    const svc = build({ items: [{ id: "1", v: 1 }] });
    expect(() => itemsOf(svc.state).update("1", { id: "2" })).toThrow(
      /id mismatch/,
    );
    expect(itemsOf(svc.state).update("nope", { v: 2 })).toBeUndefined();
    expect(itemsOf(svc.state).get("nope")).toBeUndefined();
  });

  test("deleteWhere counts removals", () => {
    const svc = build({
      items: [
        { id: "1", v: 1 },
        { id: "2", v: 2 },
      ],
    });
    expect(itemsOf(svc.state).deleteWhere((e) => e.v === 1)).toBe(1);
    expect(itemsOf(svc.state).list()).toHaveLength(1);
  });

  test("withSeed unknown key throws, reset restores seed and counters", () => {
    const svc = build({ items: [{ id: "1", v: 1 }] });
    expect(() => svc.withSeed({ nope: [] })).toThrow(/unknown resource/);
    svc.withSeed({ items: [{ id: "9", v: 9 }] });
    itemsOf(svc.state).create({ v: 10 });
    svc.reset();
    expect(itemsOf(svc.state).list()).toEqual([{ id: "9", v: 9 }]);
    expect(itemsOf(svc.state).create({ v: 11 }).id).toBe("mock_1");
  });

  test("create without string id throws", () => {
    const svc = build();
    expect(() => itemsOf(svc.state).create({ id: 5, v: 1 })).toThrow(
      /requires string id/,
    );
  });
});
