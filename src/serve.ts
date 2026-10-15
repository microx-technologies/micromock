import { websocket } from "@hono/bun";
import { DEFAULT_PORT, ENV_PORT } from "@/src/constants.ts";
import type { Service, StartedService } from "@/src/types.ts";

export { websocket };

export function startService(service: Service, port?: number): StartedService {
  const requested = port ?? Number(process.env[ENV_PORT] ?? DEFAULT_PORT);
  if (!Number.isInteger(requested) || requested < 0 || requested > 65535) {
    throw new Error(`micromock: bad port ${requested}`);
  }
  const server = Bun.serve({
    port: requested,
    fetch: (req, server) => service.app.fetch(req, { server }),
    websocket,
  });
  if (server.port === undefined) {
    server.stop(true);
    throw new Error("micromock: Bun.serve did not bind a port");
  }
  return {
    port: server.port,
    url: `http://localhost:${server.port}`,
    close: () => server.stop(true),
  };
}
