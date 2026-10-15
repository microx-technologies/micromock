import { z } from "zod";
import { ERR_INVALID_JSON } from "@/constants.ts";
import { collection, readJsonBody, resource } from "@/resource.ts";
import { defineService, gateway, isMainModule } from "@/service.ts";

const Message = z.object({
  id: z.string(),
  channelId: z.string(),
  text: z.string(),
});

const realtime = defineService({
  name: "realtime-lite",
  resources: {
    messages: resource({
      schema: Message,
      operations: (r) => ({
        ...r.crud(),
        "POST /channels/:id/messages": async (c) => {
          const { state } = c.get("mock");
          const socket = c.get("mock").gateways.socket;
          if (socket === undefined)
            throw new Error("micromock: unknown gateway socket");
          const parsed = await readJsonBody(c);
          if (!parsed.ok) return parsed.response;
          const body = parsed.body;
          if (
            typeof body !== "object" ||
            body === null ||
            Array.isArray(body)
          ) {
            return c.json({ error: ERR_INVALID_JSON }, 400);
          }
          const msg = collection(state, "messages").create({
            channelId: c.req.param("id"),
            ...body,
          });
          socket.broadcast(
            JSON.stringify({ type: "message_create", data: msg }),
            (conn) =>
              (conn.get<string[]>("topics") ?? []).includes(
                `channel:${msg.channelId}`,
              ),
          );
          return c.json(msg, 201);
        },
      }),
    }),
  },
  gateways: {
    socket: gateway({
      path: "/socket",
      onOpen: ({ conn }) => {
        conn.set("authenticated", false);
      },
      onMessage: ({ conn, msg }) => {
        const frame = JSON.parse(String(msg)) as {
          type?: string;
          token?: string;
          topics?: string[];
        };
        if (frame.type === "auth") {
          if (frame.token !== "test-token")
            return conn.close(4004, "auth failed");
          conn.set("authenticated", true);
          conn.set("topics", frame.topics ?? []);
          return conn.send(
            JSON.stringify({ type: "ready", sessionId: conn.id }),
          );
        }
      },
      onClose: () => {},
    }),
  },
  extraRoutes: (app) => {
    app.post("/__test/dispatch", async (c) => {
      const socket = c.get("mock").gateways.socket;
      if (socket === undefined)
        throw new Error("micromock: unknown gateway socket");
      const payload = await c.req.json();
      socket.broadcast(JSON.stringify(payload.event), () => true);
      return c.json({ ok: true });
    });
  },
});

export default realtime;

if (isMainModule(import.meta.url)) {
  realtime.start();
}
