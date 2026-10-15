import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import type { RawData } from "ws";
import { WebSocketServer } from "ws";
import { DEFAULT_PORT, ENV_PORT } from "@/constants.ts";
import type { ManagedConnection, ManagedGateway } from "@/gateway.ts";
import { runGatewayHandler } from "@/gateway.ts";
import type { Service, StartedService } from "@/types.ts";

export function isMainModule(metaUrl: string): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return pathToFileURL(entry).href === metaUrl;
}

export function startService(service: Service, port?: number): StartedService {
  const requested = port ?? Number(process.env[ENV_PORT] ?? DEFAULT_PORT);
  if (!Number.isInteger(requested) || requested < 0 || requested > 65535) {
    throw new Error(`micromock: bad port ${requested}`);
  }
  const gateways = Object.values(
    service.gateways as unknown as Record<string, ManagedGateway>,
  ).filter((gw) => typeof gw.open === "function");
  const byPath = new Map<string, ManagedGateway>();
  for (const gw of gateways) byPath.set(gw.def.path, gw);
  const wss = new WebSocketServer({ noServer: true });
  const server = serve({ fetch: service.honoApp.fetch, port: requested });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const gw = byPath.get(url.pathname);
    if (gw === undefined) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const conn: ManagedConnection = gw.open({
        send: (data: string | ArrayBuffer) => ws.send(data),
        close: (code?: number, reason?: string) => ws.close(code, reason),
        tag: ws,
      });
      const ctx = {
        state: service.state,
        schedule: service.schedule,
        gateways: service.gateways,
      };
      runGatewayHandler(conn, () => gw.def.onOpen?.({ ...ctx, conn }));
      ws.on("message", (raw: RawData, isBinary: boolean) => {
        if (conn.closed) return;
        const msg = toMessage(raw, isBinary);
        runGatewayHandler(conn, () =>
          gw.def.onMessage?.({ ...ctx, conn, msg }),
        );
      });
      ws.on("close", (code: number, reason: Buffer) => {
        gw.remove(conn);
        runGatewayHandler(conn, () =>
          gw.def.onClose?.({
            ...ctx,
            conn,
            code,
            reason: reason.toString(),
          }),
        );
      });
    });
  });
  const address = server.address();
  const bound =
    typeof address === "object" && address !== null ? address.port : requested;
  return {
    port: bound,
    url: `http://localhost:${bound}`,
    close: () => server.close(),
  };
}

function toMessage(raw: RawData, isBinary: boolean): string | ArrayBuffer {
  if (raw instanceof ArrayBuffer)
    return isBinary ? raw.slice(0) : Buffer.from(raw).toString();
  const buf = Array.isArray(raw) ? Buffer.concat(raw) : raw;
  if (!isBinary) return buf.toString();
  const copy = new Uint8Array(buf.byteLength);
  copy.set(buf);
  return copy.buffer;
}
