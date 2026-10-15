import {
  CONN_PREFIX,
  WS_HANDLER_ERROR_CODE,
  WS_HANDLER_ERROR_REASON,
  WS_RESET_CODE,
  WS_RESET_REASON,
} from "@/src/constants.ts";
import type {
  Connection,
  GatewayDef,
  GatewayHandle,
  GatewayRegistry,
} from "@/src/types.ts";

export interface RawSocket {
  send(data: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  tag?: unknown;
}

export class ManagedConnection implements Connection {
  readonly id: string;
  readonly store = new Map<string, unknown>();
  raw: RawSocket | undefined;
  closed = false;

  constructor(
    id: string,
    readonly gateway: ManagedGateway,
    raw?: RawSocket,
  ) {
    this.id = id;
    this.raw = raw;
  }

  get<T>(key: string): T | undefined {
    return this.store.get(key) as T | undefined;
  }

  set(key: string, value: unknown): void {
    this.store.set(key, value);
  }

  send(data: string | ArrayBuffer): void {
    if (this.closed || this.raw === undefined) {
      this.gateway.countDrop();
      return;
    }
    try {
      this.raw.send(data);
    } catch {
      this.gateway.countDrop();
    }
  }

  close(code: number = 1000, reason: string = ""): void {
    if (!Number.isInteger(code) || code < 1000 || code > 4999) {
      throw new Error(`micromock: close code must be 1000-4999, got ${code}`);
    }
    this.closed = true;
    this.raw?.close(code, reason);
    this.gateway.remove(this);
  }
}

export class ManagedGateway implements GatewayHandle {
  readonly conns = new Map<string, ManagedConnection>();
  readonly def: GatewayDef;
  counter = 1;
  drops = 0;

  constructor(
    readonly name: string,
    def: GatewayDef,
  ) {
    if (!def.path.startsWith("/")) {
      throw new Error(`micromock: gateway "${name}" path must start with "/"`);
    }
    this.def = def;
  }

  get size(): number {
    return this.conns.size;
  }

  get droppedCount(): number {
    return this.drops;
  }

  countDrop(): void {
    this.drops++;
  }

  remove(conn: ManagedConnection): void {
    this.conns.delete(conn.id);
  }

  byId(id: string): ManagedConnection | undefined {
    return this.conns.get(id);
  }

  byRaw(raw: unknown): ManagedConnection | undefined {
    if (raw === undefined) return undefined;
    for (const conn of this.conns.values()) {
      if (conn.raw?.tag === raw) return conn;
    }
    return undefined;
  }
  open(raw?: RawSocket): ManagedConnection {
    const conn = new ManagedConnection(
      `${CONN_PREFIX}${this.counter++}`,
      this,
      raw,
    );
    this.conns.set(conn.id, conn);
    return conn;
  }

  broadcast(
    payload: string | ArrayBuffer,
    filter?: (conn: Connection) => boolean,
  ): void {
    for (const conn of [...this.conns.values()]) {
      if (filter !== undefined && !filter(conn)) continue;
      conn.send(payload);
    }
  }

  reset(reason: string = WS_RESET_REASON, code: number = WS_RESET_CODE): void {
    for (const conn of [...this.conns.values()]) {
      conn.closed = true;
      try {
        conn.raw?.close(code, reason);
      } catch {
        this.drops++;
      }
    }
    this.conns.clear();
    this.drops = 0;
    this.counter = 1;
  }
}

export class GatewayRuntime {
  readonly gateways: Record<string, ManagedGateway> = {};

  constructor(defs: Record<string, GatewayDef> = {}) {
    for (const [name, def] of Object.entries(defs)) {
      this.gateways[name] = new ManagedGateway(name, def);
    }
  }

  registry(): GatewayRegistry {
    return this.gateways as unknown as GatewayRegistry;
  }

  gateway(name: string): ManagedGateway {
    const gateway = this.gateways[name];
    if (gateway === undefined) {
      throw new Error(`micromock: unknown gateway "${name}"`);
    }
    return gateway;
  }

  resetAll(): void {
    for (const gateway of Object.values(this.gateways)) gateway.reset();
  }
}

function handlerError(conn: ManagedConnection): void {
  try {
    conn.close(WS_HANDLER_ERROR_CODE, WS_HANDLER_ERROR_REASON);
  } catch {
  }
}

export function runGatewayHandler(
  conn: ManagedConnection,
  invoke: () => void | Promise<void>,
): void {
  let result: void | Promise<void>;
  try {
    result = invoke();
  } catch {
    handlerError(conn);
    return;
  }
  if (result instanceof Promise) {
    result.catch(() => handlerError(conn));
  }
}
