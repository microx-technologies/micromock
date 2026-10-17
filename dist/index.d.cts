import { MiddlewareHandler, Context, Handler, Hono } from 'hono';

declare function bearerAuth({ tokens, }: {
    tokens: string[];
}): MiddlewareHandler;
type BasicAuthOptions = {
    username: string;
    password: string;
} | {
    pairs: Array<{
        username: string;
        password: string;
    }>;
};
declare function basicAuth(opts: BasicAuthOptions): MiddlewareHandler;
declare function apiKeyAuth({ keys, header, query, }: {
    keys: string[];
    header?: string;
    query?: string;
}): MiddlewareHandler;
declare function customAuth(fn: (c: Context) => boolean | Response | Promise<boolean | Response>): MiddlewareHandler;

type SafeParseResultish = {
    success: true;
    data: unknown;
    error?: never;
} | {
    success: false;
    data?: never;
    error: {
        issues: unknown[];
    };
};
interface ResourceSchema {
    safeParse(data: unknown): SafeParseResultish;
}
type Entity = {
    id: string;
} & Record<string, unknown>;
interface Collection<T extends {
    id: string;
}> {
    list(): T[];
    get(id: string): T | undefined;
    create(data: Record<string, unknown>): T;
    update(id: string, patch: Record<string, unknown>): T | undefined;
    delete(id: string): boolean;
    deleteWhere(pred: (entity: T) => boolean): number;
    __allocateId(): string;
}
interface FailShape {
    status: number;
    body?: unknown;
    headers?: Record<string, string>;
}
interface MockStateMethods {
    failNext(opKey: string, n: number, shape: FailShape): void;
    failNext(n: number, shape: FailShape): void;
    consumeFailure(opKey: string): Response | undefined;
    withSeed(patch: Record<string, unknown[]>): MockState;
    resetState(): void;
    __ensureCollection(name: string): void;
    __baseline: Record<string, unknown[]>;
    __counters: Record<string, number>;
}
type MockState = Record<string, Collection<Entity>> & MockStateMethods;
interface Scheduler {
    after(ms: number, fn: (ctx: MockContext) => void | Promise<void>): () => void;
    afterReads(resource: string, n: number, fn: (ctx: MockContext) => void | Promise<void>): () => void;
    countRead(resource: string): void;
    cancelAll(): void;
}
interface MockContext {
    state: MockState;
    schedule: Scheduler;
    gateways: GatewayRegistry;
}
type MockEnv = {
    Variables: {
        mock: MockContext;
    };
};
interface Connection {
    readonly id: string;
    get<T>(key: string): T | undefined;
    set(key: string, value: unknown): void;
    send(data: string | ArrayBuffer): void;
    close(code?: number, reason?: string): void;
}
interface GatewayHandle {
    broadcast(payload: string | ArrayBuffer, filter?: (conn: Connection) => boolean): void;
    readonly size: number;
    readonly droppedCount: number;
}
type GatewayRegistry = Record<string, GatewayHandle>;
interface GatewayCtx {
    conn: Connection;
    state: MockState;
    schedule: Scheduler;
    gateways: GatewayRegistry;
}
interface GatewayDef {
    path: string;
    onOpen?: (ctx: GatewayCtx) => void | Promise<void>;
    onMessage?: (ctx: GatewayCtx & {
        msg: string | ArrayBuffer;
    }) => void | Promise<void>;
    onClose?: (ctx: GatewayCtx & {
        code?: number;
        reason?: string;
    }) => void | Promise<void>;
}
interface CrudHelpers {
    crud(): Record<string, Handler<MockEnv>>;
}
type SideEffectFn = (ctx: MockContext & {
    entity: Entity;
}) => void | Promise<void>;
interface ResourceDef {
    schema: ResourceSchema;
    operations?: (r: CrudHelpers, ctx: {
        gateways: GatewayRegistry;
    }) => Record<string, Handler<MockEnv>>;
    sideEffects?: Record<string, SideEffectFn>;
}
interface ServiceDefinition {
    name: string;
    seed?: Record<string, unknown[]>;
    auth?: MiddlewareHandler;
    resources?: Record<string, ResourceDef>;
    gateways?: Record<string, GatewayDef>;
    extraRoutes?: (app: Hono<MockEnv>) => void;
}
interface Service {
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
interface StartedService {
    port: number;
    url: string;
    close(): void;
}
interface StartedMock {
    baseUrl(): string;
    wsUrl(path?: string): string;
    reset(): Promise<void>;
    stop(): Promise<void>;
}

declare class MicromockContainer {
    readonly serviceFile: string;
    private seedPatch;
    constructor(serviceFile: string);
    withSeed(patch: Record<string, unknown[]>): this;
    start(): Promise<StartedMock>;
}

declare function buildImage(serviceFile: string): Promise<{
    tag: string;
    cached: boolean;
}>;

declare function collection(state: MockState, name: string): Collection<Entity>;
declare function resource(def: {
    schema: ResourceSchema;
    operations?: ResourceDef["operations"];
    sideEffects?: Record<string, SideEffectFn>;
}): ResourceDef;

declare function isMainModule(metaUrl: string): boolean;

declare function gateway(def: GatewayDef): GatewayDef;
declare function defineService(def: ServiceDefinition): Service;

export { MicromockContainer, apiKeyAuth, basicAuth, bearerAuth, buildImage, collection, customAuth, defineService, gateway, isMainModule, resource };
export type { BasicAuthOptions, Collection, Connection, CrudHelpers, Entity, FailShape, GatewayCtx, GatewayDef, GatewayHandle, GatewayRegistry, MockContext, MockEnv, MockState, ResourceDef, ResourceSchema, Scheduler, Service, ServiceDefinition, SideEffectFn, StartedMock, StartedService };
