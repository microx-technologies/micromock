import rt from "@mocks/realtime-lite.ts";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import WebSocket from "ws";

let baseUrl = "";
let stop = () => {};

beforeAll(() => {
  const srv = rt.start(0);
  baseUrl = srv.url;
  stop = () => srv.close();
});

afterAll(() => {
  stop();
  rt.reset();
});

const queues = new WeakMap<WebSocket, string[]>();
const waiters = new WeakMap<WebSocket, Array<(msg: string) => void>>();

function listen(ws: WebSocket): void {
  if (queues.has(ws)) return;
  queues.set(ws, []);
  waiters.set(ws, []);
  ws.on("message", (data) => {
    const msg = String(data);
    const pending = waiters.get(ws);
    const next = pending?.shift();
    if (next !== undefined) next(msg);
    else queues.get(ws)?.push(msg);
  });
  ws.on("error", (err) => {
    const pending = waiters.get(ws);
    const next = pending?.shift();
    if (next !== undefined) next(`__error__:${String(err)}`);
  });
}

async function nextMessage(ws: WebSocket): Promise<string> {
  listen(ws);
  const queue = queues.get(ws) as string[];
  const shifted = queue.shift();
  if (shifted !== undefined) return shifted;
  const { promise, resolve } = Promise.withResolvers<string>();
  (waiters.get(ws) as Array<(msg: string) => void>).push(resolve);
  return promise;
}

function openSocket(): Promise<WebSocket> {
  const ws = new WebSocket(`${baseUrl.replace(/^http/, "ws")}/socket`);
  listen(ws);
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

describe("realtime-lite gateway compat", () => {
  test("REST write fans out to subscribed gateway client", async () => {
    const ws = await openSocket();
    try {
      ws.send(
        JSON.stringify({
          type: "auth",
          token: "test-token",
          topics: ["channel:general"],
        }),
      );
      const ready = JSON.parse(await nextMessage(ws)) as {
        type: string;
        sessionId: string;
      };
      expect(ready.type).toBe("ready");
      expect(ready.sessionId.startsWith("conn_")).toBe(true);

      const created = await (
        await fetch(`${baseUrl}/channels/general/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "hi" }),
        })
      ).json();
      expect(created).toMatchObject({ channelId: "general", text: "hi" });

      const event = JSON.parse(await nextMessage(ws)) as {
        type: string;
        data: { text: string };
      };
      expect(event.type).toBe("message_create");
      expect(event.data.text).toBe("hi");
    } finally {
      ws.close();
    }
  });

  test("bad token closes with 4004", async () => {
    const ws = await openSocket();
    const closed = Promise.withResolvers<[number, string]>();
    ws.once("close", (code, reason) => closed.resolve([code, String(reason)]));
    ws.send(JSON.stringify({ type: "auth", token: "nope" }));
    expect(await closed.promise).toEqual([4004, "auth failed"]);
  });
});
