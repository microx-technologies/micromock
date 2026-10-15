import type { Context, Handler } from "hono";
import { z } from "zod";
import {
  ERR_INVALID_JSON,
  ERR_NOT_FOUND,
  ERR_VALIDATION,
} from "@/constants.ts";
import type {
  Collection,
  CrudHelpers,
  Entity,
  MockContext,
  MockEnv,
  MockState,
  ResourceDef,
  ResourceSchema,
  SideEffectFn,
} from "@/types.ts";

const OP_METHODS = ["GET", "POST", "PATCH", "PUT", "DELETE"] as const;
type OpMethod = (typeof OP_METHODS)[number];
const OP_METHOD_LIST: readonly string[] = OP_METHODS;

function isOpMethod(method: string): method is OpMethod {
  return OP_METHOD_LIST.includes(method);
}

export function parseOpKey(key: string): { method: OpMethod; path: string } {
  const space = key.indexOf(" ");
  const method = space === -1 ? "" : key.slice(0, space);
  const path = space === -1 ? "" : key.slice(space + 1);
  if (space === -1 || !isOpMethod(method) || !path.startsWith("/")) {
    throw new Error(`micromock: bad operation key "${key}"`);
  }
  return { method, path };
}

export function invalidJson(c: Context): Response {
  return c.json({ error: ERR_INVALID_JSON }, 400);
}

export async function readJsonBody(
  c: Context,
): Promise<{ ok: true; body: unknown } | { ok: false; response: Response }> {
  let raw: string;
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
        400,
      ),
    };
  }
  try {
    return { ok: true, body: JSON.parse(raw) };
  } catch {
    return { ok: false, response: invalidJson(c) };
  }
}

function collectionNameOf(key: string): string {
  const dot = key.indexOf(".");
  const action = dot === -1 ? "" : key.slice(dot + 1);
  if (
    dot === -1 ||
    (action !== "create" && action !== "update" && action !== "delete")
  ) {
    throw new Error(`micromock: bad side-effect key "${key}"`);
  }
  return key.slice(0, dot);
}

function fireSideEffect(
  sideEffects: Record<string, SideEffectFn> | undefined,
  key: string,
  ctx: MockContext & { entity: Entity },
): void {
  const fn = sideEffects?.[key];
  if (fn !== undefined) void fn(ctx);
}

function collectionOf(state: MockState, name: string): Collection<Entity> {
  const collection = state[name];
  if (collection === undefined) {
    throw new Error(`micromock: unknown resource "${name}"`);
  }
  return collection;
}

interface ShapedSchema extends ResourceSchema {
  shape: Record<string, unknown>;
}

interface PartialableSchema extends ResourceSchema {
  partial(): ResourceSchema;
}

function isShapedSchema(schema: ResourceSchema): schema is ShapedSchema {
  return (
    typeof schema === "object" &&
    schema !== null &&
    "shape" in schema &&
    typeof schema.shape === "object" &&
    schema.shape !== null
  );
}

function isPartialableSchema(
  schema: ResourceSchema,
): schema is PartialableSchema {
  return (
    typeof schema === "object" &&
    schema !== null &&
    "partial" in schema &&
    typeof schema.partial === "function"
  );
}

export function assertResourceSchema(schema: ResourceSchema): void {
  if (!isShapedSchema(schema) || !(schema.shape.id instanceof z.ZodString)) {
    throw new Error(
      'micromock: resource schema must be a Zod object with a string "id" field',
    );
  }
}

export function collection(state: MockState, name: string): Collection<Entity> {
  return collectionOf(state, name);
}

export function resource(def: {
  schema: ResourceSchema;
  operations?: ResourceDef["operations"];
  sideEffects?: Record<string, SideEffectFn>;
}): ResourceDef {
  assertResourceSchema(def.schema);
  if (def.sideEffects !== undefined) {
    for (const key of Object.keys(def.sideEffects)) collectionNameOf(key);
  }
  return {
    schema: def.schema,
    operations: def.operations,
    sideEffects: def.sideEffects,
  };
}

function isObjectBody(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function objectBody(
  c: Context,
  body: unknown,
): Record<string, unknown> | Response {
  if (!isObjectBody(body)) {
    return c.json(
      { error: ERR_VALIDATION, issues: [{ message: "object body required" }] },
      400,
    );
  }
  return body;
}

export function buildCrud(
  name: string,
  schema: ResourceSchema,
  sideEffects: Record<string, SideEffectFn> | undefined,
): Record<string, Handler<MockEnv>> {
  const base = `/${name}`;
  const one = `/${name}/:id`;

  const list: Handler<MockEnv> = (c) => {
    const { state, schedule } = c.get("mock");
    const rows = collectionOf(state, name).list();
    schedule.countRead(name);
    return c.json(rows);
  };

  const getOne: Handler<MockEnv> = (c) => {
    const { state, schedule } = c.get("mock");
    const entity = collectionOf(state, name).get(c.req.param("id") ?? "");
    if (entity === undefined) return c.json({ error: ERR_NOT_FOUND }, 404);
    schedule.countRead(name);
    return c.json(entity);
  };

  const create: Handler<MockEnv> = async (c) => {
    const { state, schedule, gateways } = c.get("mock");
    const parsed = await readJsonBody(c);
    if (!parsed.ok) return parsed.response;
    const input = objectBody(c, parsed.body);
    if (input instanceof Response) return input;
    const collection = collectionOf(state, name);
    if (input.id === undefined) {
      input.id = collection.__allocateId();
    }
    const result = schema.safeParse(input);
    if (!result.success) {
      return c.json(
        { error: ERR_VALIDATION, issues: result.error.issues },
        400,
      );
    }
    if (!isObjectBody(result.data)) {
      return c.json(
        {
          error: ERR_VALIDATION,
          issues: [{ message: "object body required" }],
        },
        400,
      );
    }
    const entity = collection.create(result.data);
    fireSideEffect(sideEffects, `${name}.create`, {
      state,
      schedule,
      gateways,
      entity,
    });
    return c.json(entity, 201);
  };

  const patch: Handler<MockEnv> = async (c) => {
    const { state, schedule, gateways } = c.get("mock");
    const id = c.req.param("id") ?? "";
    const collection = collectionOf(state, name);
    const current = collection.get(id);
    if (current === undefined) return c.json({ error: ERR_NOT_FOUND }, 404);
    const parsed = await readJsonBody(c);
    if (!parsed.ok) return parsed.response;
    const input = objectBody(c, parsed.body);
    if (input instanceof Response) return input;
    if ("id" in input && input.id !== id) {
      return c.json(
        { error: ERR_VALIDATION, issues: [{ message: "id mismatch" }] },
        400,
      );
    }
    if (!isPartialableSchema(schema)) {
      throw new Error("micromock: resource schema does not support partial()");
    }
    const result = schema.partial().safeParse(input);
    if (!result.success) {
      return c.json(
        { error: ERR_VALIDATION, issues: result.error.issues },
        400,
      );
    }
    if (!isObjectBody(result.data)) {
      return c.json(
        {
          error: ERR_VALIDATION,
          issues: [{ message: "object body required" }],
        },
        400,
      );
    }
    const entity = collection.update(id, result.data);
    if (entity === undefined) return c.json({ error: ERR_NOT_FOUND }, 404);
    fireSideEffect(sideEffects, `${name}.update`, {
      state,
      schedule,
      gateways,
      entity,
    });
    return c.json(entity);
  };

  const remove: Handler<MockEnv> = async (c) => {
    const { state, schedule, gateways } = c.get("mock");
    const id = c.req.param("id") ?? "";
    const collection = collectionOf(state, name);
    const current = collection.get(id);
    if (current === undefined) return c.json({ error: ERR_NOT_FOUND }, 404);
    collection.delete(id);
    fireSideEffect(sideEffects, `${name}.delete`, {
      state,
      schedule,
      gateways,
      entity: current,
    });
    return c.body(null, 204);
  };

  return {
    [`GET ${base}`]: list,
    [`GET ${one}`]: getOne,
    [`POST ${base}`]: create,
    [`PATCH ${one}`]: patch,
    [`DELETE ${one}`]: remove,
  };
}

export function crudHelpers(
  name: string,
  schema: ResourceSchema,
  sideEffects: Record<string, SideEffectFn> | undefined,
): CrudHelpers {
  return { crud: () => buildCrud(name, schema, sideEffects) };
}
