import type { Handler, Hono, MiddlewareHandler } from "hono";

export type SafeParseResultish =
  | { success: true; data: unknown; error?: never }
  | { success: false; data?: never; error: { issues: unknown[] } };

export interface ResourceSchema {
  safeParse(data: unknown): SafeParseResultish;
}

export type Entity = { id: string } & Record<string, unknown>;

export interface Collection<T extends { id: string }> {
  list(): T[];
  get(id: string): T | undefined;
  create(data: Record<string, unknown>): T;
  update(id: string, patch: Record<string, unknown>): T | undefined;
  delete(id: string): boolean;
  deleteWhere(pred: (entity: T) => boolean): number;
  __allocateId(): string;
}

export interface FailShape {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface MockStateMethods {
  failNext(opKey: string, n: number, shape: FailShape): void;
  failNext(n: number, shape: FailShape): void;
  consumeFailure(opKey: string): Response | undefined;
  withSeed(patch: Record<string, unknown[]>): MockState;
  resetState(): void;
  __ensureCollection(name: string): void;
  __baseline: Record<string, unknown[]>;
  __counters: Record<string, number>;
}

export type MockState = Record<string, Collection<Entity>> & MockStateMethods;

export interface Scheduler {
  after(ms: number, fn: (ctx: MockContext) => void | Promise<void>): () => void;
  afterReads(
    resource: string,
    n: number,
    fn: (ctx: MockContext) => void | Promise<void>,
  ): () => void;
  countRead(resource: string): void;
  cancelAll(): void;
}

export interface MockContext {
  state: MockState;
  schedule: Scheduler;
  gateways: GatewayRegistry;
}

export type MockEnv = { Variables: { mock: MockContext } };

export interface Connection {
  readonly id: string;
  get<T>(key: string): T | undefined;
  set(key: string, value: unknown): void;
  send(data: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
}

export interface GatewayHandle {
  broadcast(
    payload: string | ArrayBuffer,
    filter?: (conn: Connection) => boolean,
  ): void;
  readonly size: number;
  readonly droppedCount: number;
}

export type GatewayRegistry = Record<string, GatewayHandle>;

export interface GatewayCtx {
  conn: Connection;
  state: MockState;
  schedule: Scheduler;
  gateways: GatewayRegistry;
}

export interface GatewayDef {
  path: string;
  onOpen?: (ctx: GatewayCtx) => void | Promise<void>;
  onMessage?: (
    ctx: GatewayCtx & { msg: string | ArrayBuffer },
  ) => void | Promise<void>;
  onClose?: (
    ctx: GatewayCtx & { code?: number; reason?: string },
  ) => void | Promise<void>;
}

export interface CrudHelpers {
  crud(): Record<string, Handler<MockEnv>>;
}

export type SideEffectFn = (
  ctx: MockContext & { entity: Entity },
) => void | Promise<void>;

export interface ResourceDef {
  schema: ResourceSchema;
  operations?: (
    r: CrudHelpers,
    ctx: { gateways: GatewayRegistry },
  ) => Record<string, Handler<MockEnv>>;
  sideEffects?: Record<string, SideEffectFn>;
}

export interface ServiceDefinition {
  name: string;
  seed?: Record<string, unknown[]>;
  auth?: MiddlewareHandler;
  resources?: Record<string, ResourceDef>;
  gateways?: Record<string, GatewayDef>;
  extraRoutes?: (app: Hono<MockEnv>) => void;
}

export interface Service {
  readonly name: string;
  readonly honoApp: Hono<MockEnv>;
  readonly state: MockState;
  readonly schedule: Scheduler;
  readonly gateways: GatewayRegistry;
  handleRequest(request: Request): Response | Promise<Response>;
  withSeed(patch: Record<string, unknown[]>): this;
  reset(): void;
  start(port?: number): StartedService;
}

export interface StartedService {
  port: number;
  url: string;
  close(): void;
}

export interface StartedMock {
  baseUrl(): string;
  wsUrl(path?: string): string;
  reset(): Promise<void>;
  stop(): Promise<void>;
}
