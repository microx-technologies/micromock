import { ID_PREFIX } from "@/src/constants.ts";
import type { Collection, Entity, FailShape, MockState } from "@/src/types.ts";

interface FailRule {
  remaining: number;
  shape: FailShape;
}

export function createCollection<T extends { id: string }>(
  name: string,
): Collection<T> {
  const items = new Map<string, T>();
  let counter = 1;

  const allocateId = (): string => {
    let id = `${ID_PREFIX}${counter++}`;
    while (items.has(id)) id = `${ID_PREFIX}${counter++}`;
    return id;
  };

  return {
    list: () => [...items.values()],

    get: (id) => items.get(id),

    create: (data) => {
      const id = data.id;
      const entity =
        id === undefined
          ? ({ ...data, id: allocateId() } as T)
          : typeof id === "string" && id.length > 0
            ? ({ ...data } as T)
            : null;
      if (entity === null) {
        throw new Error(`micromock: ${name}.create requires string id`);
      }
      items.set(entity.id, entity);
      return entity;
    },

    update: (id, patch) => {
      const current = items.get(id);
      if (current === undefined) return undefined;
      if ("id" in patch && patch.id !== id) {
        throw new Error(`micromock: ${name}.update id mismatch`);
      }
      const next = { ...current, ...patch, id } as T;
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

    __allocateId: allocateId,
  };
}

export function createState(seed: Record<string, unknown[]> = {}): MockState {
  const collections: Record<string, Collection<Entity>> = {};
  const baseline: Record<string, unknown[]> = {};
  const counters: Record<string, number> = {};
  const perKey: Record<string, FailRule[]> = {};
  const global: FailRule[] = [];

  const load = (name: string, rows: unknown[]): void => {
    const col = createCollection<Entity>(name);
    for (const row of rows) {
      if (typeof row !== "object" || row === null || Array.isArray(row)) {
        throw new Error(`micromock: seed row for "${name}" must be an object`);
      }
      col.create(row as Record<string, unknown>);
    }
    collections[name] = col;
    baseline[name] = structuredClone(rows);
    counters[name] = 1;
  };

  for (const [name, rows] of Object.entries(seed)) load(name, rows);

  const validateShape = (n: number, shape: FailShape): void => {
    if (!Number.isInteger(n) || n < 1) {
      throw new Error("micromock: failNext requires n >= 1");
    }
    if (
      !Number.isInteger(shape.status) ||
      shape.status < 400 ||
      shape.status > 599
    ) {
      throw new Error("micromock: failNext status must be 400-599");
    }
  };

  const state = {
    failNext(
      opKeyOrN: string | number,
      nOrShape: number | FailShape,
      maybeShape?: FailShape,
    ): void {
      if (typeof opKeyOrN === "string") {
        if (typeof nOrShape !== "number" || maybeShape === undefined) {
          throw new Error(
            "micromock: failNext(opKey, n, shape) requires n and shape",
          );
        }
        validateShape(nOrShape, maybeShape);
        const queue = perKey[opKeyOrN];
        if (queue === undefined)
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

    consumeFailure(opKey: string): Response | undefined {
      const queue =
        (perKey[opKey] !== undefined && perKey[opKey].length > 0
          ? perKey[opKey]
          : undefined) ?? (global.length > 0 ? global : undefined);
      if (queue === undefined) return undefined;
      const rule = queue[0];
      if (rule === undefined) return undefined;
      rule.remaining--;
      if (rule.remaining === 0) queue.shift();
      const body =
        rule.shape.body === undefined ? { error: "injected" } : rule.shape.body;
      return new Response(JSON.stringify(body), {
        status: rule.shape.status,
        headers: { "content-type": "application/json", ...rule.shape.headers },
      });
    },

    withSeed(patch: Record<string, unknown[]>): MockState {
      for (const [name, rows] of Object.entries(patch)) {
        if (!(name in collections)) {
          throw new Error(`micromock: withSeed unknown resource "${name}"`);
        }
        load(name, rows);
      }
      return proxied;
    },

    resetState(): void {
      for (const [name, rows] of Object.entries(baseline)) {
        load(name, rows);
      }
      for (const key of Object.keys(perKey)) delete perKey[key];
      global.length = 0;
    },

    __ensureCollection(name: string): void {
      if (!(name in collections)) load(name, []);
    },

    __baseline: baseline,
    __counters: counters,
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
    },
  }) as unknown as MockState;
  return proxied;
}
